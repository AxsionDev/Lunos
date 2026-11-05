// XCOD-338: `lunos run --remote`. The pure policy (which flags it can't be used with, the run's rules,
// what an approval does), then the real CLI against a fake Lunos Cloud relay: the approval a run
// would refuse waits, is answered from the "phone", the tool runs, and the link is closed at the end.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"
import { RunRemote } from "@/cli/cmd/run/remote"

describe("RunRemote policy (XCOD-338)", () => {
  test("--remote can't be used with --mini, --cloud or --sandbox; anything goes without it", () => {
    expect(RunRemote.conflict({ remote: true })).toBeUndefined()
    expect(RunRemote.conflict({ remote: true, mini: true })).toContain("--mini")
    expect(RunRemote.conflict({ remote: true, cloud: true })).toContain("--cloud")
    expect(RunRemote.conflict({ remote: true, sandbox: true })).toContain("--sandbox")
    expect(RunRemote.conflict({ mini: true, cloud: true, sandbox: true })).toBeUndefined()
  })

  test("questions are allowed only with --remote; plan mode stays denied either way", () => {
    const denied = (remote: boolean) => RunRemote.rules(remote).map((r) => `${r.permission}:${r.action}`)
    expect(denied(false)).toEqual(["question:deny", "plan_enter:deny", "plan_exit:deny"])
    expect(denied(true)).toEqual(["plan_enter:deny", "plan_exit:deny"])
  })

  test("an approval: --auto approves (never a manual one), --remote waits, otherwise refused", () => {
    expect(RunRemote.onAsk({ auto: true, remote: false, manual: false })).toBe("approve")
    expect(RunRemote.onAsk({ auto: true, remote: true, manual: false })).toBe("approve")
    expect(RunRemote.onAsk({ auto: true, remote: true, manual: true })).toBe("wait")
    expect(RunRemote.onAsk({ auto: true, remote: false, manual: true })).toBe("reject")
    expect(RunRemote.onAsk({ auto: false, remote: true, manual: false })).toBe("wait")
    expect(RunRemote.onAsk({ auto: false, remote: false, manual: false })).toBe("reject")
  })
})

function fakeRelay() {
  const events: Array<{ type: string; data: any }> = []
  const commands: unknown[] = []
  const calls: string[] = []
  let answered = false
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      calls.push(`${req.method} ${url.pathname}`)
      if (url.pathname === "/v1/remote/links" && req.method === "POST") {
        const body = (await req.json()) as any
        return Response.json(
          {
            id: "rl_run",
            host: "c".repeat(64),
            session: body.session,
            device: body.device,
            createdAt: Date.now(),
            expiresAt: Date.now() + 3_600_000,
          },
          { status: 201 },
        )
      }
      if (url.pathname.endsWith("/events")) {
        const batch = ((await req.json()) as any).events as Array<{ type: string; data: any }>
        events.push(...batch)
        // The "phone" approves the first approval it sees.
        const ask = batch.find((e) => e.type === "permission.asked")
        if (ask && !answered) {
          answered = true
          commands.push({ id: "cmd_ok", at: Date.now(), type: "permission", requestID: ask.data.id, reply: "once" })
        }
        return Response.json({ seq: events.length })
      }
      if (url.pathname.endsWith("/commands")) {
        for (let i = 0; i < 20 && !commands.length; i++) await Bun.sleep(25)
        return Response.json({ commands: commands.splice(0) })
      }
      return Response.json({ ended: true })
    },
  })
  return { url: server.url.origin, events, calls, stop: () => server.stop(true) }
}

const register = (home: string, endpoint: string) =>
  Effect.promise(async () => {
    const dir = path.join(home, ".local", "share", "opencode", "cloud", "sync")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "device.json"),
      JSON.stringify({
        endpoint,
        sub: "ada",
        noticeShown: true,
        device: { id: "dev_run", name: "ci", platform: process.platform, syncEnabled: true, createdAt: 1 },
      }),
    )
  })

describe("lunos run --remote (subprocess)", () => {
  cliIt.live(
    "an approval waits for the web, is answered there, the tool runs, and the link is closed at the end",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const relay = fakeRelay()
        yield* Effect.addFinalizer(() => Effect.sync(() => relay.stop()))
        yield* register(home, relay.url)
        yield* llm.push(reply().tool("bash", { command: "printf remote-ok", description: "Print" }))
        yield* llm.text("done")
        const result = yield* opencode.run("use a tool", {
          format: "json",
          permission: { bash: "ask" },
          extraArgs: ["--remote"],
          env: { LUNOS_TOKEN: "t", LUNOS_CLOUD_STORE: "file" },
          timeoutMs: 60_000,
        })
        opencode.expectExit(result, 0, "run --remote")
        const out = opencode.parseJsonEvents(result.stdout)
        expect(out.find((e) => e.type === "remote")).toMatchObject({ url: "https://app.lunos.tech/remote/rl_run" })
        expect(out.find((e) => e.type === "permission_waiting")).toMatchObject({ permission: "bash" })
        expect(out.some((e) => e.type === "permission_rejected")).toBe(false)
        const tool = out.find((e) => e.type === "tool_use") as any
        expect(tool?.part?.state?.status).toBe("completed")
        expect(tool?.part?.state?.output).toContain("remote-ok")
        expect(relay.events.some((e) => e.type === "permission.asked" && e.data.permission === "bash")).toBe(true)
        expect(relay.events.find((e) => e.type === "command.result")?.data).toMatchObject({ ok: true })
        // Turned off when the run ended, not left for the relay to time out.
        expect(relay.calls).toContain("DELETE /v1/remote/links/rl_run")
      }),
    120_000,
  )

  cliIt.live(
    "refused (signed out): says why and exits 1 before the prompt is sent",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.text("should not be sent")
        const result = yield* opencode.run("hi", {
          extraArgs: ["--remote"],
          env: { LUNOS_CLOUD_STORE: "file", LUNOS_TOKEN: "" },
        })
        opencode.expectExit(result, 1, "run --remote signed out")
        expect(result.stderr).toContain("Sign in to Lunos first")
        expect(result.stdout).not.toContain("should not be sent")
      }),
    90_000,
  )
})
