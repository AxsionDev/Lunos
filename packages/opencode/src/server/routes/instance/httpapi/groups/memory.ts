import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import {
  MemoryImportRefusedError,
  MemoryNotFoundError,
  MemoryPassphraseRequiredError,
  MemoryUnavailableError,
} from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
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
  importedFrom: Schema.optional(Schema.String).annotate({
    description: "Imported facts only (XCOD-133): import:<file>#<sha256> it came in from",
  }),
  originSource: Schema.optional(Schema.String).annotate({
    description: "Imported facts only: where it first came from",
  }),
  originDate: Schema.optional(Schema.String).annotate({ description: "Imported facts only: when it was first saved" }),
  state: Schema.Literals(["active", "outdated", "expired", "purge", "quarantined"]).annotate({
    description:
      "XCOD-136: active (recalled), outdated, expired (not recalled; deleted after the grace period), purge (due for deletion) or quarantined (failed the ledger's integrity check)",
  }),
  kind: Schema.optional(Schema.Literals(["observed", "inferred"])),
  validFrom: Schema.optional(Schema.String),
  invalidAt: Schema.optional(Schema.String).annotate({ description: "Outdated facts: when it stopped being true" }),
  replacedBy: Schema.optional(Schema.String).annotate({ description: "Outdated facts: the fact that replaced it" }),
  replaces: Schema.optional(Schema.String),
  expires: Schema.optional(Schema.String).annotate({ description: "When it expires, if it does" }),
  quarantined: Schema.optional(Schema.String).annotate({ description: "Why the integrity check quarantined it" }),
}).annotate({ identifier: "MemoryFact" })

export const MemoryOutdateQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  by: Schema.optional(Schema.String).annotate({ description: "The id of the active fact that replaces it" }),
})

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
    description:
      "Where to write: the bundle path (default: memory/exports/ in the data directory), or the directory for markdown",
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

// XCOD-133: the TUI's Import action. Preview first; apply re-reads and re-plans on the server, so
// the client only ever names rows by key and never supplies fact text.
export const MemoryImportInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "A bundle folder, .zip or .zip.enc, a Markdown file or folder, or another agent's memory file",
  }),
  scope: Schema.optional(Schema.Literals(["project", "user"])).annotate({
    description: "Put everything in this memory (default: each bundle fact's own scope; project for Markdown)",
  }),
  asFacts: Schema.optional(Schema.Boolean).annotate({
    description: "Import AGENTS.md, CLAUDE.md, Claude Code memory and bundle notes as facts instead of notes",
  }),
  passphrase: Schema.optional(Schema.String).annotate({
    description: "For an encrypted bundle. Never stored or echoed back",
  }),
}).annotate({ identifier: "MemoryImportInput" })

export const MemoryImportApplyInput = Schema.Struct({
  ...MemoryImportInput.fields,
  accept: Schema.Array(Schema.String).annotate({
    description: "Keys of the preview rows to write. Rejected rows and exact duplicates are never written",
  }),
}).annotate({ identifier: "MemoryImportApplyInput" })

export const MemoryImportRow = Schema.Struct({
  key: Schema.String,
  kind: Schema.Literals(["fact", "note"]),
  scope: Schema.Literals(["project", "user"]),
  status: Schema.Literals(["new", "duplicate", "conflict", "rejected"]),
  reason: Schema.String,
  text: Schema.String,
  file: Schema.String,
  note: Schema.optional(Schema.String),
  near: Schema.optional(Schema.Boolean).annotate({ description: "A near-duplicate: written only if approved" }),
  otherID: Schema.optional(Schema.String),
  otherText: Schema.optional(Schema.String).annotate({ description: "What it duplicates or contradicts" }),
}).annotate({ identifier: "MemoryImportRow" })

export const MemoryImportPreview = Schema.Struct({
  kind: Schema.Literals(["bundle", "markdown"]),
  label: Schema.String,
  sha256: Schema.String,
  format: Schema.optional(Schema.String),
  encrypted: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
  rows: Schema.Array(MemoryImportRow),
  counts: Schema.Struct({
    new: Schema.Number,
    duplicate: Schema.Number,
    conflict: Schema.Number,
    rejected: Schema.Number,
  }),
  limit: Schema.optional(Schema.String).annotate({
    description: "Set when importing would pass memory.limits.max_facts: nothing can be imported",
  }),
  extractionModel: Schema.String,
  extractionCalls: Schema.Number,
  embedding: Schema.String,
  remoteEmbeddingCalls: Schema.Number,
}).annotate({ identifier: "MemoryImportPreview" })

export const MemoryImportResult = Schema.Struct({
  facts: Schema.Number,
  noteParagraphs: Schema.Number,
  notes: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.Struct({ text: Schema.String, reason: Schema.String })),
}).annotate({ identifier: "MemoryImportResult" })

// XCOD-252: /memory's Analytics, computed locally from the ledger and the local audit log.
const Count = Schema.Finite
const MemoryStatsCounts = Schema.Struct({
  active: Count,
  outdated: Count,
  expiring: Count,
  expired: Count,
  quarantined: Count,
})
export const MemoryStatsResponse = Schema.Struct({
  version: Schema.Finite,
  generatedAt: Schema.String,
  rangeDays: Schema.NullOr(Schema.Finite),
  since: Schema.NullOr(Schema.String),
  status: Schema.Struct({
    on: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
    backend: Schema.Struct({
      type: Schema.String,
      host: Schema.NullOr(Schema.String),
      jurisdiction: Schema.NullOr(Schema.String),
    }),
    encryption: Schema.String,
    retentionDays: Schema.NullOr(Schema.Finite),
    graceDays: Schema.Number,
    health: Schema.mutable(
      Schema.Array(
        Schema.Struct({
          scope: Schema.String,
          facts: Count,
          problems: Count,
          unsealed: Count,
          encrypted: Count,
          error: Schema.NullOr(Schema.String),
        }),
      ),
    ),
  }),
  scopes: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        scope: Schema.String,
        counts: MemoryStatsCounts,
        lastWrite: Schema.NullOr(Schema.String),
        error: Schema.NullOr(Schema.String),
        chars: Count,
        tokens: Count,
      }),
    ),
  ),
  maxTokens: Count,
  sources: Schema.Struct({
    source: Schema.Record(Schema.String, Count),
    agent: Schema.Record(Schema.String, Count),
    kind: Schema.Record(Schema.String, Count),
    native: Count,
    imported: Schema.Record(Schema.String, Count),
  }),
  growth: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        week: Schema.String,
        scope: Schema.String,
        added: Count,
        outdated: Count,
        forgotten: Count,
        expired: Count,
      }),
    ),
  ),
  recall: Schema.Struct({
    audit: Schema.Boolean,
    dataSince: Schema.NullOr(Schema.String),
    total: Count,
    perDay: Schema.mutable(Schema.Array(Schema.Struct({ day: Schema.String, count: Count }))),
    origin: Schema.Record(Schema.String, Count),
    hitRate: Schema.NullOr(Schema.Finite),
    avgFacts: Schema.NullOr(Schema.Finite),
    truncatedRate: Schema.NullOr(Schema.Finite),
  }),
  top: Schema.mutable(Schema.Array(Schema.Struct({ id: Schema.String, count: Count, last: Schema.String }))),
  supersession: Schema.Struct({
    count: Count,
    chains: Schema.mutable(Schema.Array(Schema.mutable(Schema.Array(Schema.String)))),
  }),
  facts: Schema.Record(Schema.String, Schema.Struct({ recalls: Count, last: Schema.String })),
  groups: Schema.Record(Schema.String, Schema.mutable(Schema.Array(Schema.String))),
}).annotate({ identifier: "MemoryStats" })

// XCOD-249: the setup wizard checks what it is about to save, before saving it.
export const MemorySetupInput = Schema.Struct({
  memory: Schema.Record(Schema.String, Schema.Unknown).annotate({
    description: "The memory block the wizard would save (memory.enabled, model, backend, retention, encryption)",
  }),
}).annotate({ identifier: "MemorySetupInput" })

export const MemorySetupBackendResult = Schema.Struct({
  ok: Schema.Boolean,
  warnings: Schema.mutable(Schema.Array(Schema.String)),
  error: Schema.optional(Schema.String),
}).annotate({ identifier: "MemorySetupBackendResult" })

export const MemorySetupCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  scope: Schema.optional(Schema.String),
  ms: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  fix: Schema.optional(Schema.String),
}).annotate({ identifier: "MemorySetupCheckResult" })

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.get("stats", `${root}/stats`, {
          query: Schema.Struct({
            ...WorkspaceRoutingQueryFields,
            scope: Schema.optional(Schema.Literals(["project", "user"])),
            days: Schema.optional(Schema.NumberFromString),
          }),
          success: described(MemoryStatsResponse, "Memory analytics"),
          error: [MemoryUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.stats",
            summary: "Memory analytics",
            description:
              "What's in memory, where it came from, how it grows and which facts are recalled, computed locally from the ledger and the local audit log. Never starts memory; `days` limits the time-based figures (default: all).",
          }),
        ),
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: described(MemoryList, "Stored facts, with provenance"),
          error: [MemoryUnavailableError],
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
        HttpApiEndpoint.post("importPreview", `${root}/import/preview`, {
          payload: MemoryImportInput,
          query: WorkspaceRoutingQuery,
          success: described(MemoryImportPreview, "What the import would do; nothing is written"),
          error: [MemoryImportRefusedError, MemoryPassphraseRequiredError, MemoryUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.importPreview",
            summary: "Preview a memory import",
            description:
              "Read and verify a bundle, Markdown or another agent's memory file, screen every fact with the write guard, and show each as new, duplicate, conflict or rejected. Writes nothing.",
          }),
        ),
        HttpApiEndpoint.post("importApply", `${root}/import`, {
          payload: MemoryImportApplyInput,
          query: WorkspaceRoutingQuery,
          success: described(MemoryImportResult, "What was imported"),
          error: [MemoryImportRefusedError, MemoryPassphraseRequiredError, MemoryUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.import",
            summary: "Import memory",
            description:
              "Import the approved rows of a preview. The input is read, verified and screened again; only rows named in accept are written.",
          }),
        ),
        HttpApiEndpoint.post("outdate", `${root}/:id/outdate`, {
          params: { id: Schema.String },
          query: MemoryOutdateQuery,
          success: described(Schema.Boolean, "Fact marked outdated"),
          error: [HttpApiError.BadRequest, MemoryNotFoundError, MemoryUnavailableError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.outdate",
            summary: "Mark a fact outdated",
            description:
              "Mark a fact as no longer true, optionally replaced by another. It is kept, but no longer recalled.",
          }),
        ),
        HttpApiEndpoint.post("setupBackend", `${root}/setup/backend`, {
          payload: MemorySetupInput,
          query: WorkspaceRoutingQuery,
          success: described(MemorySetupBackendResult, "Whether that memory database may be used"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.setup.backend",
            summary: "Check a memory database",
            description:
              "Run the checks Lunos makes before connecting to an external memory database (URL, TLS, credentials by reference, jurisdiction against the residency policy) on a proposed memory block. Connects to nothing.",
          }),
        ),
        HttpApiEndpoint.post("setupCheck", `${root}/setup/check`, {
          payload: MemorySetupInput,
          query: WorkspaceRoutingQuery,
          success: described(MemorySetupCheckResult, "The check's result"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.setup.check",
            summary: "Check memory works",
            description:
              "Remember, recall and remove a test fact with a proposed memory block, in a separate Lunos process (memory settings apply on restart). The first run downloads the engine's packages and embedding model.",
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
