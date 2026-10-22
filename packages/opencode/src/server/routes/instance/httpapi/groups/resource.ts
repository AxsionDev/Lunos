import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQueryFields } from "../middleware/workspace-routing"
import { described } from "./metadata"

// XCOD-300: what the sidebar's Context section and /context read: the project's resources with
// their status, a per-session exclude, and the last turn's context breakdown.
const root = "/resource"

export const ResourceItem = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(["path", "url", "git", "mcp", "reference"]),
  mode: Schema.Literals(["always", "search", "on_demand"]),
  scope: Schema.Literals(["shared", "personal", "user", "organisation"]),
  description: Schema.optional(Schema.String),
  target: Schema.String,
  readOnly: Schema.Boolean,
  trusted: Schema.Boolean,
  excluded: Schema.Boolean,
  problem: Schema.optional(Schema.String),
  state: Schema.String.annotate({ description: 'e.g. "indexed 2 h ago · 143 chunks"' }),
  tokens: Schema.optional(Schema.Finite).annotate({ description: "Estimated tokens of the whole resource" }),
  chunks: Schema.optional(Schema.Finite),
  indexedAt: Schema.optional(Schema.Finite),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "ResourceItem" })

export const ResourceContext = Schema.Struct({
  time: Schema.Finite,
  system: Schema.Finite,
  instructions: Schema.Finite,
  always: Schema.Finite,
  memory: Schema.Finite,
  attachments: Schema.Finite,
  searched: Schema.Finite,
  mentioned: Schema.Finite,
  resources: Schema.Array(Schema.Struct({ name: Schema.String, tokens: Schema.Finite })),
  dropped: Schema.Array(Schema.Struct({ name: Schema.String, tokens: Schema.Finite, reason: Schema.String })),
}).annotate({ identifier: "ResourceContext" })

export const ResourceExcludeInput = Schema.Struct({
  sessionID: Schema.String,
  name: Schema.String,
  excluded: Schema.Boolean,
})

export const ResourceApi = HttpApi.make("resource").add(
  HttpApiGroup.make("resource")
    .add(
      HttpApiEndpoint.get("list", root, {
        query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.optional(Schema.String) }),
        success: described(Schema.Array(ResourceItem), "The project's resources"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "resource.list",
          summary: "List project resources",
          description: "The project's resources with mode, scope, size and index status. Doesn't index anything.",
        }),
      ),
      HttpApiEndpoint.post("exclude", `${root}/exclude`, {
        query: Schema.Struct(WorkspaceRoutingQueryFields),
        payload: ResourceExcludeInput,
        success: described(Schema.Boolean, "Whether the resource is now excluded"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "resource.exclude",
          summary: "Exclude a resource for a session",
          description: "Leave a resource out of one session's context, or put it back.",
        }),
      ),
      HttpApiEndpoint.get("context", `${root}/context`, {
        query: Schema.Struct({ ...WorkspaceRoutingQueryFields, sessionID: Schema.String }),
        success: described(Schema.NullOr(ResourceContext), "The last turn's context, in tokens"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "resource.context",
          summary: "Context breakdown",
          description:
            "What the session's last turn sent as context, in estimated tokens: system prompt, instructions, Always resources, memory, attachments and searched resources.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "resource", description: "Project resources (XCOD-300)." }))
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
