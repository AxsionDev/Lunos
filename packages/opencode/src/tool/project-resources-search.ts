import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./project-resources-search.txt"
import { Resource } from "@/resource"

// XCOD-300: Search-mode project resources, indexed on this computer. Offered only while the project
// has at least one (ToolRegistry.tools); results are wrapped as reference material and cite their source.

export const ID = "project_resources_search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "What to look for" }),
  resources: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Only these resources, by name. Default: every searchable resource",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Most passages to return (1-10). Default 5" }),
})

type Metadata = { count: number; tokens: number }

export const ProjectResourcesSearchTool = Tool.define<typeof Parameters, Metadata, Resource.Service>(
  ID,
  Effect.gen(function* () {
    const resources = yield* Resource.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({ permission: ID, patterns: [params.query], always: ["*"], metadata: {} })
          const result = yield* resources.search({
            query: params.query,
            sessionID: ctx.sessionID,
            limit: params.limit,
            resources: params.resources,
          })
          return {
            title: `${result.count} passage${result.count === 1 ? "" : "s"} from project resources`,
            output: result.text || "Nothing in the project's resources matches. Try other words.",
            metadata: { count: result.count, tokens: result.tokens },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
