import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ExternalCodex } from "../../src/external/codex"
import { ExternalRun } from "../../src/external/run"

const FAKE = path.join(import.meta.dir, "fixtures", "fake-codex.ts")

async function run(ask: ExternalCodex.Options["ask"], extra: Partial<ExternalCodex.Options> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-codex-"))
  const log = path.join(dir, "host.log")
  process.env.FAKE_CODEX_LOG = log
  const events: ExternalCodex.Event[] = []
  const running = ExternalCodex.start({
    cwd: dir,
    prompt: "Create note.txt",
    executable: FAKE,
    ask,
    onEvent: (e) => events.push(e),
    ...extra,
  })
  const result = await running.done
  delete process.env.FAKE_CODEX_LOG
  const sent = (await fs.readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  return { dir, result, events, sent }
}

describe("ExternalCodex (XCOD-204)", () => {
  test("safe by default; approval-skipping settings need --unsafe; only known values", () => {
    expect(ExternalCodex.settings({})).toEqual({ sandbox: "read-only", approvalPolicy: "untrusted" })
    expect(() => ExternalCodex.settings({ sandbox: "danger-full-access" })).toThrow(/--unsafe/)
    expect(() => ExternalCodex.settings({ approvalPolicy: "never" })).toThrow(/--unsafe/)
    expect(ExternalCodex.settings({ sandbox: "danger-full-access", allowUnsafe: true }).sandbox).toBe(
      "danger-full-access",
    )
    expect(() => ExternalCodex.settings({ sandbox: "anything" })).toThrow(/isn't a Codex sandbox/)
  })

  test("each approval goes to Lunos and the answer back: decline, then accept; the result comes back", async () => {
    const asked: string[] = []
    const { dir, result, events, sent } = await run(async (request) => {
      asked.push(request.tool)
      return asked.length === 1 ? { allow: false, message: "no" } : { allow: true }
    })
    expect(asked).toEqual(["FileChange", "FileChange"])
    const decisions = sent.filter((m) => m.result?.decision).map((m) => m.result.decision)
    expect(decisions).toEqual(["decline", "accept"])
    const start = sent.find((m) => m.method === "thread/start")
    expect(start.params).toMatchObject({ sandbox: "read-only", approvalPolicy: "untrusted" })
    expect(sent.find((m) => m.method === "turn/start").params.input).toEqual([
      { type: "text", text: "Create note.txt" },
    ])
    expect(await fs.readFile(path.join(dir, "note.txt"), "utf8")).toBe("from codex")
    expect(result).toMatchObject({ type: "result", ok: true })
    if (result.type === "result") {
      expect(result.sessionID).toBe("01a116f2-5e88-79d3-afb9-db1da07c9fcd")
      expect(result.costUSD).toBeUndefined()
      expect(result.tokens).toBeGreaterThan(0)
      expect(result.denied.length).toBe(1)
      expect(result.text).toContain("note.txt")
      expect(ExternalRun.cost("codex", result)).toMatch(/tokens \(Codex CLI reports tokens, not money\)/)
    }
    expect(events.some((event) => event.type === "tool_result" && event.isError)).toBe(true)
  })

  test("resume continues the thread by id", async () => {
    const { sent } = await run(async () => ({ allow: true }), { resume: "01a116f2-5e88-79d3-afb9-db1da07c9fcd" })
    expect(sent.find((m) => m.method === "thread/resume").params.threadId).toBe("01a116f2-5e88-79d3-afb9-db1da07c9fcd")
    expect(sent.some((m) => m.method === "thread/start")).toBe(false)
    expect(() =>
      ExternalCodex.start({
        cwd: "/",
        prompt: "x",
        resume: "a; rm",
        executable: FAKE,
        ask: async () => ({ allow: true }),
      }),
    ).toThrow(/thread id/)
  })
})
