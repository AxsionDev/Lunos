export * as ConfigMemory from "./memory"

import { Schema } from "effect"
import { ConfigMemorySource } from "./memory-source"

/**
 * An external memory database (XCOD-134). Credentials must be `{env:…}` or `{file:…}` references:
 * a literal password is refused when the config is loaded (checked on the text before substitution).
 */
export const Backend = Schema.Struct({
  type: Schema.Literals(["embedded", "neo4j", "memgraph"]).pipe(Schema.optional).annotate({
    description:
      '"embedded" (the default: memory on this machine), "neo4j", or "memgraph" (experimental, not supported yet: refused when memory starts)',
  }),
  url: Schema.String.pipe(Schema.optional).annotate({
    description:
      "The database's Bolt URL, e.g. bolt+s://graph.internal:7687. Plain bolt:// or neo4j:// is only allowed to localhost, unless allow_insecure is set",
  }),
  database: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Database name. Default: the server's default database (Neo4j Community has only one). Project and user memory are kept apart inside it",
  }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: 'Database user, as "{env:VAR}" or "{file:path}"',
  }),
  password: Schema.String.pipe(Schema.optional).annotate({
    description: 'Database password, as "{env:VAR}" or "{file:path}". A literal password is refused',
  }),
  jurisdiction: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Where the database runs, e.g. "EU-DE" or "US". Required for an external database; checked against the residency policy before any connection',
  }),
  read_only: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Recall only: nothing is written, and the remember tool isn't offered to the model",
  }),
  allow_insecure: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Allow an unencrypted bolt:// or neo4j:// connection to a host that isn't localhost. Credentials and facts then cross the network in clear text",
  }),
  user: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Who you are in a shared database, for user memory (stored only as a hash). Default: a random id kept in the Lunos data directory, so user memory is per machine unless you set this",
  }),
}).annotate({ identifier: "MemoryBackendConfig" })

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
  sources: Schema.mutable(Schema.Array(ConfigMemorySource.Info)).pipe(Schema.optional).annotate({
    description:
      "External, read-only memory sources (XCOD-135): a knowledge graph or an MCP memory server recalled alongside local memory. Their results are untrusted reference, labelled with the source and never stored locally",
  }),
  retention: Schema.Struct({
    days: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
      description:
        "Facts expire this many days after they were saved (default: never). Hand-written notes never expire. Expired facts are not recalled, and are deleted after grace_days",
    }),
    grace_days: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(Schema.optional).annotate({
      description: "Days an expired fact is kept, not recalled, before it is deleted (default 7)",
    }),
  })
    .pipe(Schema.optional)
    .annotate({ description: "How long facts are kept" }),
  encryption: Schema.Literals(["off", "os-keychain"]).pipe(Schema.optional).annotate({
    description:
      'Encrypt the provenance ledger (facts.jsonl) with a key kept in the OS keychain: "os-keychain", or "off" (the default). The memory engine\'s own database files are not encrypted; use full-disk encryption for those',
  }),
  backend: Backend.pipe(Schema.optional).annotate({
    description:
      'Where memory is stored (XCOD-134): "embedded" (the default; on this machine) or an external graph database your team runs',
  }),
}).annotate({ identifier: "MemoryConfig" })
export type Info = Schema.Schema.Type<typeof Info>
