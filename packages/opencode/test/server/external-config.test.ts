import { afterEach, beforeEach, describe, expect } from "bun:test"
import { createHash } from "crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// XCOD-285 §4, through the server: GET /experimental/external/config/:tool and its command endpoint,
// against the fake tools with a throwaway HOME. Under a residency policy that refuses the vendor
// nothing is started; `run: false` only names the command and the file; `run: true` changes exactly
// that file, through the tool's own command, and is audited as external.config.

const it = testEffect(Layer.mergeAll(httpApiLayer))
const FAKE_CLAUDE = path.join(import.meta.dir, "..", "external", "fixtures", "fake-claude.ts")
const FAKE_CODEX = path.join(import.meta.dir, "..", "external", "fixtures", "fake-codex.ts")
const root = mkdtempSync(path.join(os.tmpdir(), "lunos-external-config-"))
const home = path.join(root, "home")
const log = path.join(root, "fake-claude.jsonl")
const audit = path.join(root, "audit.jsonl")
const tools = { claude: { path: FAKE_CLAUDE }, codex: { path: FAKE_CODEX } }

/** ~/.claude, ~/.claude.json and ~/.codex (the Lunos server itself may use other folders under HOME, e.g. ~/.npm). */
function snapshot(dir: string) {
  const out: Record<string, string> = {}
  const add = (full: string) =>
    (out[path.relative(dir, full)] = createHash("sha256").update(readFileSync(full)).digest("hex"))
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else add(full)
    }
  }
  walk(path.join(dir, ".claude"))
  walk(path.join(dir, ".codex"))
  if (existsSync(path.join(dir, ".claude.json"))) add(path.join(dir, ".claude.json"))
  return out
}

const saved = {
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
}
beforeEach(() => {
  mkdirSync(path.join(home, ".claude"), { recursive: true })
  mkdirSync(path.join(home, ".codex"), { recursive: true })
  writeFileSync(path.join(home, ".claude", "settings.json"), '{"model":"opus"}\n')
  writeFileSync(path.join(home, ".claude.json"), "{}\n")
  writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "gpt-5.5"\n')
  Object.assign(process.env, { HOME: home, CODEX_HOME: path.join(home, ".codex"), FAKE_CLAUDE_LOG: log })
})
afterEach(async () => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  await disposeAllInstances()
})

const fakeArgv = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .flatMap((line) => (JSON.parse(line).argv ? [JSON.parse(line).argv as string[]] : []))
    : []

describe("external config routes", () => {
  it.instance(
    "a residency policy that refuses the vendor: the reason, and the tool isn't started",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const before = fakeArgv().length
        const res = yield* requestInDirectory("/experimental/external/config/claude", test.directory)
        expect(res.status).toBe(200)
        const body = (yield* res.json) as { error?: string; sections: unknown[] }
        expect(body.error).toContain("residency")
        expect(body.sections).toEqual([])
        expect(fakeArgv().length).toBe(before)
        const command = yield* requestInDirectory("/experimental/external/config/claude/command", test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "mcp.add", name: "docs", scope: "user", target: "npx docs", run: true }),
        })
        expect(command.status).toBe(400)
        expect(fakeArgv().length).toBe(before)
      }),
    { config: { external: tools, residency: { allow: ["eu"] } } as any },
  )

  it.instance(
    "reading, and showing a command, change nothing; a confirmed command changes only its file and is audited",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const before = snapshot(home)
        const read = yield* requestInDirectory("/experimental/external/config/claude", test.directory)
        const view = (yield* read.json) as { error?: string; sections: { id: string; add?: { scopes: string[] } }[] }
        expect(view.error).toBeUndefined()
        expect(view.sections.find((section) => section.id === "mcp")?.add?.scopes).toEqual(["local", "user", "project"])
        expect(fakeArgv().some((argv) => argv.includes("--no-session-persistence"))).toBe(true)
        expect(snapshot(home)).toEqual(before)

        const change = { action: "mcp.add", name: "docs", scope: "user", target: "npx -y docs-mcp" }
        const shown = yield* requestInDirectory("/experimental/external/config/claude/command", test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...change, run: false }),
        })
        expect(shown.status).toBe(200)
        expect(yield* shown.json).toEqual({
          command: "claude mcp add -s user docs -- npx -y docs-mcp",
          file: path.join(home, ".claude.json"),
          ran: false,
        })
        // Only its --help was asked (for the scopes); the add itself never ran.
        expect(fakeArgv().some((argv) => argv[0] === "mcp" && argv[1] === "add" && !argv.includes("--help"))).toBe(
          false,
        )
        expect(snapshot(home)).toEqual(before)
        expect(existsSync(audit) ? readFileSync(audit, "utf8") : "").not.toContain("external.config")

        const ran = yield* requestInDirectory("/experimental/external/config/claude/command", test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...change, run: true }),
        })
        const result = (yield* ran.json) as { ran: boolean; ok: boolean; output: string }
        expect(result).toMatchObject({ ran: true, ok: true })
        expect(result.output).toContain(`File modified: ${path.join(home, ".claude.json")}`)
        const after = snapshot(home)
        const changed = Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key])
        expect(changed).toEqual([".claude.json"])
        // The audit line is written asynchronously.
        for (let i = 0; i < 50 && !(existsSync(audit) && statSync(audit).size); i++) yield* Effect.sleep(20)
        const line = readFileSync(audit, "utf8")
          .trim()
          .split("\n")
          .map((text) => JSON.parse(text))
          .find((entry) => JSON.stringify(entry).includes("external.config"))
        expect(JSON.stringify(line)).toContain('"mcp.add"')
        expect(JSON.stringify(line)).toContain(".claude.json")
      }),
    { config: { external: tools, audit: { enabled: true, path: audit } } as any },
  )

  it.instance(
    "Codex: the command changes the user config Codex reports; a bad name is refused before anything starts",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const shown = yield* requestInDirectory("/experimental/external/config/codex/command", test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "mcp.remove", name: "docs", run: false }),
        })
        expect(yield* shown.json).toEqual({
          command: "codex mcp remove docs",
          file: path.join(home, ".codex", "config.toml"),
          ran: false,
        })
        const bad = yield* requestInDirectory("/experimental/external/config/codex/command", test.directory, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "mcp.remove", name: "--all", run: true }),
        })
        expect(bad.status).toBe(400)
      }),
    { config: { external: tools } as any },
  )
})
