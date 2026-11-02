import { afterAll, beforeAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigComputer } from "@opencode-ai/core/config/computer"
import { Agent } from "@/agent/agent"
import { AuditLog } from "@/audit/log"
import { Computer } from "@/computer"
import { Config } from "@/config/config"
import { Control } from "@/control"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { ComputerTool } from "@/tool/computer"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { FakeDesktop, FORM, TERMINAL } from "../computer/fake"

// XCOD-339: the computer tool end to end against a fake desktop (test/computer/fake.ts) that
// stands in for the OS layer: the gates, approvals, confirmations, refusals, stop key, pause on
// mouse movement, screenshots and audit. The real macOS and Windows layers are tested in
// test/computer/*.test.ts on their own platform.

let settings: ConfigComputer.Info = { enabled: true }
let residency: { allow: string[] } | undefined
let desktop = new FakeDesktop()

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, Truncate.node, Agent.node, Permission.node, EventV2Bridge.node]), [
    [Config.node, TestConfig.layer({ get: () => Effect.sync(() => ({ computer: settings, residency }) as never) })],
  ]),
)

const textModel = {
  providerID: "mistral",
  api: { url: "https://api.mistral.ai/v1" },
  capabilities: { input: { image: false } },
}
const visionModel = { providerID: "anthropic", api: {}, capabilities: { input: { image: true } } }

const ctx = (agent = "general", model: unknown = visionModel, abort = new AbortController().signal): Tool.Context => ({
  sessionID: SessionID.make("ses_computer"),
  messageID: MessageID.make("msg_computer"),
  callID: "call_computer",
  agent,
  abort,
  messages: [],
  extra: { model },
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const exec = (params: Tool.InferParameters<typeof ComputerTool>, context = ctx()) =>
  Effect.gen(function* () {
    const info = yield* ComputerTool
    const tool = yield* info.init()
    return yield* tool.execute(params, context)
  })

const pending = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    for (let i = 0; i < 500; i++) {
      const list = yield* permission.list()
      if (list.length) return list[0]!
      yield* Effect.sleep("10 millis")
    }
    throw new Error("no permission request")
  })

const reply = (requestID: string, answer: "once" | "always" | "reject") =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    // Answering moves the user's mouse (or presses a key): that mustn't pause the approved action.
    desktop.mouseAt = Date.now()
    yield* permission.reply({ requestID: requestID as never, reply: answer })
  })

/** Runs an action that asks once, answering `answer`. */
const approved = (params: Tool.InferParameters<typeof ComputerTool>, answer: "once" | "always" = "always") =>
  Effect.gen(function* () {
    const fiber = yield* exec(params).pipe(Effect.forkScoped)
    const request = yield* pending()
    yield* reply(request.id, answer)
    return { request, result: yield* Fiber.join(fiber) }
  })

let auditFile: string
const audit = async () =>
  (await AuditLog.flush(),
  await Bun.file(auditFile)
    .text()
    .catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown> & { event: string })

beforeAll(async () => {
  auditFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-computer-audit-")), "audit.log")
  AuditLog.activate({ enabled: true, file: auditFile, redact: [] })
})

afterAll(() => {
  Computer.use(undefined)
  AuditLog.activate({ enabled: false, file: auditFile, redact: [] })
})

beforeEach(async () => {
  desktop = new FakeDesktop()
  Computer.use(desktop)
  Control.reset()
  settings = { enabled: true }
  residency = undefined
  await Bun.write(auditFile, "")
})

describe("tool.computer", () => {
  it.instance("opens a sample app, fills its form and reads the result back, asking for the app once", () =>
    Effect.gen(function* () {
      const opened = yield* approved({ action: "open_app", app: "Sample Form" }, "once")
      expect(opened.request.permission).toBe("computer")
      expect(opened.request.patterns).toEqual([FORM.id])
      expect(opened.request.metadata?.["manual"]).toBe(true)
      expect(opened.request.metadata?.["kind"]).toBe("app")
      expect(opened.result.output).toContain("Sample Form is in front")

      // The same app this turn isn't asked again.
      const read = yield* exec({ action: "read" })
      expect(read.output).toContain('AXTextField "Name"')
      expect(read.output).toContain("(password field)")
      expect(read.output).toContain("<untrusted-content")

      yield* exec({ action: "click", ...desktop.at("name") })
      yield* exec({ action: "type", text: "Ada" })
      yield* exec({ action: "click", ...desktop.at("save") })
      const result = yield* exec({ action: "read" })
      expect(result.output).toContain('value="Saved Ada"')
      expect(desktop.events.map((item) => item.event)).toContain("type:A")

      // Every action is audited, and what was typed never is.
      const lines = yield* Effect.promise(audit)
      const actions = lines.filter((line) => line.event === "computer.action")
      expect(actions.map((line) => line["action"])).toEqual(["open_app", "read", "click", "type", "click", "read"])
      expect(actions.every((line) => line["app"] === FORM.id && line["outcome"] === "ok")).toBe(true)
      expect(actions[0]!["approved"]).toBe("asked")
      expect(actions[1]!["approved"]).toBe("approved earlier")
      expect(JSON.stringify(lines)).not.toContain("Ada")
    }),
  )

  it.instance("password-manager, system-settings and deny-listed apps are refused without asking", () =>
    Effect.gen(function* () {
      desktop.apps.push(
        { id: "com.1password.1password", name: "1Password" },
        { id: "com.apple.systempreferences", name: "System Settings" },
        { id: "com.example.blocked", name: "Blocked" },
      )
      settings = { enabled: true, deny: ["com.example.blocked"] }
      for (const app of ["1Password", "com.apple.systempreferences", "Blocked"]) {
        const result = yield* exec({ action: "open_app", app })
        expect(result.title).toBe("Refused")
      }
      expect(desktop.events.filter((item) => item.event.startsWith("open:"))).toHaveLength(0)
      const denied = (yield* Effect.promise(audit)).filter((line) => line.event === "computer.denied")
      expect(denied.map((line) => line["reason"])).toEqual([
        "category:password_manager",
        "category:system_settings",
        "deny list",
      ])
    }),
  )

  it.instance("the app Lunos runs in is never controlled, even when allowed", () =>
    Effect.gen(function* () {
      settings = { enabled: true, allow: ["dev.herdr.app"] }
      const result = yield* exec({ action: "click", x: 1100, y: 700 })
      expect(result.output).toContain("where Lunos itself runs")
      expect(desktop.events).toHaveLength(0)
    }),
  )

  it.instance("passwords, keys and password fields are never typed", () =>
    Effect.gen(function* () {
      settings = { enabled: true, allow: [FORM.id] }
      desktop.front = FORM
      desktop.shown = [FORM]
      yield* exec({ action: "click", ...desktop.at("password") })
      const intoPassword = yield* exec({ action: "type", text: "hunter2" })
      expect(intoPassword.output).toContain("never types into password fields")
      const keyInPassword = yield* exec({ action: "key", key: "a" })
      expect(keyInPassword.title).toBe("Refused")
      yield* exec({ action: "key", key: "tab" })

      yield* exec({ action: "click", ...desktop.at("name") })
      const apiKey = yield* exec({ action: "type", text: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })
      expect(apiKey.output).toContain("API key")
      const card = yield* exec({ action: "type", text: "4111 1111 1111 1111" })
      expect(card.output).toContain("card number")

      desktop.secure = true
      const secure = yield* exec({ action: "type", text: "hello" })
      expect(secure.output).toContain("secure keyboard entry")
      expect(desktop.events.filter((item) => item.event.startsWith("type:"))).toHaveLength(0)

      // Tab or Return inside the text would move past the checks: refused, nothing typed.
      desktop.secure = false
      expect(Exit.isFailure(yield* Effect.exit(exec({ action: "type", text: "alice\thunter2" })))).toBe(true)
      expect(Exit.isFailure(yield* Effect.exit(exec({ action: "type", text: "go\n" })))).toBe(true)
      expect(desktop.events.filter((item) => item.event.startsWith("type:"))).toHaveLength(0)

      // A password field taking focus mid-typing stops it.
      desktop.typeDelay = 2
      const fiber = yield* exec({ action: "type", text: "abcdefghijklmnop" }).pipe(Effect.forkScoped)
      while (desktop.events.filter((item) => item.event.startsWith("type:")).length < 3) yield* Effect.sleep("2 millis")
      desktop.secure = true
      const stopped = yield* Fiber.join(fiber)
      expect(stopped.output).toContain("a password field got focus")
      expect(desktop.events.filter((item) => item.event.startsWith("type:")).length).toBeLessThan(16)

      // Pasting a key from the clipboard is typing it.
      desktop.secure = false
      desktop.clipboard = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
      expect((yield* exec({ action: "key", key: "cmd+v" })).output).toContain("clipboard holds")
    }),
  )

  it.instance("instructions planted on screen are flagged, shown and audited, not followed", () =>
    Effect.gen(function* () {
      settings = { enabled: true, allow: [FORM.id] }
      desktop.front = FORM
      desktop.shown = [FORM]
      desktop.planted = true
      const read = yield* exec({ action: "read" })
      expect(read.title).toContain("instructions for the agent (not followed)")
      expect(read.output).toContain("WARNING")
      expect((read.metadata["injection"] as string[])[0]).toContain("ignore all previous instructions")
      const shot = yield* exec({ action: "screenshot" })
      expect(shot.output).toContain("WARNING")
      expect(shot.metadata["injection"]).toBeDefined()
      const lines = yield* Effect.promise(audit)
      expect(lines.filter((line) => line.event === "computer.injection")).toHaveLength(2)
      expect(JSON.stringify(lines)).not.toContain("evil@example.com")
    }),
  )

  it.instance("a click on something irreversible is confirmed first, by a person", () =>
    Effect.gen(function* () {
      settings = { enabled: true, allow: [FORM.id] }
      desktop.shown = [FORM]
      const fiber = yield* exec({ action: "click", ...desktop.at("delete") }).pipe(Effect.forkScoped)
      const request = yield* pending()
      expect(request.permission).toBe("computer_confirm")
      expect(request.metadata?.["manual"]).toBe(true)
      expect(request.metadata?.["title"]).toContain("Delete account")
      yield* reply(request.id, "reject")
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      expect(desktop.events.filter((item) => item.event.startsWith("click:"))).toHaveLength(0)
    }),
  )

  it.instance("Return on a window whose default button deletes is confirmed; the stop key can't be pressed", () =>
    Effect.gen(function* () {
      settings = { enabled: true, allow: [FORM.id] }
      desktop.front = FORM
      const stopKey = yield* exec({ action: "key", key: "ctrl+alt+esc" })
      expect(stopKey.output).toContain("stop key")
      const destructive = yield* exec({ action: "key", key: "cmd+backspace" }).pipe(Effect.forkScoped)
      const request = yield* pending()
      expect(request.permission).toBe("computer_confirm")
      yield* reply(request.id, "once")
      yield* Fiber.join(destructive)
      expect(desktop.events.map((item) => item.event)).toEqual(["key:cmd+backspace"])
    }),
  )

  it.instance(
    "the stop key ends control within 200 ms, mid-typing, and nothing is sent after it",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, allow: [FORM.id] }
        desktop.front = FORM
        desktop.focus = "name"
        desktop.typeDelay = 5
        const fiber = yield* exec({ action: "type", text: "x".repeat(400) }).pipe(Effect.forkScoped)
        while (desktop.events.length < 10) yield* Effect.sleep("5 millis")
        const pressed = Date.now()
        desktop.pressed = Computer.stopKey(settings)
        const exit = yield* Fiber.await(fiber)
        const ended = Date.now()
        expect(Exit.isFailure(exit)).toBe(true)
        expect(ended - pressed).toBeLessThan(200)
        const typed = desktop.events.filter((item) => item.event.startsWith("type:"))
        expect(typed.length).toBeLessThan(400)
        expect(typed.every((item) => item.at <= pressed + 200)).toBe(true)
        expect(Control.held("computer")?.why).toBe("stopped")
        // The browser is stopped too: the stop key ends all control.
        expect(Control.held("browser")?.why).toBe("stopped")
        expect(Computer.watching()).toBe(false)
        const lines = yield* Effect.promise(audit)
        expect(lines.filter((line) => line.event === "computer.stop")[0]!["origin"]).toBe("stop key")
        // The interrupted action is in the audit log too.
        expect(lines.find((line) => line.event === "computer.action" && line["action"] === "type")).toMatchObject({
          action: "type",
          outcome: "stopped",
          reason: "stop key",
        })

        // The next action asks before control resumes.
        desktop.pressed = undefined
        const next = yield* exec({ action: "key", key: "tab" }).pipe(Effect.forkScoped)
        const request = yield* pending()
        expect(request.metadata?.["kind"]).toBe("resume")
        yield* reply(request.id, "once")
        yield* Fiber.join(next)
      }),
    { timeout: 10_000 },
  )

  it.instance("Stop on the on-screen indicator stops control; moving the mouse pauses it", () =>
    Effect.gen(function* () {
      settings = { enabled: true, allow: [FORM.id] }
      desktop.front = FORM
      yield* exec({ action: "key", key: "tab" })
      expect(desktop.indicators).toBe(1)
      desktop.stopIndicator!()
      expect(Control.held("computer")).toEqual({ why: "stopped", origin: "indicator" })
      Control.resume("computer")

      yield* exec({ action: "key", key: "tab" })
      desktop.mouseAt = Date.now() + 1_000
      while (!Control.held("computer")) yield* Effect.sleep("10 millis")
      expect(Control.held("computer")).toEqual({ why: "paused", origin: "mouse" })
      const fiber = yield* exec({ action: "key", key: "tab" }).pipe(Effect.forkScoped)
      const request = yield* pending()
      expect(request.metadata?.["title"]).toContain("You took over")
      yield* reply(request.id, "reject")
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
    }),
  )

  it.instance("screenshots need a vision model the residency policy allows, and aren't stored", () =>
    Effect.gen(function* () {
      settings = { enabled: true, allow: [FORM.id] }
      desktop.front = FORM
      desktop.shown = [FORM]
      const textOnly = yield* exec({ action: "screenshot" }, ctx("general", textModel))
      expect(textOnly.output).toContain("can't see images")
      const unknown = yield* exec({ action: "screenshot" }, ctx("general", null))
      expect(unknown.output).toContain("can't tell which model")
      residency = { allow: ["eu"] }
      const blocked = yield* exec({ action: "screenshot" }, ctx("general", visionModel))
      expect(blocked.output).toContain("data-residency policy")
      expect(desktop.events.filter((item) => item.event.startsWith("capture"))).toHaveLength(0)

      residency = undefined
      const shot = yield* exec({ action: "screenshot" })
      expect(shot.metadata["ephemeralMedia"]).toBe(true)
      expect(shot.attachments?.[0]?.mime).toBe("image/jpeg")
      expect(shot.output).toContain("1280×800")

      // With Lunos's own terminal in front, a screenshot needs no approval (typing there is refused).
      desktop.front = TERMINAL
      desktop.shown = [TERMINAL, FORM]
      const fromTerminal = yield* exec({ action: "screenshot" })
      expect(fromTerminal.attachments).toHaveLength(1)
      expect((yield* exec({ action: "type", text: "ls" })).output).toContain("where Lunos itself runs")

      // Nothing is captured while a password manager is on screen.
      desktop.shown = [FORM, { id: "com.bitwarden.desktop", name: "Bitwarden" }]
      const hidden = yield* exec({ action: "screenshot" })
      expect(hidden.output).toContain("Bitwarden is on screen")
    }),
  )

  it.instance("the clipboard asks every time, and never holds a secret the agent put there", () =>
    Effect.gen(function* () {
      const read = yield* approved({ action: "clipboard_read" }, "once")
      expect(read.request.permission).toBe("computer_confirm")
      expect(read.request.always).toEqual([])
      expect(read.result.output).toContain("copied text")

      desktop.clipboard = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"
      const secret = yield* approved({ action: "clipboard_read" }, "once")
      expect(secret.result.output).not.toContain("sk-ant")

      const write = yield* exec({ action: "clipboard_write", text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" })
      expect(write.title).toBe("Refused")
    }),
  )

  it.instance("missing OS permissions are explained, with the setup command", () =>
    Effect.gen(function* () {
      desktop.missing = [{ name: "Accessibility", how: "System Settings › Privacy & Security › Accessibility" }]
      const result = yield* exec({ action: "screenshot" })
      expect(result.output).toContain("Accessibility")
      expect(result.output).toContain("lunos computer setup")
    }),
  )

  it.instance("off in config: the tool refuses; build and explore don't get it", () =>
    Effect.gen(function* () {
      settings = { enabled: true }
      desktop.shown = [FORM]
      const build = yield* exec({ action: "click", ...desktop.at("name") }, ctx("build"))
      expect(build.output).toContain("computer rules deny")
      settings = {}
      expect(Exit.isFailure(yield* Effect.exit(exec({ action: "screenshot" })))).toBe(true)
    }),
  )
})

describe("Computer.sandboxed", () => {
  it.live("host control is refused inside a sandbox", () =>
    Effect.sync(() => {
      expect(Computer.sandboxed(true)).toContain("sandbox")
      expect(Computer.sandboxed(false)).toBeUndefined()
    }),
  )
})
