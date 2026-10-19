import { AccountID, OrgID } from "@/account/schema"
import { MCP } from "@/mcp"
import { Question } from "@/question"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"

import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Worktree } from "@/worktree"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { described } from "./metadata"
import { ApiNotFoundError, InvalidRequestError } from "../errors"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const ConsoleStateResponse = Schema.Struct({
  consoleManagedProviders: Schema.mutable(Schema.Array(Schema.String)),
  activeOrgName: Schema.optionalKey(Schema.String),
  switchableOrgCount: NonNegativeInt,
}).annotate({ identifier: "ConsoleState" })

const CapabilitiesResponse = Schema.Struct({
  backgroundSubagents: Schema.Boolean,
}).annotate({ identifier: "ExperimentalCapabilities" })

// XCOD-82: one background subagent job, as the monitoring surfaces show it.
export const BackgroundJobItem = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  startedAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
  elapsedMs: Schema.Number,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelRule: Schema.optional(Schema.String),
  parentSessionID: Schema.optional(Schema.String),
  sessionID: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "BackgroundJobItem" })

// XCOD-84: a plan, research note or dev-cycle record an agent wrote. The file is the source of truth.
export const ArtifactItem = Schema.Struct({
  kind: Schema.Literals(["plan", "research", "dev-cycle"]),
  title: Schema.String,
  path: Schema.String,
  created: Schema.Number,
}).annotate({ identifier: "ArtifactItem" })

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

export const ConsoleSwitchPayload = Schema.Struct({
  accountID: AccountID,
  orgID: OrgID,
})

const ToolIDs = Schema.Array(Schema.String).annotate({ identifier: "ToolIDs" })
const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
}).annotate({ identifier: "ToolListItem" })
const ToolList = Schema.Array(ToolListItem).annotate({ identifier: "ToolList" })
export const ToolListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  provider: ProviderV2.ID,
  model: ModelV2.ID,
})

const WorktreeList = Schema.Array(Schema.String)
const WorktreeErrorName = Schema.Union([
  Schema.Literal("WorktreeNotGitError"),
  Schema.Literal("WorktreeNameGenerationFailedError"),
  Schema.Literal("WorktreeCreateFailedError"),
  Schema.Literal("WorktreeStartCommandFailedError"),
  Schema.Literal("WorktreeRemoveFailedError"),
  Schema.Literal("WorktreeResetFailedError"),
  Schema.Literal("WorktreeListFailedError"),
])
export class WorktreeApiError extends Schema.ErrorClass<WorktreeApiError>("WorktreeError")(
  {
    name: WorktreeErrorName,
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
export const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  cursor: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
  archived: Schema.optional(QueryBoolean),
})

// XCOD-205: a user-defined group of sessions, kept on this machine only.
export const SessionGroupInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.optional(Schema.String),
  collapsed: Schema.Boolean,
  created: Schema.Finite,
  updated: Schema.Finite,
}).annotate({ identifier: "SessionGroup" })

// XCOD-250: what /claude and /codex show before anything starts.
export const ExternalToolStatus = Schema.Struct({
  tool: Schema.Literals(["claude", "codex"]),
  label: Schema.String,
  installed: Schema.Boolean,
  loggedIn: Schema.optional(Schema.Boolean),
  /** What to do when it isn't usable (install, sign in, update). */
  hint: Schema.optional(Schema.String),
  refused: Schema.optional(
    Schema.Struct({ reason: Schema.Literals(["disabled", "policy", "residency"]), message: Schema.String }),
  ),
  /** XCOD-256: Claude Code's `--permission-mode` choices, from this install's `--help`. */
  permissionModes: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  /** XCOD-254: the answer to sharing Lunos's tools, skills and memory with it in this project, if given. */
  consent: Schema.optional(Schema.Literals(["share", "never"])),
}).annotate({ identifier: "ExternalToolStatus" })

// XCOD-254: /settings → External sessions changes the answer; "ask" forgets it (asked next session).
export const ExternalConsentPayload = Schema.Struct({
  tool: Schema.Literals(["claude", "codex"]),
  answer: Schema.Literals(["share", "never", "ask"]),
})

// XCOD-254: /models in a Claude Code or Codex session lists the tool's models.
export const ExternalModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  default: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "ExternalModel" })

export const ExternalModels = Schema.Struct({
  tool: Schema.Literals(["claude", "codex"]),
  label: Schema.String,
  /** The model chosen for this session, if one was. */
  current: Schema.optional(Schema.String),
  models: Schema.mutable(Schema.Array(ExternalModel)),
  /** The tool didn't list its models; these are its aliases. */
  fallback: Schema.Boolean,
  /** Why the tool's models can't be listed (not installed, refused by policy, no answer). */
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "ExternalModels" })

export const ExternalModelPayload = Schema.Struct({
  /** Omitted goes back to the tool's default. */
  model: Schema.optional(Schema.String),
})

// XCOD-205: one row of the Sessions window.
export const SessionOverviewItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["session", "subagent", "scheduled", "external"]),
  title: Schema.String,
  directory: Schema.String,
  project: Schema.optional(Session.ProjectInfo),
  parentID: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  tool: Schema.optional(Schema.String),
  cost: Schema.Finite,
  created: Schema.Finite,
  updated: Schema.Finite,
  state: Schema.Literals(["running", "waiting", "idle", "finished", "failed"]),
  elsewhere: Schema.optional(Schema.Boolean),
  stale: Schema.optional(Schema.Boolean),
  permissions: NonNegativeInt,
  questions: NonNegativeInt,
  queued: Schema.optional(NonNegativeInt),
  groupID: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.Finite),
}).annotate({ identifier: "SessionOverviewItem" })

// XCOD-265: "Show archived" lists only the sessions cleared from the list.
export const SessionOverviewQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  archived: Schema.optional(QueryBoolean),
})

export const SessionOverviewResponse = Schema.Struct({
  groups: Schema.mutable(Schema.Array(SessionGroupInfo)),
  sessions: Schema.mutable(Schema.Array(SessionOverviewItem)),
}).annotate({ identifier: "SessionOverview" })

export const SessionGroupCreatePayload = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.String),
})

export const SessionGroupUpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  /** An empty string clears the colour. */
  color: Schema.optional(Schema.String),
  collapsed: Schema.optional(Schema.Boolean),
})

export const SessionGroupMovePayload = Schema.Struct({
  sessionIDs: Schema.mutable(Schema.Array(Schema.String)),
  /** Omitted moves the sessions back to Ungrouped. */
  groupID: Schema.optional(Schema.String),
})

// XCOD-265: Stop all, Clear list (archive), Unarchive and Delete archived.
export const SessionBulkPayload = Schema.Struct({
  sessionIDs: Schema.mutable(Schema.Array(Schema.String)),
})
export const SessionBulkStopPayload = Schema.Struct({
  sessionIDs: Schema.mutable(Schema.Array(Schema.String)),
  /** What the sessions' pending approvals are rejected with. Defaults to "Stopped from /sessions". */
  reason: Schema.optional(Schema.String),
})
export const SessionBulkArchivePayload = Schema.Struct({
  sessionIDs: Schema.mutable(Schema.Array(Schema.String)),
  /** "Stop all & clear": stop the running and waiting ones first, then archive everything stopped. */
  stop: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
})
const SessionBulkFailure = Schema.Struct({ id: Schema.String, reason: Schema.String }).annotate({
  identifier: "SessionBulkFailure",
})
export const SessionBulkStopResult = Schema.Struct({
  stopped: Schema.mutable(Schema.Array(Schema.String)),
  failed: Schema.mutable(Schema.Array(SessionBulkFailure)),
}).annotate({ identifier: "SessionBulkStopResult" })
export const SessionBulkArchiveResult = Schema.Struct({
  archived: Schema.mutable(Schema.Array(Schema.String)),
  skipped: Schema.mutable(Schema.Array(SessionBulkFailure)),
  stopped: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  failed: Schema.optional(Schema.mutable(Schema.Array(SessionBulkFailure))),
}).annotate({ identifier: "SessionBulkArchiveResult" })
export const SessionBulkDeleteResult = Schema.Struct({
  deleted: Schema.mutable(Schema.Array(Schema.String)),
  skipped: Schema.mutable(Schema.Array(SessionBulkFailure)),
}).annotate({ identifier: "SessionBulkDeleteResult" })

export const ExperimentalPaths = {
  capabilities: "/experimental/capabilities",
  console: "/experimental/console",
  consoleOrgs: "/experimental/console/orgs",
  consoleSwitch: "/experimental/console/switch",
  tool: "/experimental/tool",
  toolIDs: "/experimental/tool/ids",
  worktree: "/experimental/worktree",
  worktreeReset: "/experimental/worktree/reset",
  session: "/experimental/session",
  sessionBackground: "/experimental/session/:sessionID/background",
  backgroundJobs: "/experimental/background",
  artifacts: "/experimental/artifact",
  backgroundJobCancel: "/experimental/background/:jobID/cancel",
  resource: "/experimental/resource",
  sessionOverview: "/experimental/session-overview",
  sessionGroups: "/experimental/session-group",
  sessionGroup: "/experimental/session-group/:groupID",
  sessionGroupMove: "/experimental/session-group/move",
  sessionBulkStop: "/experimental/session-bulk/stop",
  sessionBulkArchive: "/experimental/session-bulk/archive",
  sessionBulkUnarchive: "/experimental/session-bulk/unarchive",
  sessionBulkDelete: "/experimental/session-bulk/delete",
  externalStop: "/experimental/external/:sessionID/stop",
  externalTools: "/experimental/external/tools",
  externalModels: "/experimental/external/:sessionID/models",
  externalModel: "/experimental/external/:sessionID/model",
  externalConsent: "/experimental/external/consent",
  peerStop: "/experimental/peer/:sessionID/stop",
  peerAsks: "/experimental/peer/:sessionID/asks",
  peerPermissionReply: "/experimental/peer/:sessionID/permission/:requestID/reply",
  peerQuestionReply: "/experimental/peer/:sessionID/question/:requestID/reply",
  peerQuestionReject: "/experimental/peer/:sessionID/question/:requestID/reject",
  sessionEnqueue: "/experimental/session/:sessionID/enqueue",
  peerPrompt: "/experimental/peer/:sessionID/prompt",
} as const

// XCOD-234: what another Lunos process's session is waiting for.
export const PeerAsks = Schema.Struct({
  permissions: Schema.mutable(Schema.Array(PermissionV1.Request)),
  questions: Schema.mutable(Schema.Array(Question.Request)),
}).annotate({ identifier: "SessionPeerAsks" })

// XCOD-262: a prompt from the Agent Monitor to an existing session. Text only.
export const SessionEnqueuePayload = Schema.Struct({
  text: Schema.String,
  interrupt: Schema.optional(Schema.Boolean),
  via: Schema.optional(Schema.Literals(["local", "peer"])),
  /** A session the monitor just started: the model picked there. Not forwarded by peer.prompt. */
  model: Schema.optional(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
  variant: Schema.optional(Schema.String),
})

export const SessionEnqueueResult = Schema.Struct({
  delivery: Schema.Literals(["now", "queued", "interrupted", "answered"]),
  position: Schema.optional(NonNegativeInt),
}).annotate({ identifier: "SessionEnqueueResult" })

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("capabilities", ExperimentalPaths.capabilities, {
          query: WorkspaceRoutingQuery,
          success: described(CapabilitiesResponse, "Experimental capabilities"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.capabilities.get",
            summary: "Get experimental capabilities",
            description: "Get experimental features enabled on the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleStateResponse, "Active Console provider metadata"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          query: WorkspaceRoutingQuery,
          success: described(ConsoleOrgList, "Switchable Console orgs"),
          error: HttpApiError.InternalServerError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          query: WorkspaceRoutingQuery,
          payload: ConsoleSwitchPayload,
          success: described(Schema.Boolean, "Switch success"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: described(ToolList, "Tools"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIDs", ExperimentalPaths.toolIDs, {
          query: WorkspaceRoutingQuery,
          success: described(ToolIDs, "Tool IDs"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("worktree", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          success: described(WorktreeList, "List of worktree directories"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          disableCodecs: true,
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Worktree.CreateInput],
          success: described(Worktree.Info, "Worktree created"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.RemoveInput,
          success: described(Schema.Boolean, "Worktree removed"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          query: WorkspaceRoutingQuery,
          payload: Worktree.ResetInput,
          success: described(Schema.Boolean, "Worktree reset"),
          error: WorktreeApiError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: described(Schema.Array(Session.GlobalInfo), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List sessions",
            description:
              "Get a list of all OpenCode sessions across projects, sorted by most recently updated. Archived sessions are excluded by default.",
          }),
        ),
        HttpApiEndpoint.post("sessionBackground", ExperimentalPaths.sessionBackground, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Backgrounded subagents"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.background",
            summary: "Background subagents",
            description:
              "Detach any synchronous subagents currently blocking the session and continue them in the background.",
          }),
        ),
        HttpApiEndpoint.get("artifacts", ExperimentalPaths.artifacts, {
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            kind: Schema.optional(Schema.Literals(["plan", "research", "dev-cycle"])),
          }),
          success: described(Schema.Array(ArtifactItem), "Plans, research notes and dev-cycle records"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.artifact.list",
            summary: "List artifacts",
            description:
              "List this project's plans, research notes and dev-cycle records, newest first. Pass kind to list one kind.",
          }),
        ),
        HttpApiEndpoint.get("backgroundJobs", ExperimentalPaths.backgroundJobs, {
          query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.optional(Schema.String) }),
          success: described(Schema.Array(BackgroundJobItem), "Background subagent jobs"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.background.list",
            summary: "List background subagents",
            description:
              "List subagent jobs with status, elapsed time, agent and resolved model. Pass sessionID to list only that session's jobs.",
          }),
        ),
        HttpApiEndpoint.post("backgroundJobCancel", ExperimentalPaths.backgroundJobCancel, {
          params: { jobID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Whether a running job was cancelled"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.background.cancel",
            summary: "Cancel a background subagent",
            description: "Cancel a running background subagent job and its child session.",
          }),
        ),
        HttpApiEndpoint.get("sessionOverview", ExperimentalPaths.sessionOverview, {
          query: SessionOverviewQuery,
          success: described(SessionOverviewResponse, "Sessions on this machine, with their groups"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.overview",
            summary: "Sessions overview",
            description:
              "Every session on this machine that is running, waiting for an answer or was active in the last week, across all projects, with its state, kind and group, plus the session groups. Archived sessions are left out; with archived=true only they are listed, however old.",
          }),
        ),
        HttpApiEndpoint.post("sessionBulkStop", ExperimentalPaths.sessionBulkStop, {
          query: WorkspaceRoutingQuery,
          payload: SessionBulkStopPayload,
          success: described(SessionBulkStopResult, "Which sessions stopped, and why the others didn't"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionBulk.stop",
            summary: "Stop sessions",
            description:
              "Stop several sessions at once: Lunos sessions here or in another Lunos on this machine, and Claude Code / Codex sessions. Pending approvals are rejected with the reason first. Audited as session.stop.",
          }),
        ),
        HttpApiEndpoint.post("sessionBulkArchive", ExperimentalPaths.sessionBulkArchive, {
          query: WorkspaceRoutingQuery,
          payload: SessionBulkArchivePayload,
          success: described(SessionBulkArchiveResult, "Which sessions were archived"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionBulk.archive",
            summary: "Archive sessions",
            description:
              "Hide sessions from every list without deleting anything. Running and waiting sessions are skipped unless stop is set, which stops them first. Audited as session.archive.",
          }),
        ),
        HttpApiEndpoint.post("sessionBulkUnarchive", ExperimentalPaths.sessionBulkUnarchive, {
          query: WorkspaceRoutingQuery,
          payload: SessionBulkPayload,
          success: described(SessionBulkArchiveResult, "Which sessions were restored"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionBulk.unarchive",
            summary: "Unarchive sessions",
            description: "Put archived sessions back in the lists. Audited as session.archive (unarchive).",
          }),
        ),
        HttpApiEndpoint.post("sessionBulkDelete", ExperimentalPaths.sessionBulkDelete, {
          query: WorkspaceRoutingQuery,
          payload: SessionBulkPayload,
          success: described(SessionBulkDeleteResult, "Which archived sessions were deleted"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionBulk.delete",
            summary: "Delete archived sessions",
            description:
              "Delete archived sessions and their history for good. Sessions that aren't archived are skipped. Audited as session.delete.",
          }),
        ),
        HttpApiEndpoint.get("sessionGroupList", ExperimentalPaths.sessionGroups, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.mutable(Schema.Array(SessionGroupInfo)), "Session groups"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionGroup.list",
            summary: "List session groups",
            description: "List the session groups on this machine.",
          }),
        ),
        HttpApiEndpoint.post("sessionGroupCreate", ExperimentalPaths.sessionGroups, {
          query: WorkspaceRoutingQuery,
          payload: SessionGroupCreatePayload,
          success: described(SessionGroupInfo, "Created session group"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionGroup.create",
            summary: "Create session group",
            description: "Create a session group, with an optional colour (#rrggbb).",
          }),
        ),
        HttpApiEndpoint.post("sessionGroupMove", ExperimentalPaths.sessionGroupMove, {
          query: WorkspaceRoutingQuery,
          payload: SessionGroupMovePayload,
          success: described(Schema.Boolean, "Sessions moved"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionGroup.move",
            summary: "Move sessions to a group",
            description:
              "Put sessions in a group, taking them out of any other group. Without a groupID they go back to Ungrouped.",
          }),
        ),
        HttpApiEndpoint.patch("sessionGroupUpdate", ExperimentalPaths.sessionGroup, {
          params: { groupID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SessionGroupUpdatePayload,
          success: described(SessionGroupInfo, "Updated session group"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionGroup.update",
            summary: "Update session group",
            description: "Rename, recolour (an empty colour clears it), collapse or expand a session group.",
          }),
        ),
        HttpApiEndpoint.delete("sessionGroupDelete", ExperimentalPaths.sessionGroup, {
          params: { groupID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Session group deleted"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.sessionGroup.delete",
            summary: "Delete session group",
            description: "Delete a session group. Its sessions are not deleted or stopped; they go back to Ungrouped.",
          }),
        ),
        HttpApiEndpoint.get("externalTools", ExperimentalPaths.externalTools, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.mutable(Schema.Array(ExternalToolStatus)), "External tools"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.external.tools",
            summary: "External tools",
            description:
              "Whether Claude Code and Codex CLI can be started from Lunos here: installed, signed in, and allowed by external.enabled and the residency policy. Asking doesn't audit anything.",
          }),
        ),
        HttpApiEndpoint.post("externalStop", ExperimentalPaths.externalStop, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "External session stopped"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.external.stop",
            summary: "Stop an external session",
            description:
              "Stop a running Claude Code or Codex session Lunos started (as lunos external stop), from any Lunos process on this machine.",
          }),
        ),
        HttpApiEndpoint.get("externalModels", ExperimentalPaths.externalModels, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(ExternalModels, "The tool's models"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.external.models",
            summary: "External session models",
            description:
              "The models Claude Code or Codex offers for an external session, asked from the tool without a prompt (no model is called), and the one chosen for the session.",
          }),
        ),
        HttpApiEndpoint.post("externalModel", ExperimentalPaths.externalModel, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: ExternalModelPayload,
          success: described(Schema.Boolean, "Model saved"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.external.model",
            summary: "Choose an external session's model",
            description:
              "Save the model Claude Code or Codex uses in an external session from its next turn on (resumes included). Omit it to go back to the tool's default.",
          }),
        ),
        HttpApiEndpoint.post("externalConsent", ExperimentalPaths.externalConsent, {
          query: WorkspaceRoutingQuery,
          payload: ExternalConsentPayload,
          success: described(Schema.Boolean, "Answer saved"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.external.consent",
            summary: "Share Lunos with Claude Code or Codex",
            description:
              "Whether Lunos's MCP servers, skills and memory are offered to Claude Code or Codex sessions in this project (share), never offered without asking (never), or asked about in the next session (ask). Kept on this machine, never in config. Audited as external.consent.",
          }),
        ),
        HttpApiEndpoint.post("peerStop", ExperimentalPaths.peerStop, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Stopped"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.peer.stop",
            summary: "Stop a session another Lunos runs",
            description: "Stop a session that another Lunos process on this machine is running, through that process.",
          }),
        ),
        HttpApiEndpoint.get("peerAsks", ExperimentalPaths.peerAsks, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(PeerAsks, "Pending permissions and questions"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.peer.asks",
            summary: "What a session another Lunos runs is waiting for",
            description:
              "The pending permission requests and questions of a session another Lunos process on this machine runs.",
          }),
        ),
        HttpApiEndpoint.post("peerPermissionReply", ExperimentalPaths.peerPermissionReply, {
          params: { sessionID: Schema.String, requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ reply: PermissionV1.Reply, message: Schema.optional(Schema.String) }),
          success: described(Schema.Boolean, "Answered"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.peer.permissionReply",
            summary: "Answer a permission request in another Lunos",
            description:
              "Answer a permission request of a session another Lunos process on this machine runs. That process checks and audits the answer.",
          }),
        ),
        HttpApiEndpoint.post("peerQuestionReply", ExperimentalPaths.peerQuestionReply, {
          params: { sessionID: Schema.String, requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ answers: Schema.Array(Question.Answer) }),
          success: described(Schema.Boolean, "Answered"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.peer.questionReply",
            summary: "Answer a question in another Lunos",
            description: "Answer a question of a session another Lunos process on this machine runs.",
          }),
        ),
        HttpApiEndpoint.post("peerQuestionReject", ExperimentalPaths.peerQuestionReject, {
          params: { sessionID: Schema.String, requestID: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Dismissed"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.peer.questionReject",
            summary: "Dismiss a question in another Lunos",
            description: "Dismiss a question of a session another Lunos process on this machine runs.",
          }),
        ),
        HttpApiEndpoint.post("sessionEnqueue", ExperimentalPaths.sessionEnqueue, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: SessionEnqueuePayload,
          success: described(SessionEnqueueResult, "How the prompt was delivered"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.enqueue",
            summary: "Send a prompt to a session from the Agent Monitor",
            description:
              "Run a prompt as the session's next turn: now when it is idle, after the current turn when it is busy (or now, stopping the turn, with interrupt), or as the answer to its one open question. A prompt never answers a permission request. Refused when another Lunos process runs the session; use experimental.peer.prompt.",
          }),
        ),
        HttpApiEndpoint.post("peerPrompt", ExperimentalPaths.peerPrompt, {
          params: { sessionID: Schema.String },
          query: WorkspaceRoutingQuery,
          payload: Schema.Struct({ text: Schema.String, interrupt: Schema.optional(Schema.Boolean) }),
          success: described(SessionEnqueueResult, "How the prompt was delivered"),
          error: [InvalidRequestError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.peer.prompt",
            summary: "Send a prompt to a session another Lunos runs",
            description:
              "Send a prompt to a session that another Lunos process on this machine runs. That process runs it, with its own agent, policy and audit, as experimental.session.enqueue does.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Record(Schema.String, MCP.Resource), "MCP resources"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "Experimental HttpApi read-only routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
