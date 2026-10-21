import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ExternalClaude } from "../../src/external/claude"
import { ExternalCodex } from "../../src/external/codex"
import { ExternalDetect } from "../../src/external/detect"
import { ExternalNative } from "../../src/external/native"
import { ExternalSession } from "../../src/external/session"
import { ConfigExternal } from "@opencode-ai/core/config/external"

// XCOD-285: Claude Code and Codex sessions answer approvals with the tool's own choices, Shift+Tab
// cycles Claude Code's permission mode, and a Lunos deny rule holds whatever the tool's mode allows.
// Everything here comes from what the tools report: the recorded fixtures (2.1.292 fake turns, a real
// 2.1.304 initialize + set_permission_mode probe, Codex 0.160.1's generated protocol schema) and the
// fake tools' --help, never a list kept from memory.

const FIXTURES = path.join(import.meta.dir, "..", "fixtures", "external")
const FAKE = path.join(import.meta.dir, "fixtures", "fake-claude.ts")
const lines = (file: string) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

/** The `can_use_tool` request the recorded 2.1.292 turn asks with, as the adapter parses it. */
function recordedApproval() {
  const tool = lines(path.join(FIXTURES, "fake-claude-2.1.292", "native-approval.1.jsonl"))
    .filter((entry) => entry.from === "tool")
    .map((entry) => JSON.stringify(entry.message))
  const parsed = tool.map((line) => ExternalClaude.parse(line)).find((item) => item.permission)
  return parsed!.permission!
}

describe("approval choices in the tool's own words (XCOD-285)", () => {
  test("Claude Code: Yes / don't ask again for what it suggests / No and tell Claude, from the recorded request", () => {
    const request = recordedApproval()
    expect(request.suggestions).toEqual([{ type: "setMode", mode: "acceptEdits", destination: "session" }])
    const choices = ExternalNative.choices("claude", request)
    expect(choices.map((item) => item.label)).toEqual([
      "Yes",
      "Yes, and don't ask again for edits in this session (accept edits mode)",
      "No, and tell Claude what to do differently",
    ])
    expect(choices.map((item) => item.reply)).toEqual(["once", "always", "reject"])
    expect(choices[2]!.feedback).toBe(true)
  })

  test("an older Claude Code that sends no suggestions doesn't get the don't-ask-again choice", () => {
    const { suggestions: _, ...request } = recordedApproval()
    expect(ExternalNative.choices("claude", request).map((item) => item.id)).toEqual(["yes", "no"])
  })

  test("a rule suggestion is named as Claude Code writes it, and remembered by Lunos as the same rule", () => {
    const suggestions = [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]
    const request = { requestID: "r", tool: "Bash", input: { command: "npm test -- a" }, suggestions }
    expect(ExternalNative.choices("claude", request)[1]!.label).toBe("Yes, and don't ask again for Bash(npm test:*)")
    expect(ExternalSession.patterns("claude", request)).toEqual({
      patterns: ["claude:Bash npm test -- a"],
      always: ["claude:Bash npm test*"],
    })
  })

  test("don't ask again tells Claude Code to apply its suggestions to this session only, never a settings file", () => {
    const request = {
      requestID: "r1",
      tool: "Bash",
      input: { command: "ls" },
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "ls" }],
          behavior: "allow",
          destination: "userSettings",
        },
        { type: "setMode", mode: "acceptEdits", destination: "projectSettings" },
      ],
    }
    const always = ExternalClaude.reply(request, { allow: true, always: true }).response.response as any
    expect(always.updatedPermissions.map((item: any) => item.destination)).toEqual(["session", "session"])
    const once = ExternalClaude.reply(request, { allow: true }).response.response as any
    expect(once.updatedPermissions).toBeUndefined()
    const stop = ExternalClaude.reply(request, { allow: false, message: "x", interrupt: true }).response.response
    expect(stop).toEqual({ behavior: "deny", message: "x", interrupt: true })
  })

  test("Codex: the decisions its 0.160.1 protocol schema defines, each mapped from a Lunos answer", () => {
    const schema = JSON.parse(readFileSync(path.join(FIXTURES, "codex-0.160.1", "approval-decisions.json"), "utf8"))
    const fileChange = schema.fileChange.map((item: any) => item.decision)
    const command = schema.commandExecution.map((item: any) => item.decision)
    // Every decision Lunos offers is one the schema defines for both kinds of approval.
    for (const decision of ExternalCodex.DECISIONS) {
      expect(fileChange).toContain(decision)
      expect(command).toContain(decision)
    }
    // The ones left out persist into Codex's own config.
    expect(command.filter((item: string) => !(ExternalCodex.DECISIONS as readonly string[]).includes(item))).toEqual([
      "acceptWithExecpolicyAmendment",
      "applyNetworkPolicyAmendment",
    ])
    expect(ExternalCodex.decision({ allow: true })).toBe("accept")
    expect(ExternalCodex.decision({ allow: true, always: true })).toBe("acceptForSession")
    expect(ExternalCodex.decision({ allow: false, message: ExternalNative.DECLINED })).toBe("decline")
    expect(ExternalCodex.decision({ allow: false, message: "stop", interrupt: true })).toBe("cancel")

    const request = { requestID: "0", tool: "FileChange", input: {}, decisions: [...ExternalCodex.DECISIONS] }
    expect(ExternalNative.choices("codex", request).map((item) => [item.id, item.reply, item.message])).toEqual([
      ["accept", "once", undefined],
      ["acceptForSession", "always", undefined],
      ["decline", "reject", ExternalNative.DECLINED],
      ["cancel", "reject", undefined],
    ])
    // A Codex that offers fewer decisions shows fewer choices.
    expect(ExternalNative.choices("codex", { ...request, decisions: ["accept", "decline"] }).map((i) => i.id)).toEqual([
      "accept",
      "decline",
    ])
  })
})

describe("Shift+Tab cycles the permission modes this Claude Code reports (XCOD-285)", () => {
  test("2.1.304's --help: manual → acceptEdits → plan; unsafe and auto-deciding modes never in the cycle", () => {
    const help = `--permission-mode <mode>  Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")`
    const modes = ExternalNative.cycle(ExternalDetect.permissionModes(help))
    expect(modes).toEqual(["manual", "acceptEdits", "plan"])
    expect(ExternalNative.next(modes, "default")).toBe("acceptEdits")
    expect(ExternalNative.next(modes, "acceptEdits")).toBe("plan")
    expect(ExternalNative.next(modes, "plan")).toBe("manual")
  })

  test("an older release without plan cycles what it has; no --help, no cycle", () => {
    expect(ExternalNative.cycle(["acceptEdits", "bypassPermissions", "default"])).toEqual(["default", "acceptEdits"])
    expect(ExternalNative.cycle(undefined)).toEqual([])
    expect(ExternalNative.next([], "default")).toBeUndefined()
  })

  test("a mode that skips approvals, or Codex, can't be chosen for the session", () => {
    expect(ExternalSession.invalidMode("claude", "acceptEdits", ["acceptEdits", "plan"])).toBeUndefined()
    expect(ExternalSession.invalidMode("claude", "bypassPermissions", undefined)).toMatch(/one run only/)
    expect(ExternalSession.invalidMode("claude", "plan", ["acceptEdits"])).toMatch(/doesn't list/)
    expect(ExternalSession.invalidMode("codex", "plan", undefined)).toMatch(/per thread/)
    expect(ConfigExternal.UNSAFE.has("bypassPermissions")).toBe(true)
  })

  test("the recorded 2.1.304 probe: the policy hook is applied and set_permission_mode answers with a status line", () => {
    const probe = lines(path.join(FIXTURES, "claude-2.1.304", "policy-hook-mode.1.jsonl"))
    const host = probe.filter((entry) => entry.from === "host").map((entry) => entry.message)
    expect(host[0].request).toEqual(ExternalClaude.initialize({ policy: async () => undefined }))
    const init = probe.find((entry) => entry.message?.response?.request_id === "lunos-init")!.message.response.response
    expect(init.hooks_applied).toBe(true)
    expect(init.current_permission_mode).toBe("default")
    // The commands it lists come with what it says about them; `(removed)` ones are dropped.
    const info = ExternalClaude.parseCommandInfo(init)
    expect(info.find((item) => item.name === "compact")).toMatchObject({
      description: "Free up context by summarizing the conversation so far",
      hint: "<optional custom summarization instructions>",
    })
    expect(info.some((item) => item.name === "agents")).toBe(false)
    const status = probe.filter((entry) => entry.from === "tool").map((entry) => JSON.stringify(entry.message))
    expect(status.flatMap((line) => ExternalClaude.parse(line).events)).toContainEqual({
      type: "mode",
      mode: "acceptEdits",
    })
  })
})

async function fake(env: Record<string, string>, options: Partial<ExternalClaude.Options>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-native-"))
  const log = path.join(dir, "host.log")
  Object.assign(process.env, { FAKE_CLAUDE_LOG: log, ...env })
  const events: ExternalClaude.Event[] = []
  try {
    const running = ExternalClaude.start({
      cwd: dir,
      prompt: "go",
      executable: FAKE,
      ask: async () => ({ allow: true }),
      onEvent: (event) => events.push(event),
      ...options,
    })
    return { running, events, log, dir }
  } finally {
    for (const key of Object.keys(env)) delete process.env[key]
  }
}

const sent = async (log: string) =>
  (await fs.readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

/** Lunos's policy as the session runs it, with one deny rule for `rm`. */
const lunosPolicy: ExternalClaude.Policy = async (call) => {
  const refusal = ExternalSession.policyRefusal(
    "claude",
    call,
    [{ permission: "external", pattern: "claude:Bash rm *", action: "deny" }],
    "ses_test",
  )
  return refusal ? { deny: refusal } : undefined
}

describe("a Lunos deny rule wins over the tool's permission mode (XCOD-285)", () => {
  test("a call the tool's mode allows without asking is refused by the hook, saying it's Lunos policy", async () => {
    const asked: string[] = []
    const { running, log } = await fake(
      { FAKE_CLAUDE_BASH: "rm -rf build", FAKE_CLAUDE_AUTO_ALLOW: "1" },
      {
        ask: async (request) => {
          asked.push(request.tool)
          return { allow: true }
        },
        policy: lunosPolicy,
      },
    )
    const result = await running.done
    await new Promise((resolve) => running.child.once("close", resolve))
    const host = await sent(log)
    expect(result.type).toBe("result")
    expect(asked).toEqual([])
    expect(host.find((line) => line.ran !== undefined)).toEqual({ ran: false, hooked: true })
    const answer = host.find((line) => line.response?.request_id === "hook_toolu_bash")!.response.response
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny")
    expect(answer.hookSpecificOutput.permissionDecisionReason).toMatch(
      /^Blocked by Lunos policy: the rule "external: claude:Bash rm \* → deny"/,
    )
  })

  test("without a matching deny rule the hook leaves the call to the tool's own mode", async () => {
    const { running, log } = await fake(
      { FAKE_CLAUDE_BASH: "ls", FAKE_CLAUDE_AUTO_ALLOW: "1" },
      { policy: lunosPolicy },
    )
    await running.done
    await new Promise((resolve) => running.child.once("close", resolve))
    const host = await sent(log)
    expect(host.find((line) => line.response?.request_id === "hook_toolu_bash")!.response.response).toEqual({})
    expect(host.find((line) => line.ran !== undefined)).toEqual({ ran: true, hooked: false })
  })

  test("a policy check that fails refuses the call rather than allowing it", async () => {
    const { running, log } = await fake(
      { FAKE_CLAUDE_BASH: "ls", FAKE_CLAUDE_AUTO_ALLOW: "1" },
      { policy: async () => Promise.reject(new Error("boom")) },
    )
    await running.done
    await new Promise((resolve) => running.child.once("close", resolve))
    const host = await sent(log)
    expect(host.find((line) => line.ran !== undefined)).toEqual({ ran: false, hooked: true })
  })

  test("without a policy no hook is registered, as before", () => {
    expect(ExternalClaude.initialize({})).toEqual({ subtype: "initialize", hooks: null })
  })

  test("a Claude Code that answers hooks_applied: false is reported, so the session can warn; one that applies it isn't", async () => {
    for (const [env, expected] of [
      [{ FAKE_CLAUDE_OLD: "1" }, 1],
      [{}, 0],
    ] as const) {
      let reported = 0
      const { running } = await fake(
        { FAKE_CLAUDE_BASH: "ls", FAKE_CLAUDE_AUTO_ALLOW: "1", ...env },
        { policy: lunosPolicy, onHooksNotApplied: () => reported++ },
      )
      await running.done
      await new Promise((resolve) => running.child.once("close", resolve))
      expect(reported).toBe(expected)
    }
    // Without a policy nothing was registered, so there's nothing to warn about.
    let reported = 0
    const { running } = await fake(
      { FAKE_CLAUDE_BASH: "ls", FAKE_CLAUDE_OLD: "1" },
      { onHooksNotApplied: () => reported++ },
    )
    await running.done
    await new Promise((resolve) => running.child.once("close", resolve))
    expect(reported).toBe(0)
  })
})

describe("the tool's own 'don't ask again' and mode switch, end to end against the fake (XCOD-285)", () => {
  test("a suggested rule goes back with destination session; an older release offers none", async () => {
    for (const old of [false, true]) {
      let seen: ExternalClaude.PermissionRequest | undefined
      const { running, log } = await fake(
        { FAKE_CLAUDE_BASH: "npm test", FAKE_CLAUDE_SUGGEST: "npm test:*", ...(old ? { FAKE_CLAUDE_OLD: "1" } : {}) },
        {
          ask: async (request) => {
            seen = request
            return { allow: true, always: true }
          },
        },
      )
      await running.done
      await new Promise((resolve) => running.child.once("close", resolve))
      const answer = (await sent(log)).find((line) => line.response?.request_id === "req_bash")!.response.response
      if (old) {
        expect(seen?.suggestions).toBeUndefined()
        expect(ExternalNative.choices("claude", seen!).map((item) => item.id)).toEqual(["yes", "no"])
        expect(answer.updatedPermissions).toBeUndefined()
      } else {
        expect(answer.updatedPermissions).toEqual([
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
            behavior: "allow",
            destination: "session",
          },
        ])
      }
    }
  })

  test("Shift+Tab mid-turn: set_permission_mode reaches the running tool, and its status line comes back as the mode", async () => {
    const { running, events, log } = await fake({ FAKE_CLAUDE_HOLD: "1" }, {})
    for (let i = 0; i < 100 && !events.some((event) => event.type === "init"); i++) await Bun.sleep(20)
    expect(events.find((event) => event.type === "init")).toMatchObject({ permissionMode: "default" })
    running.setMode!("plan")
    running.setMode!("bypassPermissions")
    for (let i = 0; i < 100 && !events.some((event) => event.type === "mode"); i++) await Bun.sleep(20)
    expect(events.filter((event) => event.type === "mode")).toEqual([{ type: "mode", mode: "plan" }])
    running.child.stdin?.end()
    await new Promise((resolve) => running.child.once("close", resolve))
    const requests = (await sent(log)).filter((line) => line.request?.subtype === "set_permission_mode")
    // An approval-skipping mode is never sent.
    expect(requests.map((line) => line.request.mode)).toEqual(["plan"])
  })

  test("the fake's --help reports the modes the cycle is built from, fewer for the older release", async () => {
    const help = await ExternalDetect.run(FAKE, ["--help"])
    expect(ExternalNative.cycle(ExternalDetect.permissionModes(help.stdout))).toEqual(["manual", "acceptEdits", "plan"])
    process.env.FAKE_CLAUDE_OLD = "1"
    try {
      const older = await ExternalDetect.run(FAKE, ["--help"])
      expect(ExternalNative.cycle(ExternalDetect.permissionModes(older.stdout))).toEqual(["default", "acceptEdits"])
    } finally {
      delete process.env.FAKE_CLAUDE_OLD
    }
  })
})

describe("the tool's edits and todos shown as it shows them (XCOD-285)", () => {
  test("Edit and Write carry a diff of the file, TodoWrite its checklist; Codex and other tools keep the generic view", () => {
    const edit = ExternalNative.render("claude", "Edit", {
      file_path: "/work/a.ts",
      old_string: "const a = 1\n",
      new_string: "const a = 2\n",
    })
    expect(edit).toMatchObject({ verb: "Edit", filePath: "/work/a.ts" })
    expect(String(edit.diff)).toContain("-const a = 1")
    expect(String(edit.diff)).toContain("+const a = 2")
    const write = ExternalNative.render("claude", "Write", { file_path: "/work/hello.txt", content: "hi" })
    expect(write).toMatchObject({ verb: "Write", filePath: "/work/hello.txt" })
    expect(String(write.diff)).toContain("+hi")
    expect(
      ExternalNative.render("claude", "TodoWrite", {
        todos: [
          { content: "Read the code", status: "completed", activeForm: "Reading the code" },
          { content: "Fix it", status: "in_progress", activeForm: "Fixing it" },
          { nonsense: true },
        ],
      }),
    ).toEqual({
      todos: [
        { content: "Read the code", status: "completed" },
        { content: "Fix it", status: "in_progress" },
      ],
    })
    expect(ExternalNative.render("claude", "Bash", { command: "ls" })).toEqual({})
    expect(ExternalNative.render("codex", "FileChange", { changes: [] })).toEqual({})
  })
})
