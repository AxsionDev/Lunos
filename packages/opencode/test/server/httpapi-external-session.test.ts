// XCOD-218: an external (Claude Code) session driven through the HTTP API, against the recorded
// protocol fixture (test/external/fixtures/fake-claude.ts). Never runs a real Claude Code.
import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Fiber, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Audit } from "@opencode-ai/core/audit"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Database } from "@opencode-ai/core/database/database"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FAKE = path.join(import.meta.dir, "..", "external", "fixtures", "fake-claude.ts")
const FIXTURE_SESSION = "a6fd116c-92e4-4731-a522-99679ab93931"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

const pathFor = (route: string, params: Record<string, string>) =>
  Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), route)

function call(directory: string, route: string, body?: unknown) {
  const url = new URL(route, "http://localhost")
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-opencode-directory": directory, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((text) => ({ status: response.status, body: text ? JSON.parse(text) : undefined })),
      ),
    ),
  )
}

// Real time: the test runtime's clock doesn't advance on its own.
const pause = Effect.promise(() => Bun.sleep(25))

/** Waits for the session's next pending approval and answers it. */
const answer = (directory: string, sessionID: string, reply: "once" | "always" | "reject", message?: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 400; i++) {
      const all = (yield* call(directory, "/permission")).body as any[]
      const pending = all.filter((item) => item.sessionID === sessionID)
      if (pending.length) {
        yield* call(directory, `/permission/${pending[0].id}/reply`, { reply, ...(message ? { message } : {}) })
        return pending[0]
      }
      yield* pause
    }
    throw new Error("no approval was asked")
  })

const hostLog = async (file: string) =>
  (await fs.readFile(file, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

afterEach(async () => {
  delete process.env.FAKE_CLAUDE_LOG
  delete process.env.FAKE_CODEX_LOG
  await disposeAllInstances()
  await resetDatabase()
})

describe("external session (XCOD-218)", () => {
  it.instance(
    "a Claude Code session: labelled, approvals through Lunos, cost per turn and in total, /commands, resume and stop",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const log = path.join(directory, "..", `fake-claude-${path.basename(directory)}.log`)
        process.env.FAKE_CLAUDE_LOG = log

        const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
        expect(created.status).toBe(200)
        const sessionID = created.body.id as string
        expect(created.body.title).toBe("Claude Code")
        expect(created.body.model).toMatchObject({ providerID: "external", id: "claude" })

        // Turn 1: refuse the first Write, approve the retry.
        const promptRoute = pathFor(SessionPaths.prompt, { sessionID })
        const first = yield* call(directory, promptRoute, {
          agent: "build",
          parts: [{ type: "text", text: "Create hello.txt containing hi" }],
        }).pipe(Effect.forkChild)
        const asked = yield* answer(directory, sessionID, "reject")
        expect(asked).toMatchObject({ permission: "external", metadata: { tool: "claude", action: "Write" } })
        expect(asked.patterns[0]).toMatch(/^claude:Write .*hello\.txt$/)
        yield* answer(directory, sessionID, "once")
        const reply = yield* Fiber.join(first)
        expect(reply.status).toBe(200)
        expect(reply.body.info).toMatchObject({ role: "assistant", mode: "Claude Code", providerID: "external" })
        expect(reply.body.info.cost).toBeCloseTo(0.3210852, 6)

        const messages = (yield* call(directory, pathFor(SessionPaths.messages, { sessionID }))).body as any[]
        const assistant = messages.find((message) => message.info.role === "assistant")
        const types = assistant.parts.map((part: any) =>
          part.type === "tool" ? `tool:${part.state.status}` : part.type,
        )
        expect(types).toEqual(["tool:error", "tool:completed", "text", "step-finish"])
        expect(assistant.parts[0].tool).toBe("claude:Write")
        expect(assistant.parts.at(-1).cost).toBeCloseTo(0.3210852, 6)
        expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "hello.txt"), "utf8"))).toBe("hi")

        let session = (yield* call(directory, pathFor(SessionPaths.get, { sessionID }))).body
        expect(session.metadata.external).toMatchObject({ tool: "claude", session: FIXTURE_SESSION })
        expect(session.metadata.external.commands).toEqual(["compact", "review"])
        expect(session.title).toBe(`Claude Code · ${FIXTURE_SESSION.slice(0, 8)}`)
        expect(session.cost).toBeCloseTo(0.3210852, 6)

        // Turn 2: one of Claude Code's own /commands, sent as typed, in the same Claude Code session.
        // Sent without an agent, as the TUI does; refused with feedback first, which the tool gets.
        const second = yield* call(directory, promptRoute, {
          parts: [{ type: "text", text: "/review" }],
        }).pipe(Effect.forkChild)
        yield* answer(directory, sessionID, "reject", "Call it greeting.txt")
        yield* answer(directory, sessionID, "once")
        expect((yield* Fiber.join(second)).status).toBe(200)
        session = (yield* call(directory, pathFor(SessionPaths.get, { sessionID }))).body
        expect(session.cost).toBeCloseTo(2 * 0.3210852, 6)

        const sent = yield* Effect.promise(() => hostLog(log))
        const runs = sent.filter((line) => line.argv?.includes("-p"))
        expect(runs).toHaveLength(2)
        expect(runs[0].argv).not.toContain("--resume")
        expect(runs[1].argv.join(" ")).toContain(`--resume ${FIXTURE_SESSION}`)
        const prompts = sent.filter((line) => line.type === "user").map((line) => line.message.content)
        expect(prompts).toEqual(["Create hello.txt containing hi", "/review"])
        // A plain Reject also ends Claude Code's turn, as in a Lunos session; feedback lets it carry on.
        const replies = sent.filter((line) => line.type === "control_response").map((line) => line.response.response)
        expect(replies.map((item) => [item.behavior, item.message, item.interrupt])).toEqual([
          ["deny", "The user refused this in Lunos.", true],
          ["allow", undefined, undefined],
          ["deny", "Call it greeting.txt", undefined],
          ["allow", undefined, undefined],
        ])

        // Turn 3: stopped while Claude Code waits for an approval.
        const third = yield* call(directory, promptRoute, {
          agent: "build",
          parts: [{ type: "text", text: "again" }],
        }).pipe(Effect.forkChild)
        for (let i = 0; i < 400; i++) {
          const pending = ((yield* call(directory, "/permission")).body as any[]).filter(
            (item) => item.sessionID === sessionID,
          )
          if (pending.length) break
          yield* pause
        }
        yield* call(directory, pathFor(SessionPaths.abort, { sessionID }), {})
        yield* Fiber.join(third)
        const pending = ((yield* call(directory, "/permission")).body as any[]).filter(
          (item) => item.sessionID === sessionID,
        )
        expect(pending).toEqual([])
        const after = (yield* call(directory, pathFor(SessionPaths.messages, { sessionID }))).body as any[]
        const stopped = after.findLast((message) => message.info.role === "assistant")
        expect(stopped.info.error?.name).toBe("MessageAbortedError")
        const status = (yield* call(directory, "/session/status")).body
        expect(status[sessionID]?.type ?? "idle").toBe("idle")
      }),
    { git: true, config: { formatter: false, lsp: false, external: { claude: { path: FAKE } } } as any },
    30_000,
  )

  it.instance(
    "a Codex session: same tab, Codex's approvals, its token count; a command it can't run is an error, not a crash",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        process.env.FAKE_CODEX_LOG = path.join(directory, "..", `fake-codex-${path.basename(directory)}.log`)
        const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "codex" } } })
        expect(created.body.title).toBe("Codex CLI")
        const sessionID = created.body.id as string
        const promptRoute = pathFor(SessionPaths.prompt, { sessionID })
        const turn = yield* call(directory, promptRoute, {
          agent: "build",
          parts: [{ type: "text", text: "Create note.txt" }],
        }).pipe(Effect.forkChild)
        const asked = yield* answer(directory, sessionID, "reject")
        expect(asked.patterns[0]).toMatch(/^codex:FileChange /)
        yield* answer(directory, sessionID, "once")
        const reply = yield* Fiber.join(turn)
        expect(reply.body.info).toMatchObject({ mode: "Codex CLI", cost: 0 })
        expect(reply.body.info.tokens.total).toBeGreaterThan(0)
        const session = (yield* call(directory, pathFor(SessionPaths.get, { sessionID }))).body
        expect(session.title).toBe("Codex CLI · 01a116f2")
        expect(session.metadata.external.session).toBe("01a116f2-5e88-79d3-afb9-db1da07c9fcd")

        const unsupported = yield* call(directory, promptRoute, {
          agent: "build",
          parts: [{ type: "text", text: "/model" }],
        })
        expect(unsupported.status).toBe(200)
        expect(unsupported.body.info.error?.data?.message).toMatch(/\/model/)
        delete process.env.FAKE_CODEX_LOG
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        // XCOD-254: nothing shared, so no consent question: the tool runs as it did before the bridge.
        external: {
          codex: { path: path.join(import.meta.dir, "..", "external", "fixtures", "fake-codex.ts") },
          share: { mcp: false, skills: false, memory: false },
        },
      } as any,
    },
    30_000,
  )

  it.instance(
    "under an EU-only residency policy, starting one is refused with the reason and audited",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const auditPath = path.join(directory, "audit.log")
        // The policy is read from the project config; written here so the audit path is per-test.
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(directory, "opencode.json"),
            JSON.stringify({ residency: { allow: ["eu"], auditPath }, external: { claude: { path: FAKE } } }),
          ),
        )
        yield* Effect.promise(() => disposeAllInstances())
        const refused = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
        expect(refused.status).toBe(403)
        expect(refused.body.message).toMatch(/Claude Code sends your code to Anthropic.*allows only: eu/)
        const list = (yield* call(directory, SessionPaths.list)).body as any[]
        expect(list.some((item) => item.metadata?.external)).toBe(false)
        yield* Effect.promise(() => Audit.flush())
        const lines = (yield* Effect.promise(() => fs.readFile(auditPath, "utf8")))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        expect(lines.find((line) => line.event === "external.denied")).toMatchObject({
          tool: "claude",
          provider: "anthropic",
          reason: "residency",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  it.instance(
    "XCOD-254: /models lists Claude Code's models; the choice applies from the next turn and survives a restart",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const log = path.join(directory, "..", `fake-claude-${path.basename(directory)}.log`)
        process.env.FAKE_CLAUDE_LOG = log
        const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
        const sessionID = created.body.id as string
        const modelsRoute = pathFor(ExperimentalPaths.externalModels, { sessionID })
        const modelRoute = pathFor(ExperimentalPaths.externalModel, { sessionID })
        const promptRoute = pathFor(SessionPaths.prompt, { sessionID })
        const turn = (text: string) =>
          Effect.gen(function* () {
            const running = yield* call(directory, promptRoute, { parts: [{ type: "text", text }] }).pipe(
              Effect.forkChild,
            )
            yield* answer(directory, sessionID, "once")
            yield* answer(directory, sessionID, "once")
            return (yield* Fiber.join(running)).body
          })

        const listed = (yield* call(directory, modelsRoute)).body
        expect(listed).toMatchObject({ tool: "claude", label: "Claude Code", fallback: false })
        expect(listed.current).toBeUndefined()
        expect(listed.models.map((model: any) => model.id)).toEqual(["default", "sonnet", "haiku"])

        // Turn 1 on the tool's default; then Sonnet is chosen.
        expect((yield* turn("first")).info.modelID).toBe("claude-opus-5-5[1m]")
        expect((yield* call(directory, modelRoute, { model: "sonnet; rm" })).status).toBe(400)
        expect((yield* call(directory, modelRoute, { model: "sonnet" })).body).toBe(true)
        const session = (yield* call(directory, pathFor(SessionPaths.get, { sessionID }))).body
        expect(session.metadata.external).toMatchObject({ tool: "claude", session: FIXTURE_SESSION, model: "sonnet" })
        expect((yield* call(directory, modelsRoute)).body.current).toBe("sonnet")

        // Turn 2 resumes with the new model, and its init names it.
        expect((yield* turn("second")).info.modelID).toBe("sonnet")
        // A Lunos restart: the next turn still resumes with Sonnet.
        yield* Effect.promise(() => disposeAllInstances())
        expect((yield* turn("third")).info.modelID).toBe("sonnet")
        // Back to the tool's default: no --model.
        expect((yield* call(directory, modelRoute, {})).body).toBe(true)
        yield* turn("fourth")

        const runs = (yield* Effect.promise(() => hostLog(log))).filter((line) => line.argv?.includes("-p"))
        const flags = runs.map((line) => {
          const argv = line.argv as string[]
          return [argv.includes("--resume"), argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined]
        })
        // The two /models probes start Claude Code too, with no prompt and no --resume.
        expect(flags).toEqual([
          [false, undefined],
          [false, undefined],
          [false, undefined],
          [true, "sonnet"],
          [true, "sonnet"],
          [true, undefined],
        ])
      }),
    { git: true, config: { formatter: false, lsp: false, external: { claude: { path: FAKE } } } as any },
    30_000,
  )

  it.instance(
    "XCOD-254: /models lists Codex's models through model/list; the choice goes on the resumed thread",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const log = path.join(directory, "..", `fake-codex-${path.basename(directory)}.log`)
        process.env.FAKE_CODEX_LOG = log
        const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "codex" } } })
        const sessionID = created.body.id as string
        const listed = (yield* call(directory, pathFor(ExperimentalPaths.externalModels, { sessionID }))).body
        expect(listed).toMatchObject({ tool: "codex", label: "Codex CLI", fallback: false })
        expect(listed.models.map((model: any) => [model.id, model.default ?? false])).toEqual([
          ["gpt-5.5", true],
          ["gpt-5.5-mini", false],
        ])
        yield* call(directory, pathFor(ExperimentalPaths.externalModel, { sessionID }), { model: "gpt-5.5-mini" })
        const promptRoute = pathFor(SessionPaths.prompt, { sessionID })
        const turn = (text: string) =>
          Effect.gen(function* () {
            const running = yield* call(directory, promptRoute, { parts: [{ type: "text", text }] }).pipe(
              Effect.forkChild,
            )
            yield* answer(directory, sessionID, "once")
            yield* answer(directory, sessionID, "once")
            return (yield* Fiber.join(running)).body
          })
        expect((yield* turn("Create note.txt")).info.modelID).toBe("gpt-5.5-mini")
        expect((yield* turn("again")).info.modelID).toBe("gpt-5.5-mini")
        const sent = yield* Effect.promise(() => hostLog(log))
        expect(sent.find((m) => m.method === "thread/start")?.params.model).toBe("gpt-5.5-mini")
        expect(sent.find((m) => m.method === "thread/resume")?.params.model).toBe("gpt-5.5-mini")
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        // XCOD-254: nothing shared, so no consent question: the tool runs as it did before the bridge.
        external: {
          codex: { path: path.join(import.meta.dir, "..", "external", "fixtures", "fake-codex.ts") },
          share: { mcp: false, skills: false, memory: false },
        },
      } as any,
    },
    30_000,
  )

  it.instance(
    "XCOD-254: a Claude Code that doesn't list its models offers its aliases",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        process.env.FAKE_CLAUDE_MODELS = "none"
        const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
        const listed = (yield* call(
          directory,
          pathFor(ExperimentalPaths.externalModels, { sessionID: created.body.id }),
        )).body
        delete process.env.FAKE_CLAUDE_MODELS
        expect(listed.fallback).toBe(true)
        expect(listed.models.map((model: any) => model.id)).toEqual(["opus", "sonnet", "haiku"])
        // Not an external session: no models to list.
        const plain = yield* call(directory, SessionPaths.create, {})
        expect(
          (yield* call(directory, pathFor(ExperimentalPaths.externalModels, { sessionID: plain.body.id }))).status,
        ).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false, external: { claude: { path: FAKE } } } as any },
    30_000,
  )

  it.instance(
    "XCOD-285: the tool's own approval choices, its don't-ask-again applied for the session, Shift+Tab's mode, and a Lunos deny rule over the tool's mode",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const log = path.join(directory, "..", `fake-claude-${path.basename(directory)}.log`)
        process.env.FAKE_CLAUDE_LOG = log
        const created = yield* call(directory, SessionPaths.create, { metadata: { external: { tool: "claude" } } })
        const sessionID = created.body.id as string
        const promptRoute = pathFor(SessionPaths.prompt, { sessionID })
        const get = () => call(directory, pathFor(SessionPaths.get, { sessionID })).pipe(Effect.map((r) => r.body))

        // Turn 1: the recorded Write asks with Claude Code's suggestion (accept edits for the session).
        const first = yield* call(directory, promptRoute, { parts: [{ type: "text", text: "Create hello.txt" }] }).pipe(
          Effect.forkChild,
        )
        const asked = yield* answer(directory, sessionID, "always")
        expect(asked.metadata.choices.map((item: any) => [item.label, item.reply])).toEqual([
          ["Yes", "once"],
          ["Yes, and don't ask again for edits in this session (accept edits mode)", "always"],
          ["No, and tell Claude what to do differently", "reject"],
        ])
        // The recorded retry of the same Write: allowed by the "always" just given, not asked again.
        expect((yield* Fiber.join(first)).status).toBe(200)
        let marker = (yield* get()).metadata.external
        // Its mode switch holds for the next turns; the mode it reported, and its commands with descriptions.
        expect(marker).toMatchObject({ permissionMode: "acceptEdits", mode: "default" })
        expect(marker.commandInfo).toContainEqual({ name: "review", description: "Review a pull request" })

        // Shift+Tab: plan is saved; an approval-skipping mode is refused.
        const modeRoute = pathFor(ExperimentalPaths.externalMode, { sessionID })
        expect((yield* call(directory, modeRoute, { mode: "bypassPermissions" })).status).toBe(400)
        expect((yield* call(directory, modeRoute, { mode: "plan" })).body).toBe(true)
        expect((yield* get()).metadata.external.permissionMode).toBe("plan")

        // Turn 2, where the tool's own mode would run the command without asking: Lunos's deny rule wins.
        process.env.FAKE_CLAUDE_BASH = "rm -rf build"
        process.env.FAKE_CLAUDE_AUTO_ALLOW = "1"
        const second = yield* call(directory, promptRoute, { parts: [{ type: "text", text: "clean up" }] })
        delete process.env.FAKE_CLAUDE_BASH
        delete process.env.FAKE_CLAUDE_AUTO_ALLOW
        expect(second.status).toBe(200)

        const sent = yield* Effect.promise(() => hostLog(log))
        const runs = sent.filter((line) => line.argv?.includes("-p")).map((line) => line.argv as string[])
        expect(runs.map((argv) => argv[argv.indexOf("--permission-mode") + 1])).toEqual(["default", "plan"])
        // Every turn registers the Lunos policy hook.
        const inits = sent.filter((line) => line.request?.subtype === "initialize").map((line) => line.request.hooks)
        expect(inits).toEqual([
          { PreToolUse: [{ hookCallbackIds: ["lunos-policy"] }] },
          { PreToolUse: [{ hookCallbackIds: ["lunos-policy"] }] },
        ])
        const allowed = sent.find((line) => line.response?.response?.behavior === "allow").response.response
        expect(allowed.updatedPermissions).toEqual([{ type: "setMode", mode: "acceptEdits", destination: "session" }])
        expect(sent.find((line) => line.ran !== undefined)).toEqual({ ran: false, hooked: true })
        const hook = sent.find((line) => line.response?.request_id === "hook_toolu_bash").response.response
        expect(hook.hookSpecificOutput.permissionDecisionReason).toMatch(/^Blocked by Lunos policy/)
        const messages = (yield* call(directory, pathFor(SessionPaths.messages, { sessionID }))).body as any[]
        // The recorded Write is shown as a diff of the file, as Claude Code shows it.
        const write = messages.flatMap((m) => m.parts).findLast((part: any) => part.tool === "claude:Write")
        expect(write.state.metadata).toMatchObject({ verb: "Write" })
        expect(write.state.metadata.diff).toContain("+hi")
        const bash = messages.flatMap((m) => m.parts).find((part: any) => part.tool === "claude:Bash")
        expect(bash.state).toMatchObject({ status: "error" })
        expect(bash.state.error).toMatch(/Lunos policy/)
      }),
    {
      git: true,
      config: {
        formatter: false,
        lsp: false,
        permission: { external: { "claude:Bash rm *": "deny" } },
        external: { claude: { path: FAKE } },
      } as any,
    },
    30_000,
  )
})
