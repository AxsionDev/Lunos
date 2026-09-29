import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { MemoryNotFoundError, MemoryUnavailableError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

// XCOD-94: what the TUI memory browser reads. `list` reads the provenance ledger only and never
// starts memory; `related` and `forget` start it.
const root = "/memory"

export const MemoryFact = Schema.Struct({
  id: Schema.String,
  scope: Schema.Literals(["project", "user"]),
  text: Schema.String,
  sessionID: Schema.String,
  agent: Schema.String,
  source: Schema.String,
  date: Schema.String,
}).annotate({ identifier: "MemoryFact" })

export const MemoryList = Schema.Struct({
  on: Schema.Boolean.annotate({ description: "Whether memory is on" }),
  reason: Schema.optional(Schema.String).annotate({ description: "Why memory is off, when it is" }),
  facts: Schema.Array(MemoryFact),
}).annotate({ identifier: "MemoryList" })

// XCOD-132: the TUI's Export action. The same options as `lunos memory export`.
export const MemoryExportInput = Schema.Struct({
  format: Schema.optional(Schema.Literals(["bundle", "markdown"])),
  scope: Schema.optional(Schema.Literals(["project", "user", "both"])),
  since: Schema.optional(Schema.String).annotate({ description: "Only facts saved on or after this date" }),
  zip: Schema.optional(Schema.Boolean),
  passphrase: Schema.optional(Schema.String).annotate({
    description: "Encrypt the bundle with this passphrase (implies zip). Never stored or echoed back",
  }),
  graph: Schema.optional(Schema.Boolean).annotate({ description: "Include the entity graph (default true)" }),
  includeIndex: Schema.optional(Schema.Boolean),
  out: Schema.optional(Schema.String).annotate({
    description: "Where to write: the bundle path, or the directory for markdown",
  }),
}).annotate({ identifier: "MemoryExportInput" })

export const MemoryExportResult = Schema.Struct({
  path: Schema.String,
  format: Schema.Literals(["bundle", "markdown"]),
  facts: Schema.Number,
  notes: Schema.Number,
  entities: Schema.Number,
  relations: Schema.Number,
  graph: Schema.Boolean,
  encrypted: Schema.Boolean,
  decrypt: Schema.optional(Schema.String).annotate({ description: "The command that decrypts an encrypted bundle" }),
}).annotate({ identifier: "MemoryExportResult" })

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(MemoryList, "Stored facts, with provenance"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.list",
            summary: "List memory",
            description: "List facts in long-term memory with where each came from. Does not start memory.",
          }),
        ),
        HttpApiEndpoint.get("related", `${root}/:id/related`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Schema.String), "Relationships between entities around this fact"),
          error: [MemoryNotFoundError, MemoryUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.related",
            summary: "Fact connections",
            description: "Entities and relationships in the memory graph around one fact.",
          }),
        ),
        HttpApiEndpoint.post("export", `${root}/export`, {
          payload: MemoryExportInput,
          query: WorkspaceRoutingQuery,
          success: described(MemoryExportResult, "Where the export was written, and what it holds"),
          error: [HttpApiError.BadRequest, MemoryUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.export",
            summary: "Export memory",
            description:
              "Export long-term memory as a versioned bundle (facts, graph, notes, provenance), or as one Markdown file per fact.",
          }),
        ),
        HttpApiEndpoint.post("forget", `${root}/:id/forget`, {
          params: { id: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Fact forgotten"),
          error: [HttpApiError.BadRequest, MemoryNotFoundError, MemoryUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.forget",
            summary: "Forget a fact",
            description: "Remove one fact from long-term memory.",
          }),
        ),
      )
      .annotateMerge(OpenApi.annotations({ title: "memory", description: "Long-term memory routes." }))
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )
