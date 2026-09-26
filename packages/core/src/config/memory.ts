export * as ConfigMemory from "./memory"

import { Schema } from "effect"

/**
 * Graph-based long-term memory (XCOD-94). Off unless `enabled` is true. Declared in both the v1
 * and v2 config schemas, so the live config path keeps it (the XCOD-68 / XCOD-93 lesson).
 */
export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Turn on long-term memory (off by default). LUNOS_DISABLE_MEMORY=1 turns it off regardless of this setting",
  }),
  scope: Schema.Array(Schema.Literals(["project", "user"]))
    .pipe(Schema.optional)
    .annotate({
      description:
        'Where memory is kept: "project" (.opencode/memory/graph/ in the project) and/or "user" (the Lunos data directory). Default ["project"]',
    }),
  model: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Model that extracts facts and relationships when something is remembered: "inherit" (the main agent\'s model), "small" (small_model, the default) or "provider/model". Checked against the residency policy before memory starts',
  }),
  embedding: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Embedding model: "local" (the default; computed on this machine, no network call after the one-time model download). Provider embeddings are not supported yet',
  }),
  retrieval: Schema.Struct({
    max_tokens: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
      description: "Most tokens of recalled memory added to a turn (default 1500)",
    }),
  })
    .pipe(Schema.optional)
    .annotate({ description: "How much memory is recalled into a turn" }),
  limits: Schema.Struct({
    max_facts: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
      description: "Most facts kept per scope (default 5000). Remembering more is refused",
    }),
    max_fact_chars: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
      description: "Longest single fact, in characters (default 2000)",
    }),
  })
    .pipe(Schema.optional)
    .annotate({ description: "Size caps" }),
}).annotate({ identifier: "MemoryConfig" })
export type Info = Schema.Schema.Type<typeof Info>
