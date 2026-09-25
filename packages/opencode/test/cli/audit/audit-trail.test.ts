// XCOD-103: the audit trail end to end, through the real CLI and a fake LLM: a session that runs
// bash and is refused one permission, a marketplace install, a locked-share refusal, forwarding to
// a real local syslog listener, verify before and after tampering, and CSV export.
import { describe, expect } from "bun:test"
import dgram from "dgram"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

const PROMPT = "PROMPT-TEXT-MUST-NOT-BE-LOGGED"
const OUTPUT = "MODEL-OUTPUT-MUST-NOT-BE-LOGGED"

describe("audit trail (subprocess)", () => {
  cliIt.live(
    "records the session's events in order, without prompt or output, forwards every line, and verify catches tampering",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const log = path.join(home, "audit", "audit.log")
        const received: string[] = []
        const listener = dgram.createSocket("udp4")
        listener.on("message", (message) => received.push(message.toString()))
        const port = yield* Effect.promise(
          () => new Promise<number>((resolve) => listener.bind(0, "127.0.0.1", () => resolve(listener.address().port))),
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => listener.close()))

        const managed = path.join(home, "managed")
        const manifest = path.join(home, "mp.json")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true })
          await fs.writeFile(
            path.join(home, ".config", "opencode", "opencode.json"),
            JSON.stringify({
              audit: { enabled: true, path: log, forward: { syslog: `udp://127.0.0.1:${port}` } },
              marketplace_default: false,
              permission: { "*": "allow", bash: { "*": "allow", "rm *": "deny" } },
            }),
          )
          await fs.mkdir(managed, { recursive: true })
          await fs.writeFile(
            path.join(managed, "managed.json"),
            JSON.stringify({ $locked: ["share"], share: "disabled" }),
          )
          await fs.writeFile(
            manifest,
            JSON.stringify({
              name: "mp",
              owner: { name: "mp" },
              plugins: [],
              mcp: [{ name: "srv", type: "remote", url: "https://example.test/mcp" }],
            }),
          )
        })
        const env = { OPENCODE_TEST_MANAGED_CONFIG_DIR: managed }

        // 1. A session: runs bash, is refused one permission (`rm *` denied by rule), answers.
        yield* llm.push(reply().tool("bash", { command: "echo audited", description: "echo" }))
        yield* llm.push(reply().tool("bash", { command: "rm -rf ./nothing", description: "remove" }))
        yield* llm.text(OUTPUT)
        const run = yield* opencode.run(PROMPT, { extraArgs: ["--share"], env })
        expect(run.stdout + run.stderr).toContain("share is set by your organisation's policy")

        // 2. A marketplace install.
        opencode.expectExit(yield* opencode.spawn(["marketplace", "add", manifest], { env }), 0, "add")
        opencode.expectExit(
          yield* opencode.spawn(["marketplace", "install", "srv", "--yes"], { env }),
          0,
          "marketplace install",
        )

        const text = yield* Effect.promise(() => fs.readFile(log, "utf8"))
        const events = text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        const names = events.map((event) => event.event)
        const order = (name: string, match: (event: any) => boolean = () => true) =>
          events.findIndex((event) => event.event === name && match(event))

        expect(order("model.call")).toBeGreaterThanOrEqual(0)
        expect(order("tool.run", (e) => e.tool === "bash" && e.command === "echo audited")).toBeGreaterThan(
          order("model.call"),
        )
        expect(
          order("permission.decision", (e) => e.permission === "bash" && e.decision === "denied by rule"),
        ).toBeGreaterThan(order("tool.run", (e) => e.tool === "bash"))
        expect(order("policy.override_refused", (e) => e.key === "share")).toBeGreaterThanOrEqual(0)
        expect(order("marketplace.install", (e) => e.name === "srv")).toBeGreaterThan(
          order("permission.decision", (e) => e.decision === "denied by rule"),
        )
        expect(names.every((name) => typeof name === "string")).toBe(true)

        // Privacy: no prompt, no model output, no file contents.
        expect(text).not.toContain(PROMPT)
        expect(text).not.toContain(OUTPUT)

        // Forwarding: every line reached the local syslog listener, verbatim.
        yield* Effect.sleep("300 millis")
        const lines = text.split("\n").filter(Boolean)
        for (const line of lines) expect(received.some((message) => message.endsWith(" " + line))).toBe(true)
        expect(received[0]).toMatch(/^<110>1 /)

        // verify: OK untouched, FAILED after editing a middle line.
        const ok = yield* opencode.spawn(["audit", "verify", "--file", log])
        opencode.expectExit(ok, 0, "audit verify")
        expect(ok.stdout).toContain(`Audit log OK: ${lines.length} lines`)
        const middle = Math.floor(lines.length / 2)
        yield* Effect.promise(() =>
          fs.writeFile(
            log,
            lines.map((line, i) => (i === middle ? line.replace('"event"', '"event" ') : line)).join("\n") + "\n",
          ),
        )
        const bad = yield* opencode.spawn(["audit", "verify", "--file", log])
        expect(bad.exitCode).not.toBe(0)
        expect(bad.stdout + bad.stderr).toContain(`line ${middle + 2}`)

        // CSV: one header, one row per line, formula-safe.
        const csv = yield* opencode.spawn(["audit", "export", "--file", log, "--format", "csv"])
        opencode.expectExit(csv, 0, "audit export csv")
        const rows = csv.stdout.trim().split(/\r?\n/)
        expect(rows[0].startsWith("timestamp,event,seq")).toBe(true)
        expect(rows.length).toBe(lines.length + 1)
      }),
    120_000,
  )

  cliIt.live(
    "forwarding to a host the residency policy denies is refused, and the refusal is audited",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const log = path.join(home, "audit", "audit.log")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(home, ".config", "opencode"), { recursive: true })
          await fs.writeFile(
            path.join(home, ".config", "opencode", "opencode.json"),
            JSON.stringify({
              residency: { allow: ["eu"] },
              audit: { path: log, forward: { syslog: "udp://siem.example.test:514" } },
            }),
          )
        })
        opencode.expectExit(yield* opencode.spawn(["debug", "config"]), 0, "debug config")
        const events = (yield* Effect.promise(() => fs.readFile(log, "utf8")))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "audit.forward_refused",
            via: "syslog",
            host: "siem.example.test:514",
            allowed: false,
          }),
        )
      }),
    60_000,
  )
})
