import { afterAll, beforeAll, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigBrowser } from "@opencode-ai/core/config/browser"
import { Agent } from "@/agent/agent"
import { AuditLog } from "@/audit/log"
import { Browser } from "@/browser"
import { BrowserLaunch } from "@/browser/launch"
import { Config } from "@/config/config"
import { Control } from "@/control"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { MessageID, SessionID } from "@/session/schema"
import { BrowserTool } from "@/tool/browser"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { serve } from "../browser/fixture"

// XCOD-327: the browser tool end to end, against a real headless Chrome and the security test
// page (test/browser/fixture.ts). Skipped where no Chrome-family browser is installed.

let settings: ConfigBrowser.Info = {}
let residency: { allow: string[] } | undefined

const it = testEffect(
  LayerNode.compile(LayerNode.group([Config.node, Truncate.node, Agent.node, Permission.node, EventV2Bridge.node]), [
    [Config.node, TestConfig.layer({ get: () => Effect.sync(() => ({ browser: settings, residency }) as never) })],
  ]),
)

const textModel = {
  providerID: "mistral",
  api: { url: "https://api.mistral.ai/v1" },
  capabilities: { input: { image: false } },
}
const visionModel = { providerID: "anthropic", api: {}, capabilities: { input: { image: true } } }

const ctx = (agent = "qa", model: unknown = textModel): Tool.Context => ({
  sessionID: SessionID.make("ses_browser"),
  messageID: MessageID.make("msg_browser"),
  callID: "call_browser",
  agent,
  abort: new AbortController().signal,
  messages: [],
  extra: { model },
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

const exec = (params: Tool.InferParameters<typeof BrowserTool>, context = ctx()) =>
  Effect.gen(function* () {
    const info = yield* BrowserTool
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
    yield* permission.reply({ requestID: requestID as never, reply: answer })
  })

const chrome = BrowserLaunch.find()
const suite = chrome ? describe : describe.skip

suite("tool.browser (real Chrome)", () => {
  let server: ReturnType<typeof serve>
  let host: string
  let auditFile: string
  const audit = async () =>
    (
      await Bun.file(auditFile)
        .text()
        .catch(() => "")
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  beforeAll(async () => {
    server = serve()
    host = server.url.hostname
    auditFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-browser-audit-")), "audit.log")
    AuditLog.activate({ enabled: true, file: auditFile, redact: [] })
  })

  afterAll(async () => {
    await Browser.close()
    server?.stop(true)
    AuditLog.activate({ enabled: false, file: auditFile, redact: [] })
  })

  it.instance(
    "a new site asks first (once, always or deny), then the page is read as text with refs",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, headless: true }
        Control.reset()
        const fiber = yield* exec({ action: "navigate", url: server.url.href }).pipe(Effect.forkScoped)
        const request = yield* pending()
        expect(request.permission).toBe("browser")
        expect(request.patterns).toEqual([host])
        expect(request.always).toEqual([host])
        expect(request.metadata?.["manual"]).toBe(true)
        expect((request.metadata?.["choices"] as { id: string }[]).map((choice) => choice.id)).toEqual([
          "once",
          "always",
          "deny",
        ])
        yield* reply(request.id, "always")
        const result = yield* Fiber.join(fiber)
        expect(result.output).toContain("<untrusted-content")
        expect(result.output).toMatch(/textbox "Display name" \[ref=e\d+\]/)
        // The planted instruction is called out, not followed, and shown to the user in the title.
        expect(result.output).toContain("WARNING: the page contains instructions addressed to an AI agent")
        expect(result.title).toContain("page has instructions for the agent (not followed)")
        expect(result.metadata["injection"]).toBeDefined()
      }),
    { timeout: 60_000 },
  )

  it.instance(
    "the browser tool is refused a site for agents that don't have it",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, headless: true, allow: [] }
        const result = yield* exec({ action: "read" }, ctx("build"))
        expect(result.output).toContain("browser rules deny")
      }),
    { timeout: 60_000 },
  )

  it.instance(
    "never types a password, a card number or a key",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, headless: true, allow: [host] }
        const read = yield* exec({ action: "read" })
        const ref = (name: string) => read.output.match(new RegExp(`"${name}" \\[ref=(e\\d+)\\]`))![1]!
        const password = yield* exec({ action: "type", ref: ref("Password"), text: "hunter2" })
        expect(password.output).toContain("Lunos never types passwords")
        const card = yield* exec({ action: "type", ref: ref("Notes"), text: "4111 1111 1111 1111" })
        expect(card.output).toContain("card number")
        const key = yield* exec({ action: "type", ref: ref("Notes"), text: "sk-ant-api03-abcdefghijklmnopqrstuv" })
        expect(key.output).toContain("API key")
        const fine = yield* exec({ action: "type", ref: ref("Display name"), text: "Petar" })
        expect(fine.output).toContain("Typed 5 characters")
      }),
    { timeout: 60_000 },
  )

  it.instance(
    "submitting the form and downloading always ask first, even on an allowed site",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, headless: true, allow: [host] }
        const read = yield* exec({ action: "read" })
        const ref = (name: string) => read.output.match(new RegExp(`"${name}" \\[ref=(e\\d+)\\]`))![1]!

        const submit = yield* exec({ action: "click", ref: ref("Save profile") }).pipe(Effect.exit, Effect.forkScoped)
        const ask = yield* pending()
        expect(ask.permission).toBe("browser_confirm")
        expect(ask.always).toEqual([])
        expect(String(ask.metadata?.["title"])).toContain('Submit the form with "Save profile"')
        expect(String(ask.metadata?.["title"])).toContain("/save")
        yield* reply(ask.id, "reject")
        const refused = yield* Fiber.join(submit)
        expect(Exit.isFailure(refused)).toBe(true)
        if (Exit.isFailure(refused)) expect(String(Cause.squash(refused.cause))).toContain("rejected")

        const download = yield* exec({ action: "click", ref: ref("Download report") }).pipe(Effect.forkScoped)
        const downloadAsk = yield* pending()
        expect(String(downloadAsk.metadata?.["title"])).toContain("Download")
        yield* reply(downloadAsk.id, "once")
        yield* Fiber.join(download)
        const list = yield* exec({ action: "downloads" })
        expect(list.output).toContain("report.csv")

        // The CAPTCHA is handed to the user.
        const captcha = yield* exec({ action: "click", ref: ref("I'm not a robot") })
        expect(captcha.output).toContain("never solves CAPTCHAs")
      }),
    { timeout: 60_000 },
  )

  it.instance(
    "a deny-listed or banking site is refused without asking, also after a redirect",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, headless: true, allow: [host], deny: ["evil.example"] }
        const bank = yield* exec({ action: "navigate", url: "https://www.chase.com/" })
        expect(bank.output).toContain("banking site")
        const denied = yield* exec({ action: "navigate", url: "https://evil.example/steal" })
        expect(denied.output).toContain("deny list")
        yield* exec({ action: "navigate", url: server.url.href })
        const read = yield* exec({ action: "read" })
        const link = read.output.match(/"To the bank" \[ref=(e\d+)\]/)![1]!
        const redirected = yield* exec({ action: "click", ref: link })
        expect(redirected.output).toContain("www.chase.com")
        expect(redirected.output).toContain("The tab was cleared")
        const lines = yield* Effect.promise(audit)
        expect(lines.some((line) => line["event"] === "browser.denied" && line["reason"] === "category:banking")).toBe(
          true,
        )
      }),
    { timeout: 60_000 },
  )

  it.instance(
    "screenshots: refused for a text-only model; otherwise sent once and marked not to be stored",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, headless: true, allow: [host] }
        yield* exec({ action: "navigate", url: server.url.href })
        const text = yield* exec({ action: "screenshot" }, ctx("qa", textModel))
        expect(text.output).toContain("can't see images")
        expect(text.attachments).toBeUndefined()
        const shot = yield* exec({ action: "screenshot" }, ctx("qa", visionModel))
        expect(shot.attachments?.[0]?.url.startsWith("data:image/jpeg;base64,")).toBe(true)
        expect(shot.metadata["ephemeralMedia"]).toBe(true)
      }),
    { timeout: 60_000 },
  )

  it.instance(
    "under EU-only residency a screenshot never goes to a non-EU model",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, headless: true, allow: [host] }
        residency = { allow: ["eu"] }
        const shot = yield* exec(
          { action: "screenshot" },
          ctx("qa", {
            providerID: "openai",
            api: { url: "https://api.openai.com/v1" },
            capabilities: { input: { image: true } },
          }),
        )
        residency = undefined
        expect(shot.output).toContain("data-residency policy")
        expect(shot.attachments).toBeUndefined()
      }),
    { timeout: 60_000 },
  )

  it.instance(
    "after the user stops control, the next action asks to resume",
    () =>
      Effect.gen(function* () {
        settings = { enabled: true, headless: true, allow: [host] }
        Control.stop("browser", "indicator")
        const fiber = yield* exec({ action: "read" }).pipe(Effect.forkScoped)
        const ask = yield* pending()
        expect(ask.metadata?.["kind"]).toBe("resume")
        expect(String(ask.metadata?.["detail"])).toContain("You stopped browser control (indicator)")
        yield* reply(ask.id, "once")
        const result = yield* Fiber.join(fiber)
        expect(result.output).toContain("Lunos browser test")
        expect(Control.held("browser")).toBeUndefined()
      }),
    { timeout: 60_000 },
  )

  it.instance(
    "every action is in the audit log, with no page text and no screenshot",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => AuditLog.flush())
        const lines = yield* Effect.promise(audit)
        const actions = lines.filter((line) => line["event"] === "browser.action")
        expect(actions.length).toBeGreaterThan(8)
        for (const line of actions) {
          expect(line["action"]).toBeDefined()
          expect(line["approved"]).toBeDefined()
          expect(line["outcome"]).toBeDefined()
        }
        expect(lines.some((line) => line["event"] === "browser.injection")).toBe(true)
        expect(lines.some((line) => line["event"] === "browser.stop" && line["origin"] === "indicator")).toBe(true)
        const raw = yield* Effect.promise(() => Bun.file(auditFile).text())
        expect(raw).not.toContain("base64")
        expect(raw).not.toContain("hunter2")
        expect(raw).not.toContain("ignore all previous instructions")
      }),
    { timeout: 60_000 },
  )
})
