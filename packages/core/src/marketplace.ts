export * as Marketplace from "./marketplace"

import { Schema } from "effect"

export class Owner extends Schema.Class<Owner>("Marketplace.Owner")({
  name: Schema.String,
  email: Schema.String.pipe(Schema.optional),
  url: Schema.String.pipe(Schema.optional),
}) {}

export class NpmSource extends Schema.Class<NpmSource>("Marketplace.NpmSource")({
  type: Schema.Literal("npm"),
  package: Schema.String,
  version: Schema.String.pipe(Schema.optional),
}) {}

export class GithubSource extends Schema.Class<GithubSource>("Marketplace.GithubSource")({
  type: Schema.Literal("github"),
  repo: Schema.String.annotate({
    description: "GitHub repository in 'org/name' form.",
  }),
  ref: Schema.String.pipe(Schema.optional).annotate({
    description: "Branch, tag, or commit to install from. Defaults to the repository's default branch.",
  }),
}) {}

// v1 supports exactly these two source types. Deliberately no archive, command,
// or git-subdir sources, and no cross-marketplace dependencies — see
// packages/opencode/specs/marketplace-manifest.md.
export const Source = Schema.Union([NpmSource, GithubSource]).pipe(Schema.toTaggedUnion("type"))
export type Source = typeof Source.Type

export class Entry extends Schema.Class<Entry>("Marketplace.Entry")({
  name: Schema.String,
  source: Source,
  description: Schema.String.pipe(Schema.optional),
  version: Schema.String.pipe(Schema.optional),
  author: Schema.String.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  tags: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}

// MCP servers are a SIBLING array, never entries in `plugins[]`. Validation fails the whole
// manifest rather than one row, so an MCP row wearing an unsupported `source.type` would break
// `marketplace add`, `plugin list`, `plugin search` and Discover for every user of that source.
//
// `environment` and `headers` are arrays of variable NAMES, deliberately unlike ConfigMCPV1's
// Record<string, string>. The manifest describes what a server needs and never carries a value,
// so a file published at a public URL cannot express a credential.
export class McpLocalEntry extends Schema.Class<McpLocalEntry>("Marketplace.McpLocalEntry")({
  name: Schema.String,
  type: Schema.Literal("local"),
  command: Schema.String.pipe(Schema.Array).annotate({
    description: "Command and arguments that start the server, e.g. ['npx', '-y', 'pkg'].",
  }),
  environment: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Names of environment variables the server requires. Never values.",
  }),
  cwd: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  tags: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}

export class McpRemoteEntry extends Schema.Class<McpRemoteEntry>("Marketplace.McpRemoteEntry")({
  name: Schema.String,
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Names of headers the server requires. Never values.",
  }),
  description: Schema.String.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  tags: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}

export const McpEntry = Schema.Union([McpLocalEntry, McpRemoteEntry]).pipe(Schema.toTaggedUnion("type"))
export type McpEntry = typeof McpEntry.Type

// A skill entry is a skill SOURCE, not one skill: `url` is a base URL serving `index.json`, and
// installing it appends that URL to config `skills.urls`, which pulls every skill the index
// lists. Config has no per-skill filter, so the manifest can't honestly describe a single skill.
export class SkillEntry extends Schema.Class<SkillEntry>("Marketplace.SkillEntry")({
  name: Schema.String,
  url: Schema.String.annotate({
    description: "Base URL of a skill source serving index.json, as accepted by config skills.urls.",
  }),
  description: Schema.String.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  tags: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}

// `event` is a plain String, NOT ConfigHooks.Event. A literal union here would make an older
// Lunos reject the whole manifest -- every plugin in it -- the day a marketplace publishes a hook
// for an event it doesn't know. The event is checked against ConfigHooks.Event at install time.
// `environment` holds variable NAMES only, for the same reason as the MCP entries above.
export class HookEntry extends Schema.Class<HookEntry>("Marketplace.HookEntry")({
  name: Schema.String,
  event: Schema.String,
  command: Schema.String.pipe(Schema.Array),
  matcher: Schema.Struct({
    tool: Schema.String.pipe(Schema.optional),
    file: Schema.String.pipe(Schema.optional),
  }).pipe(Schema.optional),
  environment: Schema.String.pipe(Schema.Array, Schema.optional).annotate({
    description: "Names of environment variables the hook requires. Never values.",
  }),
  timeout: Schema.Number.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  category: Schema.String.pipe(Schema.optional),
  tags: Schema.String.pipe(Schema.Array, Schema.optional),
}) {}

// The four content kinds a manifest can carry, each in its own typed array below. Parallel
// arrays rather than one `kind`-tagged list: `plugins` predates the others and is required, and
// an older client simply ignores arrays it doesn't know.
export const Kind = Schema.Literals(["plugin", "skill", "hook", "mcp"])
export type Kind = typeof Kind.Type
export const KINDS: readonly Kind[] = ["plugin", "skill", "hook", "mcp"]

export class Manifest extends Schema.Class<Manifest>("Marketplace.Manifest")({
  $schema: Schema.String.pipe(Schema.optional).annotate({
    description: "JSON schema reference for manifest validation",
  }),
  name: Schema.String,
  owner: Owner,
  description: Schema.String.pipe(Schema.optional),
  version: Schema.String.pipe(Schema.optional),
  plugins: Entry.pipe(Schema.Array),
  mcp: McpEntry.pipe(Schema.Array, Schema.optional),
  skills: SkillEntry.pipe(Schema.Array, Schema.optional),
  hooks: HookEntry.pipe(Schema.Array, Schema.optional),
}) {}

export const decode = Schema.decodeUnknownSync(Manifest)
