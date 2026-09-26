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
