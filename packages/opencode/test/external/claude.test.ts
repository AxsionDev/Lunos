import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ExternalClaude } from "../../src/external/claude"

const FAKE = path.join(import.meta.dir, "fixtures", "fake-claude.ts")

async function run(ask: ExternalClaude.Options["ask"], extra: Partial<ExternalClaude.Options> = {}) {
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
    ...extra,
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

  // On Windows, npm's claude.cmd shim runs through a shell: nothing user-typed may reach the command line.
  test("only id-shaped values reach the command line", () => {
    expect(() => ExternalClaude.args({ resume: "abc & del *" })).toThrow(/session id/)
    expect(() => ExternalClaude.args({ permissionMode: "default; rm -rf" })).toThrow(/permission mode/)
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

describe("Claude Code's models (XCOD-254)", () => {
  test("listed from its answer to initialize, without a prompt", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-claude-"))
    process.env.FAKE_CLAUDE_LOG = path.join(dir, "host.log")
    const models = await ExternalClaude.models({ executable: FAKE, cwd: dir })
    delete process.env.FAKE_CLAUDE_LOG
    expect(models.map((model) => model.id)).toEqual(["default", "sonnet", "haiku"])
    expect(models[0]).toMatchObject({ name: "Default (recommended)", default: true })
    const sent = (await fs.readFile(path.join(dir, "host.log"), "utf8")).trim().split("\n")
    expect(sent.some((line) => line.includes('"type":"user"'))).toBe(false)
  })

  test("a release that doesn't list them gives none (the caller falls back to aliases)", async () => {
    process.env.FAKE_CLAUDE_MODELS = "none"
    const models = await ExternalClaude.models({ executable: FAKE, cwd: os.tmpdir() })
    delete process.env.FAKE_CLAUDE_MODELS
    expect(models).toEqual([])
    expect(await ExternalClaude.models({ executable: "/nonexistent/claude", cwd: os.tmpdir() })).toEqual([])
    expect(ExternalClaude.FALLBACK_MODELS.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku"])
  })

  test("other spellings of a model entry are read too; malformed ones are skipped", () => {
    expect(
      ExternalClaude.parseModels({ models: [{ id: "opus", display_name: "Opus" }, { displayName: "no id" }, "x"] }),
    ).toEqual([{ id: "opus", name: "Opus" }])
    expect(ExternalClaude.parseModels(undefined)).toEqual([])
  })

  test("the chosen model is passed with --model and the turn's init names it", async () => {
    const { events, sent } = await run(async () => ({ allow: true }), { model: "sonnet" })
    expect(sent[0].argv.join(" ")).toContain("--model sonnet")
    expect(events[0]).toMatchObject({ type: "init", model: "sonnet" })
    expect(() => ExternalClaude.args({ model: "sonnet; rm -rf" })).toThrow(/model name/)
  })
})

describe("Claude Code's own /commands", () => {
  const init = async (mode?: "init" | "both") => {
    if (mode) process.env.FAKE_CLAUDE_COMMANDS = mode
    try {
      const { events } = await run(async () => ({ allow: true }))
      return events.find((event) => event.type === "init")
    } finally {
      delete process.env.FAKE_CLAUDE_COMMANDS
    }
  }

  test("2.1.292 lists them in its answer to initialize, not on the init line", async () => {
    expect(await init()).toMatchObject({ type: "init", commands: ["compact", "review"] })
  })

  test("an older release that lists them on the init line still has them", async () => {
    expect(await init("init")).toMatchObject({ type: "init", commands: ["compact", "review"] })
  })

  test("listed in both places, they are merged without repeats", async () => {
    expect(await init("both")).toMatchObject({ type: "init", commands: ["compact", "review", "context"] })
  })

  test("only named entries of an initialize response are read", () => {
    expect(
      ExternalClaude.parseCommands({ commands: [{ name: "compact", builtin: true }, { description: "x" }, "y"] }),
    ).toEqual(["compact"])
    expect(ExternalClaude.parseCommands(undefined)).toEqual([])
  })
})
