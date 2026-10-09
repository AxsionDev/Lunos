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

  test("Codex's own commands: /review and /compact go to their methods; others are refused before Codex starts", () => {
    const review = (prompt: string) => {
      const turn = ExternalCodex.command(prompt, false)
      return turn.method === "review/start" ? turn.params.target : turn.method
    }
    expect(review("/review")).toEqual({ type: "uncommittedChanges" })
    expect(review("/review base dev")).toEqual({ type: "baseBranch", branch: "dev" })
    expect(review("/review commit 1593d4e")).toEqual({ type: "commit", sha: "1593d4e" })
    expect(review("/review only the error handling")).toEqual({
      type: "custom",
      instructions: "only the error handling",
    })
    // Not commands: plain prompts, and a path that happens to start with "/".
    expect(review("Create note.txt")).toBe("turn/start")
    expect(review("/usr/bin/env is what?")).toBe("turn/start")
    expect(ExternalCodex.command("/compact", true).method).toBe("thread/compact/start")
    expect(() => ExternalCodex.command("/compact", false)).toThrow(/existing Codex session/)
    expect(() => ExternalCodex.command("/init", false)).toThrow(ExternalCodex.UnsupportedCommandError)
    expect(() => ExternalCodex.command("/init", false)).toThrow(/\/review, \/compact/)
    // Refused before anything is spawned.
    expect(() =>
      ExternalCodex.start({
        cwd: "/",
        prompt: "/init",
        executable: "/nonexistent",
        ask: async () => ({ allow: true }),
      }),
    ).toThrow(/can't run \/init/)
  })

  test("/review runs Codex's review and returns its findings", async () => {
    const { result, sent } = await run(async () => ({ allow: true }), { prompt: "/review base dev" })
    expect(sent.find((m) => m.method === "review/start").params).toMatchObject({
      target: { type: "baseBranch", branch: "dev" },
      delivery: "inline",
    })
    expect(sent.some((m) => m.method === "turn/start")).toBe(false)
    expect(result).toMatchObject({ type: "result", ok: true })
    if (result.type === "result") expect(result.text).toContain("Restore add to perform addition")
  })

  test("/compact on a resumed session compacts it and says so", async () => {
    const { result, sent } = await run(async () => ({ allow: true }), {
      prompt: "/compact",
      resume: "01a116f2-5e88-79d3-afb9-db1da07c9fcd",
    })
    expect(sent.find((m) => m.method === "thread/compact/start").params).toEqual({
      threadId: "01a116f2-5e88-79d3-afb9-db1da07c9fcd",
    })
    expect(result).toMatchObject({ type: "result", ok: true, text: "Codex compacted the session." })
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
