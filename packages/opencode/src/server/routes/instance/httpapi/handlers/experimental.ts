import { Account } from "@/account/account"
import { SessionArtifacts } from "@/session/artifacts"
import * as BackgroundList from "@/background/list"
import { backgroundEnabled } from "@/background/enabled"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { MCP } from "@/mcp"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Option } from "effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  PeerAsks,
  ConsoleSwitchPayload,
  SessionEnqueuePayload,
  SessionTakeoverPayload,
  SessionGroupCreatePayload,
  SessionGroupMovePayload,
  SessionGroupUpdatePayload,
  SessionBulkArchivePayload,
  SessionBulkDeletePayload,
  SessionBulkPayload,
  SessionBulkStopPayload,
  SessionListQuery,
  SessionOverviewQuery,
  ToolListQuery,
  WorktreeApiError,
} from "../groups/experimental"
import { InvalidRequestError, notFound } from "../errors"
import { SessionGroups } from "@/session/groups"
import { SessionLive } from "@/session/live"
import { SessionPeers } from "@/session/peers"
import { SessionPeerControl } from "@/session/peer-control"
import { SessionOverview } from "@/session/overview"
import { SessionPromptQueue } from "@/session/prompt-queue"
import { SessionBulk } from "@/session/bulk"
import { SessionShare } from "@/share/session"
import { ExternalRegistry } from "@/external/registry"
import { ExternalDetect } from "@/external/detect"
import { ExternalPolicy } from "@/external/policy"
import { ExternalRun } from "@/external/run"
import { ExternalSession } from "@/external/session"
import { ExternalConsent } from "@/external/consent"
import { GlobalBus } from "@/bus/global"
import { SessionGroupEvent } from "@opencode-ai/schema/session-group-event"

// XCOD-205: group store errors become the endpoint's declared errors.
function groupErrors<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (error) => {
      if (error instanceof SessionGroups.NotFoundError) return notFound(error.message)
      if (error instanceof SessionGroups.InvalidError) return new InvalidRequestError({ message: error.message })
      throw error
    },
  })
}

let peerEvents: (() => void) | undefined
// XCOD-234: other Lunos processes' sessions changed (or one stopped responding): every surface re-reads.
function publishPeerChanges() {
  peerEvents ??= SessionPeers.subscribe(() =>
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: SessionGroupEvent.LiveUpdated.type, properties: {} },
    }),
  )
}

let groupEvents: (() => void) | undefined
// Every surface (this process's and other processes' changes alike) hears about it on the global stream.
function publishGroupChanges() {
  groupEvents ??= SessionGroups.subscribe(() =>
    GlobalBus.emit("event", {
      directory: "global",
      payload: { type: SessionGroupEvent.Updated.type, properties: {} },
    }),
  )
}

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const account = yield* Account.Service
    const agents = yield* Agent.Service
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const project = yield* Project.Service
    const registry = yield* ToolRegistry.Service
    const worktreeSvc = yield* Worktree.Service
    const sessions = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const background = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service
    const flags = yield* RuntimeFlags.Service
    SessionLive.start()
    SessionLive.withControl(SessionPeerControl.start)
    publishGroupChanges()
    publishPeerChanges()

    const capabilities = Effect.fn("ExperimentalHttpApi.capabilities")(function* () {
      return { backgroundSubagents: backgroundEnabled(flags.experimentalBackgroundSubagents, yield* config.get()) }
    })

    const getConsole = Effect.fn("ExperimentalHttpApi.console")(function* () {
      const [state, groups] = yield* Effect.all(
        [
          config.getConsoleState(),
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      return {
        consoleManagedProviders: state.consoleManagedProviders,
        ...(state.activeOrgName ? { activeOrgName: state.activeOrgName } : {}),
        switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
      }
    })

    const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.consoleOrgs")(function* () {
      const [groups, active] = yield* Effect.all(
        [
          account.orgsByAccount().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
          account.active().pipe(Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({})))),
        ],
        {
          concurrency: "unbounded",
        },
      )
      const info = Option.getOrUndefined(active)
      return {
        orgs: groups.flatMap((group) =>
          group.orgs.map((org) => ({
            accountID: group.account.id,
            accountEmail: group.account.email,
            accountUrl: group.account.url,
            orgID: org.id,
            orgName: org.name,
            active: !!info && info.id === group.account.id && info.active_org_id === org.id,
          })),
        ),
      }
    })

    const switchConsole = Effect.fn("ExperimentalHttpApi.consoleSwitch")(function* (ctx: {
      payload: typeof ConsoleSwitchPayload.Type
    }) {
      yield* account
        .use(ctx.payload.accountID, Option.some(ctx.payload.orgID))
        .pipe(Effect.catch(() => Effect.fail(new HttpApiError.BadRequest({}))))
      return true
    })

    const tool = Effect.fn("ExperimentalHttpApi.tool")(function* (ctx: { query: typeof ToolListQuery.Type }) {
      const list = yield* registry.tools({
        providerID: ctx.query.provider,
        modelID: ctx.query.model,
        agent: yield* agents.defaultInfo(),
      })
      return list.map((item) => ({
        id: item.id,
        description: item.description,
        parameters: ToolJsonSchema.fromTool(item),
      }))
    })

    const toolIDs = Effect.fn("ExperimentalHttpApi.toolIDs")(function* () {
      return yield* registry.ids()
    })

    const worktree = Effect.fn("ExperimentalHttpApi.worktree")(function* () {
      const ctx = yield* InstanceState.context
      return yield* project.sandboxes(ctx.project.id)
    })

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    const worktreeRemove = Effect.fn("ExperimentalHttpApi.worktreeRemove")(function* (input: {
      payload: Worktree.RemoveInput
    }) {
      const ctx = yield* InstanceState.context
      yield* mapWorktreeError(worktreeSvc.remove(input.payload))
      yield* project.removeSandbox(ctx.project.id, input.payload.directory)
      return true
    })

    const worktreeReset = Effect.fn("ExperimentalHttpApi.worktreeReset")(function* (ctx: {
      payload: Worktree.ResetInput
    }) {
      yield* mapWorktreeError(worktreeSvc.reset(ctx.payload))
      return true
    })

    const session = Effect.fn("ExperimentalHttpApi.session")(function* (ctx: { query: typeof SessionListQuery.Type }) {
      const limit = ctx.query.limit ?? 100
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      const all = yield* sessions.listGlobal({
        directory,
        roots: ctx.query.roots,
        start: ctx.query.start,
        cursor: ctx.query.cursor,
        search: ctx.query.search,
        limit: limit + 1,
        archived: ctx.query.archived,
      })
      const list = all.length > limit ? all.slice(0, limit) : all
      return HttpServerResponse.jsonUnsafe(list, {
        headers:
          all.length > limit && list.length > 0
            ? { "x-next-cursor": String(list[list.length - 1].time.updated) }
            : undefined,
      })
    })

    const sessionBackground = Effect.fn("ExperimentalHttpApi.sessionBackground")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!backgroundEnabled(flags.experimentalBackgroundSubagents, yield* config.get())) return false
      const jobs = (yield* background.list()).filter(
        (job) =>
          job.type === "task" &&
          job.status === "running" &&
          job.metadata?.parentSessionId === ctx.params.sessionID &&
          job.metadata.background !== true,
      )
      const promoted = yield* Effect.forEach(jobs, (job) => background.promote(job.id), { concurrency: "unbounded" })
      return promoted.some((job) => job !== undefined)
    })

    const artifacts = Effect.fn("ExperimentalHttpApi.artifacts")(function* (ctx: {
      query: { kind?: SessionArtifacts.Kind }
    }) {
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() => SessionArtifacts.list(instance, ctx.query.kind))
    })

    // XCOD-82: the list the TUI, app and ACP render. Task jobs only; newest first.
    const backgroundJobs = Effect.fn("ExperimentalHttpApi.backgroundJobs")(function* (ctx: {
      query: { sessionID?: string }
    }) {
      return BackgroundList.list(yield* background.list(), ctx.query.sessionID)
    })

    const backgroundJobCancel = Effect.fn("ExperimentalHttpApi.backgroundJobCancel")(function* (ctx: {
      params: { jobID: string }
    }) {
      const job = yield* background.get(ctx.params.jobID)
      if (job?.status !== "running") return false
      // Same path as aborting the job's own session: cancels the job and its descendants.
      yield* runState.cancel(SessionID.make(ctx.params.jobID))
      return true
    })

    const sessionOverview = Effect.fn("ExperimentalHttpApi.sessionOverview")(function* (ctx: {
      query: typeof SessionOverviewQuery.Type
    }) {
      return yield* SessionOverview.build({ archived: ctx.query.archived }).pipe(
        Effect.provideService(Session.Service, sessions),
      )
    })

    // XCOD-265: Stop all, Clear list, Unarchive, Delete archived.
    const sessionBulkStop = Effect.fn("ExperimentalHttpApi.sessionBulkStop")(function* (ctx: {
      payload: typeof SessionBulkStopPayload.Type
    }) {
      return yield* SessionBulk.stop(ctx.payload).pipe(Effect.provideService(Session.Service, sessions))
    })
    const sessionBulkArchive = Effect.fn("ExperimentalHttpApi.sessionBulkArchive")(function* (ctx: {
      payload: typeof SessionBulkArchivePayload.Type
    }) {
      const run = ctx.payload.stop
        ? SessionBulk.stopAndArchive(ctx.payload)
        : SessionBulk.archive({ sessionIDs: ctx.payload.sessionIDs })
      return yield* run.pipe(Effect.provideService(Session.Service, sessions))
    })
    const sessionBulkUnarchive = Effect.fn("ExperimentalHttpApi.sessionBulkUnarchive")(function* (ctx: {
      payload: typeof SessionBulkPayload.Type
    }) {
      return yield* SessionBulk.unarchive(ctx.payload).pipe(Effect.provideService(Session.Service, sessions))
    })
    const sessionBulkDelete = Effect.fn("ExperimentalHttpApi.sessionBulkDelete")(function* (ctx: {
      payload: typeof SessionBulkDeletePayload.Type
    }) {
      return yield* SessionBulk.remove({
        ...ctx.payload,
        reason: ctx.payload.stop ? "Stopped to delete it" : undefined,
        unshare: shareSvc.unshare,
      }).pipe(Effect.provideService(Session.Service, sessions))
    })
    const sessionBulkPreview = Effect.fn("ExperimentalHttpApi.sessionBulkPreview")(function* (ctx: {
      payload: typeof SessionBulkPayload.Type
    }) {
      return yield* SessionBulk.preview(ctx.payload).pipe(Effect.provideService(Session.Service, sessions))
    })

    const sessionGroupList = Effect.fn("ExperimentalHttpApi.sessionGroupList")(function* () {
      return (yield* Effect.promise(() => SessionGroups.read())).groups
    })

    const sessionGroupCreate = Effect.fn("ExperimentalHttpApi.sessionGroupCreate")(function* (ctx: {
      payload: typeof SessionGroupCreatePayload.Type
    }) {
      return yield* groupErrors(() => SessionGroups.create(ctx.payload))
    })

    const sessionGroupUpdate = Effect.fn("ExperimentalHttpApi.sessionGroupUpdate")(function* (ctx: {
      params: { groupID: string }
      payload: typeof SessionGroupUpdatePayload.Type
    }) {
      return yield* groupErrors(() => SessionGroups.patch(ctx.params.groupID, ctx.payload))
    })

    const sessionGroupDelete = Effect.fn("ExperimentalHttpApi.sessionGroupDelete")(function* (ctx: {
      params: { groupID: string }
    }) {
      return yield* groupErrors(() => SessionGroups.remove(ctx.params.groupID))
    })

    const sessionGroupMove = Effect.fn("ExperimentalHttpApi.sessionGroupMove")(function* (ctx: {
      payload: typeof SessionGroupMovePayload.Type
    }) {
      return yield* groupErrors(() => SessionGroups.move(ctx.payload.sessionIDs, ctx.payload.groupID ?? null))
    })

    // XCOD-234: the same as `lunos external stop`; the registry finds the tool's process by pid, so
    // this works whichever Lunos process started it.
    const externalStop = Effect.fn("ExperimentalHttpApi.externalStop")(function* (ctx: {
      params: { sessionID: string }
    }) {
      const result = yield* Effect.promise(() => ExternalRegistry.stop(ctx.params.sessionID))
      if (result.ok) return true
      const missing = !(yield* Effect.promise(() => ExternalRegistry.get(ctx.params.sessionID)))
      return yield* missing
        ? Effect.fail(notFound(result.reason))
        : Effect.fail(new InvalidRequestError({ message: result.reason }))
    })

    // XCOD-250: availability for /claude and /codex. Detection runs the tools' own --version/--help,
    // so it's asked when the commands are offered, not on every keystroke.
    const externalTools = Effect.fn("ExperimentalHttpApi.externalTools")(function* () {
      const cfg = yield* config.get()
      const instance = yield* InstanceState.context
      return yield* Effect.promise(() =>
        Promise.all(
          (["claude", "codex"] as const).map(async (tool) => {
            const status = await ExternalDetect.detect(tool, ExternalRun.configuredPath(tool, cfg))
            const refused = ExternalPolicy.evaluate(tool, cfg)
            const consent = await ExternalConsent.get(ExternalConsent.project(instance), tool)
            return {
              tool,
              label: status.label,
              installed: status.installed && !status.outdated,
              ...(status.loggedIn !== undefined ? { loggedIn: status.loggedIn } : {}),
              ...(status.hint || status.outdated ? { hint: status.hint ?? status.outdated } : {}),
              ...(refused ? { refused } : {}),
              ...(status.permissionModes ? { permissionModes: status.permissionModes } : {}),
              ...(consent ? { consent } : {}),
            }
          }),
        ),
      )
    })

    // XCOD-254: /models and its choice in a Claude Code / Codex session.
    const externalMarker = Effect.fn("ExperimentalHttpApi.externalMarker")(function* (sessionID: string) {
      const info = yield* sessions
        .get(SessionID.make(sessionID))
        .pipe(Effect.catch(() => Effect.fail(notFound(`Session ${sessionID} not found`))))
      const marker = ExternalSession.of(info)
      if (!marker) return yield* Effect.fail(new InvalidRequestError({ message: "Not a Claude Code or Codex session" }))
      return marker
    })

    const externalModels = Effect.fn("ExperimentalHttpApi.externalModels")(function* (ctx: {
      params: { sessionID: string }
    }) {
      const marker = yield* externalMarker(ctx.params.sessionID)
      const cfg = yield* config.get()
      const instance = yield* InstanceState.context
      const listed = yield* Effect.promise(() => ExternalSession.models(marker.tool, cfg, instance.directory))
      return {
        tool: marker.tool,
        label: ExternalSession.label(marker.tool),
        ...(marker.model ? { current: marker.model } : {}),
        ...listed,
      }
    })

    const externalModel = Effect.fn("ExperimentalHttpApi.externalModel")(function* (ctx: {
      params: { sessionID: string }
      payload: { model?: string }
    }) {
      yield* externalMarker(ctx.params.sessionID)
      const model = ctx.payload.model?.trim() || undefined
      const invalid = model ? ExternalSession.invalidModel(model) : undefined
      if (invalid) return yield* Effect.fail(new InvalidRequestError({ message: invalid }))
      yield* ExternalSession.setModel(sessions, SessionID.make(ctx.params.sessionID), model)
      return true
    })

    // XCOD-254: the answer to sharing Lunos with a tool in this project, as `lunos external share`.
    const externalConsent = Effect.fn("ExperimentalHttpApi.externalConsent")(function* (ctx: {
      payload: { tool: "claude" | "codex"; answer: "share" | "never" | "ask" }
    }) {
      const cfg = yield* config.get()
      const instance = yield* InstanceState.context
      const { tool, answer } = ctx.payload
      yield* Effect.promise(() =>
        ExternalConsent.set(ExternalConsent.project(instance), tool, answer === "ask" ? undefined : answer),
      )
      ExternalPolicy.record(cfg, "external.consent", {
        tool,
        provider: ExternalDetect.TOOLS[tool].provider,
        answer,
        origin: "settings",
      })
      return true
    })

    // XCOD-234: sessions another Lunos process runs; that process does the work (and the audit).
    const peer = <A>(sessionID: string, path: string, init?: { method?: string; body?: unknown }) =>
      Effect.tryPromise({
        try: () => SessionPeerControl.call(sessionID, path, init) as Promise<A>,
        catch: (error) =>
          error instanceof SessionPeerControl.PeerError && error.status === 404
            ? notFound(error.message)
            : new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
      })
    const peerStop = Effect.fn("ExperimentalHttpApi.peerStop")(function* (ctx: { params: { sessionID: string } }) {
      return Boolean(yield* peer<boolean>(ctx.params.sessionID, "/stop", { method: "POST" }))
    })
    const peerAsks = Effect.fn("ExperimentalHttpApi.peerAsks")(function* (ctx: { params: { sessionID: string } }) {
      return yield* peer<typeof PeerAsks.Type>(ctx.params.sessionID, "/asks")
    })
    const peerPermissionReply = Effect.fn("ExperimentalHttpApi.peerPermissionReply")(function* (ctx: {
      params: { sessionID: string; requestID: string }
      payload: { reply: string; message?: string }
    }) {
      return Boolean(
        yield* peer<boolean>(ctx.params.sessionID, `/permission/${ctx.params.requestID}/reply`, {
          method: "POST",
          body: ctx.payload,
        }),
      )
    })
    const peerQuestionReply = Effect.fn("ExperimentalHttpApi.peerQuestionReply")(function* (ctx: {
      params: { sessionID: string; requestID: string }
      payload: { answers: ReadonlyArray<unknown> }
    }) {
      return Boolean(
        yield* peer<boolean>(ctx.params.sessionID, `/question/${ctx.params.requestID}/reply`, {
          method: "POST",
          body: ctx.payload,
        }),
      )
    })
    const peerQuestionReject = Effect.fn("ExperimentalHttpApi.peerQuestionReject")(function* (ctx: {
      params: { sessionID: string; requestID: string }
    }) {
      return Boolean(
        yield* peer<boolean>(ctx.params.sessionID, `/question/${ctx.params.requestID}/reject`, { method: "POST" }),
      )
    })

    // XCOD-262: the Agent Monitor's prompts. A session another live Lunos runs is that process's to
    // drive, so it is refused here and goes through peerPrompt.
    const promptText = (text: string) =>
      text.trim() && text.length <= SessionPromptQueue.MAX_TEXT
        ? Effect.succeed(text)
        : Effect.fail(new InvalidRequestError({ message: "A prompt is non-empty text of at most 100,000 characters." }))
    const notDrivenElsewhere = (sessionID: string) => {
      const peer = SessionPeers.read().get(sessionID)
      return peer?.fresh && (peer.status || peer.permissions > 0 || peer.questions > 0 || peer.queued)
        ? Effect.fail(
            new InvalidRequestError({
              message: "Another Lunos on this computer runs that session; the prompt goes to it.",
            }),
          )
        : Effect.void
    }
    const agentOf = Effect.fn("ExperimentalHttpApi.agentOf")(function* (info: Session.Info) {
      const lastUser = yield* sessions
        .findMessage(info.id, (message) => message.info.role === "user")
        .pipe(Effect.orElseSucceed(() => Option.none()))
      return SessionPromptQueue.agentFor(
        info,
        Option.isSome(lastUser) ? (lastUser.value.info as { agent?: string }).agent : undefined,
      )
    })
    const sessionEnqueue = Effect.fn("ExperimentalHttpApi.sessionEnqueue")(function* (ctx: {
      params: { sessionID: string }
      payload: typeof SessionEnqueuePayload.Type
    }) {
      const text = yield* promptText(ctx.payload.text)
      const sessionID = SessionID.make(ctx.params.sessionID)
      const info = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.fail(notFound("No such session."))))
      yield* notDrivenElsewhere(sessionID)
      // Prompts a stopped Lunos queued for it go first, and only once the user has taken it over.
      const orphaned = SessionPeers.orphans().get(sessionID)
      if (orphaned)
        return yield* new InvalidRequestError({
          message: `A Lunos that closed queued ${orphaned} prompt(s) for this session that haven't been sent. Take the session over first, sending or discarding them.`,
        })
      const agent = yield* agentOf(info)
      return yield* Effect.tryPromise({
        try: () =>
          SessionPromptQueue.submit({
            sessionID,
            directory: info.directory,
            text,
            ...(agent ? { agent } : {}),
            ...(ctx.payload.model ? { model: ctx.payload.model } : {}),
            ...(ctx.payload.variant ? { variant: ctx.payload.variant } : {}),
            interrupt: ctx.payload.interrupt === true,
            via: ctx.payload.via ?? "local",
          }),
        catch: (error) => new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })
    // XCOD-262: the user confirmed "Take over this session here?"; the prompts its stopped Lunos
    // queued are sent or discarded, then the new prompt runs.
    const sessionTakeover = Effect.fn("ExperimentalHttpApi.sessionTakeover")(function* (ctx: {
      params: { sessionID: string }
      payload: typeof SessionTakeoverPayload.Type
    }) {
      const text = ctx.payload.text === undefined ? undefined : yield* promptText(ctx.payload.text)
      const sessionID = SessionID.make(ctx.params.sessionID)
      const info = yield* sessions.get(sessionID).pipe(Effect.catch(() => Effect.fail(notFound("No such session."))))
      yield* notDrivenElsewhere(sessionID)
      const agent = yield* agentOf(info)
      return yield* Effect.tryPromise({
        try: () =>
          SessionPromptQueue.takeover({
            sessionID,
            directory: info.directory,
            queued: ctx.payload.queued,
            ...(text !== undefined ? { text } : {}),
            ...(agent ? { agent } : {}),
            ...(text !== undefined && ctx.payload.request ? { request: ctx.payload.request } : {}),
            ...(ctx.payload.origin ? { origin: ctx.payload.origin } : {}),
          }),
        catch: (error) => new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
      })
    })
    const sessionQueued = Effect.fn("ExperimentalHttpApi.sessionQueued")(function* (ctx: {
      params: { sessionID: string }
    }) {
      return {
        orphaned: SessionPromptQueue.orphaned(ctx.params.sessionID),
        held: SessionPromptQueue.held(ctx.params.sessionID),
      }
    })
    const peerPrompt = Effect.fn("ExperimentalHttpApi.peerPrompt")(function* (ctx: {
      params: { sessionID: string }
      payload: { text: string; interrupt?: boolean }
    }) {
      const text = yield* promptText(ctx.payload.text)
      return yield* peer<{ delivery: SessionPromptQueue.Delivery; position?: number }>(
        ctx.params.sessionID,
        "/prompt",
        {
          method: "POST",
          body: { text, interrupt: ctx.payload.interrupt === true },
        },
      )
    })

    const resource = Effect.fn("ExperimentalHttpApi.resource")(function* () {
      return yield* mcp.resources()
    })

    return handlers
      .handle("capabilities", capabilities)
      .handle("console", getConsole)
      .handle("consoleOrgs", listConsoleOrgs)
      .handle("consoleSwitch", switchConsole)
      .handle("tool", tool)
      .handle("toolIDs", toolIDs)
      .handle("worktree", worktree)
      .handle("worktreeCreate", worktreeCreate)
      .handle("worktreeRemove", worktreeRemove)
      .handle("worktreeReset", worktreeReset)
      .handle("session", session)
      .handle("sessionBackground", sessionBackground)
      .handle("backgroundJobs", backgroundJobs)
      .handle("artifacts", artifacts)
      .handle("backgroundJobCancel", backgroundJobCancel)
      .handle("sessionOverview", sessionOverview)
      .handle("sessionBulkStop", sessionBulkStop)
      .handle("sessionBulkArchive", sessionBulkArchive)
      .handle("sessionBulkUnarchive", sessionBulkUnarchive)
      .handle("sessionBulkDelete", sessionBulkDelete)
      .handle("sessionBulkPreview", sessionBulkPreview)
      .handle("sessionGroupList", sessionGroupList)
      .handle("sessionGroupCreate", sessionGroupCreate)
      .handle("sessionGroupUpdate", sessionGroupUpdate)
      .handle("sessionGroupDelete", sessionGroupDelete)
      .handle("sessionGroupMove", sessionGroupMove)
      .handle("externalStop", externalStop)
      .handle("externalTools", externalTools)
      .handle("externalModels", externalModels)
      .handle("externalModel", externalModel)
      .handle("externalConsent", externalConsent)
      .handle("peerStop", peerStop)
      .handle("peerAsks", peerAsks)
      .handle("peerPermissionReply", peerPermissionReply)
      .handle("peerQuestionReply", peerQuestionReply)
      .handle("peerQuestionReject", peerQuestionReject)
      .handle("sessionEnqueue", sessionEnqueue)
      .handle("sessionTakeover", sessionTakeover)
      .handle("sessionQueued", sessionQueued)
      .handle("peerPrompt", peerPrompt)
      .handle("resource", resource)
  }),
)
