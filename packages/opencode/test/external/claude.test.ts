import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ExternalClaude } from "../../src/external/claude"

const FAKE = path.join(import.meta.dir, "fixtures", "fake-claude.ts")

async function run(ask: ExternalClaude.Options["ask"]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-claude-"))
  const log = path.join(dir, "host.log")
  process.env.FAKE_CLAUDE_LOG = log
  const events: ExternalClaude.Event[] = []
  const running = ExternalClaude.start({
    cwd: dir,
    prompt: "Create hello.txt containing hi",
    executable: FAKE,
    ask,
    onEvent: (e) => events.push(e),
  })
  const result = await running.done
  await new Promise((resolve) => running.child.once("close", resolve).once("exit", resolve))
  delete process.env.FAKE_CLAUDE_LOG
  const sent = (await fs.readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  return { result, events, sent }
}

describe("ExternalClaude (XCOD-204)", () => {
  test("starts in the safe mode with approvals routed to Lunos, and refuses an approval-skipping mode", () => {
    const args = ExternalClaude.args({})
    expect(args).toContain("--permission-prompt-tool")
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default")
    expect(() => ExternalClaude.args({ permissionMode: "bypassPermissions" })).toThrow(/--unsafe/)
    expect(ExternalClaude.args({ permissionMode: "bypassPermissions", allowUnsafe: true })).toContain(
      "bypassPermissions",
    )
    expect(ExternalClaude.args({ resume: "abc" }).join(" ")).toContain("--resume abc")
  })

  test("each approval is asked of Lunos and the answer goes back: deny, then allow", async () => {
    const asked: string[] = []
    let calls = 0
    const { result, events, sent } = await run(async (request) => {
      asked.push(`${request.tool}:${String(request.input.content)}`)
      return ++calls === 1 ? { allow: false, message: "not yet" } : { allow: true }
    })
    expect(asked).toEqual(["Write:hi", "Write:hi"])
    const replies = sent.filter((line) => line.type === "control_response").map((line) => line.response.response)
    expect(replies[0]).toEqual({ behavior: "deny", message: "not yet" })
    expect(replies[1].behavior).toBe("allow")
    expect(replies[1].updatedInput.content).toBe("hi")
    expect(sent.find((line) => line.type === "user").message.content).toBe("Create hello.txt containing hi")
    expect(result).toMatchObject({
      type: "result",
      ok: true,
      sessionID: "a6fd116c-92e4-4731-a522-99679ab93931",
      turns: 3,
    })
    if (result.type === "result") {
      expect(result.costUSD).toBeGreaterThan(0)
      expect(result.denied.length).toBe(1)
    }
    expect(events[0]).toMatchObject({ type: "init", sessionID: "a6fd116c-92e4-4731-a522-99679ab93931" })
    expect(events.some((event) => event.type === "tool" && event.name === "Write")).toBe(true)
    expect(events.some((event) => event.type === "tool_result" && event.isError)).toBe(true)
  })

  test("a missing executable is a clear error, not a crash", async () => {
    const running = ExternalClaude.start({
      cwd: os.tmpdir(),
      prompt: "x",
      executable: "/nonexistent/claude",
      ask: async () => ({ allow: true }),
    })
    const result = await running.done
    expect(result.type).toBe("error")
  })
})
