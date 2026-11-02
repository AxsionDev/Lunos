import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import semver from "semver"
import { described } from "./metadata"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  // Omitted means "the latest published Lunos release", which is what the TUI's /upgrade asks for.
  target: Schema.optional(
    Schema.String.check(
      Schema.makeFilter((value) => (semver.valid(value) === null ? "Expected a semantic version" : undefined)),
    ),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

// XCOD-312: what this machine was last told about the Lunos account being disabled (CloudDisabled):
// the reason category and the end, never the free-text reason. No `disabled` when it isn't, or where
// this start needs no Lunos account.
const GlobalAccount = Schema.Struct({
  disabled: Schema.optional(
    Schema.Struct({
      category: Schema.optional(Schema.Literals(["abuse", "security", "terms", "payment", "offboarding", "other"])),
      until: Schema.optional(Schema.String),
    }),
  ),
}).annotate({ identifier: "GlobalAccount" })

// XCOD-318: the desktop and web app's Feedback button. Sent on to Lunos Cloud with this machine's
// sign-in (CloudBeta.feedback): the text, an optional screenshot, the version and OS, and the session
// id only with `consent: true`. Never a transcript: there is no field for one.
export const GlobalFeedbackInput = Schema.Struct({
  text: Schema.String,
  source: Schema.Literals(["app", "desktop"]),
  consent: Schema.Boolean,
  sessionId: Schema.optional(Schema.String),
  os: Schema.optional(Schema.String),
  screenshot: Schema.optional(Schema.Struct({ type: Schema.String, data: Schema.String })),
}).annotate({ identifier: "GlobalFeedbackInput" })

const GlobalFeedbackResult = Schema.Union([
  Schema.Struct({ success: Schema.Literal(true), sessionShared: Schema.Boolean }),
  Schema.Struct({ success: Schema.Literal(false), error: Schema.String }),
]).annotate({ identifier: "GlobalFeedbackResult" })

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  account: "/global/account",
  feedback: "/global/feedback",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.get("account", GlobalPaths.account, {
        success: described(GlobalAccount, "The Lunos account's state on this machine"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.account.get",
          summary: "Get the Lunos account's state",
          description:
            "Whether this machine was told the Lunos account is disabled, with the reason category and the end date. Reads this machine's record only.",
        }),
      ),
      HttpApiEndpoint.post("feedback", GlobalPaths.feedback, {
        payload: GlobalFeedbackInput,
        success: described(GlobalFeedbackResult, "Whether Lunos Cloud took the feedback"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.feedback",
          summary: "Send feedback to the Lunos team",
          description:
            "Sends feedback to Lunos Cloud with this machine's sign-in: the text, an optional screenshot, the Lunos version and OS, and the session id only when consent is true. Never a transcript.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade Lunos",
          description: "Upgrade Lunos to the specified version, or to the latest release when no target is given.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
