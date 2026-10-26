export * as ConfigResource from "./resource"

import { Schema } from "effect"

/**
 * Project resources (XCOD-300): files, folders, repositories, web pages and MCP resources the agent
 * gets as context in every session of the project. Declared in both the v1 and v2 config schemas,
 * so the live config path keeps it. Shared resources live in the project's config; personal ones
 * are kept on this computer (`lunos resource add --personal`), and an organisation's come from
 * managed config, read-only (lock them with `"$locked": ["resources"]`).
 */
export const Mode = Schema.Literals(["always", "search", "on_demand"]).annotate({
  description:
    '"always": in every session\'s context, within resources.always_tokens. "search" (default): indexed on this computer, and the agent pulls in the relevant parts with project_resources_search. "on_demand": only when a prompt mentions @name',
})
export type Mode = typeof Mode.Type

const description = Schema.String.pipe(Schema.optional).annotate({
  description: "What the resource is for, shown to the agent",
})
const globs = Schema.mutable(Schema.Array(Schema.String)).pipe(Schema.optional)

export const Path = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "A file or folder on this computer. In a project's config it must be inside the project: anything else is a personal resource",
  }),
  include: globs.annotate({ description: 'Globs of files to include, relative to the folder. Default ["**/*"]' }),
  exclude: globs.annotate({ description: "Globs of files to leave out, relative to the folder" }),
  description,
  mode: Mode.pipe(Schema.optional),
})

export const Url = Schema.Struct({
  url: Schema.String.annotate({ description: "A web page or docs site (http or https)" }),
  depth: Schema.Literals([0, 1, 2]).pipe(Schema.optional).annotate({
    description: "How many links deep to follow on the same site. Default 0 (the page only)",
  }),
  description,
  mode: Mode.pipe(Schema.optional),
})

export const Git = Schema.Struct({
  repository: Schema.String.annotate({ description: "A git repository URL, cloned on this computer" }),
  branch: Schema.String.pipe(Schema.optional).annotate({ description: "Branch or tag. Default: the remote default" }),
  include: globs.annotate({ description: 'Globs of files to include. Default ["**/*"]' }),
  exclude: globs.annotate({ description: "Globs of files to leave out" }),
  description,
  mode: Mode.pipe(Schema.optional),
})

export const Mcp = Schema.Struct({
  server: Schema.String.annotate({ description: "A connected MCP server's name" }),
  uri: Schema.String.annotate({ description: "The resource's URI on that server" }),
  description,
  mode: Mode.pipe(Schema.optional),
})

export const Entry = Schema.Union([Path, Url, Git, Mcp])
export type Entry = typeof Entry.Type

export const Info = Schema.Struct({
  entries: Schema.Record(Schema.String, Entry).pipe(Schema.optional).annotate({
    description: "Resources by name. The name is also the resource's @alias in prompts",
  }),
  always_tokens: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: 'Most tokens "always" resources may add to every session\'s context. Default 8000',
  }),
  max_resource_mb: Schema.Number.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: "Largest a single resource may be. Default 50",
  }),
  max_index_mb: Schema.Number.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: "Largest the project's resource index may grow. Default 1024",
  }),
  refresh_hours: Schema.Number.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: "How often web, git and MCP resources are fetched again. Default 24",
  }),
  web: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Allow web page resources. Default true; an organisation can turn them off in managed config",
  }),
})
export type Info = typeof Info.Type
