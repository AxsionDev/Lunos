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

export class Manifest extends Schema.Class<Manifest>("Marketplace.Manifest")({
  $schema: Schema.String.pipe(Schema.optional).annotate({
    description: "JSON schema reference for manifest validation",
  }),
  name: Schema.String,
  owner: Owner,
  description: Schema.String.pipe(Schema.optional),
  version: Schema.String.pipe(Schema.optional),
  plugins: Entry.pipe(Schema.Array),
}) {}

export const decode = Schema.decodeUnknownSync(Manifest)
