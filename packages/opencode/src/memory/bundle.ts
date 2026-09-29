export * as MemoryBundle from "./bundle"

import crypto from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { BlobReader, BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip.js/zip.js"
import { MemoryGuard } from "./guard"
import { MemoryNotes } from "./notes"
import type { MemoryStore } from "./store"

/**
 * The memory bundle (XCOD-132): everything in long-term memory, in a versioned, documented form
 * that another machine, another engine or another tool can read without Lunos.
 *
 * - `facts.jsonl` is the source of truth: every fact with its full provenance. An importer
 *   (XCOD-133) remembers these again and lets the engine rebuild its graph and embeddings.
 * - `graph.json` is derived from the facts: the entities and relationships the engine extracted,
 *   each pointing at the fact ids it came from. It is there to review, to verify, and to seed an
 *   external graph store, not to be trusted over the facts.
 * - Embeddings and engine databases are left out unless asked for (`--include-index`): they are
 *   model- and engine-specific and rebuilt on import.
 *
 * `SCHEMA.md`, written into every bundle, documents all of this and carries the JSON Schema.
 */

export const FORMAT = "lunos-memory/1"
export const ENGINE = "cognee"

/** PBKDF2 rounds for `--encrypt`. Written into SCHEMA.md and the docs' decrypt command. */
export const ITERATIONS = 600_000

// ---------------------------------------------------------------------------------------------
// The engine's raw graph, as the sidecar's `graph` tool returns it.

export interface RawNode {
  id: string
  type: string
  name: string
  description: string
}

export interface RawEdge {
  source: string
  target: string
  relationship: string
}

export interface RawGraph {
  nodes: RawNode[]
  edges: RawEdge[]
}

// ---------------------------------------------------------------------------------------------
// What goes in the bundle.

export type Kind = "observed" | "inferred"

export interface Fact {
  id: string
  scope: MemoryStore.Scope
  text: string
  /** "active" for every fact until the lifecycle story adds "outdated". */
  status: "active" | "outdated"
  /** "observed" for a person's own words (hand-written notes); null where Lunos can't tell. */
  kind: Kind | null
  provenance: MemoryStore.Provenance
  /** The engine's own ids, for a same-engine restore. Importers into anything else ignore them. */
  engine: { name: string; datasetID: string }
}

export interface Entity {
  /** `<scope>:<engine id>`: the engine derives ids from names, so the same name can be in both scopes. */
  id: string
  scope: MemoryStore.Scope
  name: string
  type: string
  description: string
  /** Ids of the facts this entity was extracted from, all present in facts.jsonl. */
  facts: string[]
}

export interface Relation {
  scope: MemoryStore.Scope
  /** Entity ids in this file. */
  source: string
  target: string
  relationship: string
  facts: string[]
}

export interface Graph {
  entities: Entity[]
  relations: Relation[]
}

export interface FileEntry {
  path: string
  bytes: number
  sha256: string
}

export interface Manifest {
  format: typeof FORMAT
  lunos: { version: string }
  created: string
  scopes: MemoryStore.Scope[]
  filters: { since: string | null }
  counts: {
    facts: { total: number; project: number; user: number; fromNotes: number }
    notes: number
    entities: number
    relations: number
  }
  graph: { included: boolean; engine: string; reason?: string }
  index: {
    included: boolean
    engine?: string
    engineVersion?: string
    embedding?: { model: string; dimensions: number }
    scopes?: MemoryStore.Scope[]
  }
  files: FileEntry[]
}

export function fact(scope: MemoryStore.Scope, input: MemoryStore.Fact): Fact {
  return {
    id: input.id,
    scope,
    text: input.text,
    status: "active",
    kind: input.provenance.sessionID === MemoryNotes.SESSION ? "observed" : null,
    provenance: {
      sessionID: input.provenance.sessionID,
      agent: input.provenance.agent,
      source: input.provenance.source,
      date: input.provenance.date,
    },
    engine: { name: ENGINE, datasetID: input.datasetID },
  }
}

/**
 * Entities and relationships from the engine's graph, each tied to the facts it came from. In
 * Cognee a fact is a TextDocument whose id is the fact id; its chunk `contains` the entities
 * extracted from it, and each entity `is_a` an EntityType. An entity's facts are the documents of
 * the chunks that contain it. A relationship's facts are those both ends share (it was extracted
 * from a chunk holding both); if they share none, the union. Anything tied to a fact that isn't in
 * `known` (forgotten, or filtered out with `--since`) is dropped, so every id in the result is in
 * facts.jsonl.
 */
export function graph(scope: MemoryStore.Scope, raw: RawGraph, known: ReadonlySet<string>): Graph {
  const nodes = new Map(raw.nodes.map((node) => [node.id, node]))
  const typeOf = (id: string) => nodes.get(id)?.type
  const documentOf = new Map<string, string>()
  const typeName = new Map<string, string>()
  const contains: [string, string][] = []
  const between: RawEdge[] = []
  for (const edge of raw.edges) {
    const from = typeOf(edge.source)
    const to = typeOf(edge.target)
    if (from === "DocumentChunk" && to === "TextDocument" && edge.relationship === "is_part_of")
      documentOf.set(edge.source, edge.target)
    else if (from === "DocumentChunk" && to === "Entity") contains.push([edge.source, edge.target])
    else if (from === "Entity" && to === "EntityType") typeName.set(edge.source, nodes.get(edge.target)!.name)
    else if (from === "Entity" && to === "Entity") between.push(edge)
  }
  const factsOf = new Map<string, Set<string>>()
  for (const [chunk, entity] of contains) {
    const document = documentOf.get(chunk)
    if (!document || !known.has(document)) continue
    const set = factsOf.get(entity) ?? new Set<string>()
    set.add(document)
    factsOf.set(entity, set)
  }
  const key = (id: string) => `${scope}:${id}`
  const entities: Entity[] = []
  for (const node of raw.nodes) {
    const facts = factsOf.get(node.id)
    if (node.type !== "Entity" || !facts?.size) continue
    entities.push({
      id: key(node.id),
      scope,
      name: node.name,
      type: typeName.get(node.id) ?? "",
      description: node.description,
      facts: [...facts].toSorted(),
    })
  }
  const relations: Relation[] = []
  const seen = new Set<string>()
  for (const edge of between) {
    const a = factsOf.get(edge.source)
    const b = factsOf.get(edge.target)
    if (!a?.size || !b?.size) continue
    const id = `${edge.source}\n${edge.relationship}\n${edge.target}`
    if (seen.has(id)) continue
    seen.add(id)
    const shared = [...a].filter((item) => b.has(item))
    relations.push({
      scope,
      source: key(edge.source),
      target: key(edge.target),
      relationship: edge.relationship,
      facts: (shared.length ? shared : [...new Set([...a, ...b])]).toSorted(),
    })
  }
  return { entities, relations }
}

// ---------------------------------------------------------------------------------------------
// Secrets.

/**
 * The write guard's secret check, run again over everything the bundle would hold. Writes are
 * already guarded, so this should find nothing; if it does, the export stops and names what
 * matched instead of copying it out.
 */
export function secrets(input: { facts: Fact[]; graph: Graph; notes: { name: string; text: string }[] }) {
  const found: string[] = []
  for (const item of input.facts) if (MemoryGuard.secret(item.text)) found.push(item.id)
  for (const entity of input.graph.entities)
    if (MemoryGuard.secret(`${entity.name}\n${entity.description}`)) found.push(entity.id)
  for (const note of input.notes) if (MemoryGuard.secret(note.text)) found.push(`notes/${note.name}`)
  return found
}

export class SecretsError extends Error {
  override name = "MemoryExportSecrets"
  constructor(readonly ids: string[]) {
    super(
      `Nothing was exported: ${ids.length} item(s) look like they hold a key, token, password or a {env:}/{file:} substitution. Forget or edit them, then export again:\n${ids.map((id) => `  ${id}`).join("\n")}`,
    )
  }
}

// ---------------------------------------------------------------------------------------------
// Building and writing.

/** A file in the bundle: its bytes, or a file on disk to copy (engine databases can be large). */
export type Entry = { path: string; data: Uint8Array } | { path: string; source: string }

const encoder = new TextEncoder()

export function text(file: string, content: string): Entry {
  return { path: file, data: encoder.encode(content) }
}

async function digest(entry: Entry): Promise<FileEntry> {
  const hash = crypto.createHash("sha256")
  if ("data" in entry) {
    hash.update(entry.data)
    return { path: entry.path, bytes: entry.data.byteLength, sha256: hash.digest("hex") }
  }
  let bytes = 0
  for await (const chunk of createReadStream(entry.source) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    bytes += chunk.byteLength
  }
  return { path: entry.path, bytes, sha256: hash.digest("hex") }
}

export interface Content {
  version: string
  created: Date
  scopes: MemoryStore.Scope[]
  since?: Date
  facts: Fact[]
  graph: Graph
  /** Set when the graph was left out, with why. */
  graphOmitted?: string
  notes: { name: string; text: string }[]
  /** Engine database files, with their path inside the bundle (under `index/<scope>/`). */
  index?: {
    scopes: MemoryStore.Scope[]
    files: { path: string; source: string }[]
    engineVersion: string
    embedding: { model: string; dimensions: number }
  }
}

/** Every file of the bundle, manifest last, with the manifest itself. */
export async function entries(content: Content): Promise<{ entries: Entry[]; manifest: Manifest }> {
  const body: Entry[] = [
    text("SCHEMA.md", schemaMarkdown()),
    text("facts.jsonl", content.facts.map((item) => JSON.stringify(item) + "\n").join("")),
    text("graph.json", JSON.stringify(content.graph, null, 2) + "\n"),
    ...content.notes.map((note) => text(`notes/${note.name}`, note.text)),
    ...(content.index?.files ?? []),
  ]
  const files: FileEntry[] = []
  for (const entry of body) files.push(await digest(entry))
  const count = (scope: MemoryStore.Scope) => content.facts.filter((item) => item.scope === scope).length
  const manifest: Manifest = {
    format: FORMAT,
    lunos: { version: content.version },
    created: content.created.toISOString(),
    scopes: content.scopes,
    filters: { since: content.since?.toISOString() ?? null },
    counts: {
      facts: {
        total: content.facts.length,
        project: count("project"),
        user: count("user"),
        fromNotes: content.facts.filter((item) => item.provenance.sessionID === MemoryNotes.SESSION).length,
      },
      notes: content.notes.length,
      entities: content.graph.entities.length,
      relations: content.graph.relations.length,
    },
    graph: content.graphOmitted
      ? { included: false, engine: ENGINE, reason: content.graphOmitted }
      : { included: true, engine: ENGINE },
    index: content.index
      ? {
          included: true,
          engine: ENGINE,
          engineVersion: content.index.engineVersion,
          embedding: content.index.embedding,
          scopes: content.index.scopes,
        }
      : { included: false },
    files,
  }
  return { entries: [...body, text("manifest.json", JSON.stringify(manifest, null, 2) + "\n")], manifest }
}

async function missing(file: string) {
  return fs.stat(file).then(
    () => false,
    () => true,
  )
}

/**
 * Write the bundle to `out`: a directory, or with `zip` a `.zip` file, or with a passphrase an
 * encrypted `.zip.enc` file. Written beside `out` first and renamed into place, so a failed export
 * never leaves half a bundle. Refuses to overwrite.
 */
export async function write(input: { entries: Entry[]; out: string; zip: boolean; passphrase?: string }) {
  if (!(await missing(input.out))) throw new Error(`${input.out} already exists; choose another --out`)
  await fs.mkdir(path.dirname(input.out), { recursive: true })
  const staging = `${input.out}.partial-${crypto.randomBytes(4).toString("hex")}`
  try {
    if (!input.zip && input.passphrase === undefined) {
      for (const entry of input.entries) {
        const target = path.join(staging, ...entry.path.split("/"))
        await fs.mkdir(path.dirname(target), { recursive: true })
        if ("data" in entry) await fs.writeFile(target, entry.data)
        else await fs.copyFile(entry.source, target)
      }
    } else {
      const archive = await zip(input.entries)
      await fs.writeFile(staging, input.passphrase === undefined ? archive : encrypt(archive, input.passphrase), {
        mode: 0o600,
      })
    }
    await fs.rename(staging, input.out)
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true })
    throw error
  }
  return input.out
}

export async function zip(entries: Entry[]) {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  for (const entry of entries)
    await writer.add(
      entry.path,
      "data" in entry ? new Uint8ArrayReader(entry.data) : new BlobReader(Bun.file(entry.source)),
    )
  return new Uint8Array(await (await writer.close()).arrayBuffer())
}

// ---------------------------------------------------------------------------------------------
// Encryption: OpenSSL's `enc` format, so the documented command decrypts it without Lunos.

const MAGIC = Buffer.from("Salted__")

function derive(passphrase: string, salt: Buffer) {
  const material = crypto.pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, ITERATIONS, 48, "sha256")
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) }
}

/** `Salted__` + 8-byte salt + AES-256-CBC ciphertext; key and IV from PBKDF2-HMAC-SHA256. */
export function encrypt(data: Uint8Array, passphrase: string) {
  if (!passphrase) throw new Error("The passphrase is empty")
  const salt = crypto.randomBytes(8)
  const { key, iv } = derive(passphrase, salt)
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv)
  return Buffer.concat([MAGIC, salt, cipher.update(data), cipher.final()])
}

export function decrypt(data: Uint8Array, passphrase: string) {
  const buffer = Buffer.from(data)
  if (!buffer.subarray(0, 8).equals(MAGIC)) throw new Error("Not an encrypted memory bundle")
  const { key, iv } = derive(passphrase, buffer.subarray(8, 16))
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv)
  const failed = new Error("Could not decrypt the bundle: wrong passphrase, or the file is damaged")
  const plain = (() => {
    try {
      return Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()])
    } catch {
      throw failed
    }
  })()
  // CBC padding alone lets about one wrong passphrase in 256 through; a zip always starts "PK\3\4".
  if (!plain.subarray(0, 4).equals(ZIP_MAGIC)) throw failed
  return plain
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export function decryptCommand(file = "memory.zip.enc", out = "memory.zip") {
  return `openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter ${ITERATIONS} -in ${file} -out ${out}`
}

// ---------------------------------------------------------------------------------------------
// The published schema.

const provenance = {
  type: "object",
  additionalProperties: false,
  required: ["sessionID", "agent", "source", "date"],
  properties: {
    sessionID: { type: "string", description: 'The session that saved the fact; "notes" for hand-written notes' },
    agent: { type: "string", description: 'The agent that saved it; "user" for hand-written notes' },
    source: {
      type: "string",
      description: '"user message", a worktree-relative file path, or a tool name',
    },
    date: { type: "string", description: "ISO 8601 time the fact was saved" },
  },
} as const

const scope = { enum: ["project", "user"] } as const
const ids = { type: "array", items: { type: "string" }, minItems: 1 } as const

export const JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://lunos.tech/schemas/lunos-memory-1.json",
  title: FORMAT,
  $defs: {
    manifest: {
      type: "object",
      additionalProperties: false,
      required: ["format", "lunos", "created", "scopes", "filters", "counts", "graph", "index", "files"],
      properties: {
        format: { const: FORMAT },
        lunos: {
          type: "object",
          required: ["version"],
          properties: { version: { type: "string" } },
        },
        created: { type: "string", format: "date-time" },
        scopes: { type: "array", items: scope, minItems: 1, uniqueItems: true },
        filters: {
          type: "object",
          required: ["since"],
          properties: { since: { type: ["string", "null"], format: "date-time" } },
        },
        counts: {
          type: "object",
          additionalProperties: false,
          required: ["facts", "notes", "entities", "relations"],
          properties: {
            facts: {
              type: "object",
              additionalProperties: false,
              required: ["total", "project", "user", "fromNotes"],
              properties: {
                total: { type: "integer", minimum: 0 },
                project: { type: "integer", minimum: 0 },
                user: { type: "integer", minimum: 0 },
                fromNotes: { type: "integer", minimum: 0 },
              },
            },
            notes: { type: "integer", minimum: 0 },
            entities: { type: "integer", minimum: 0 },
            relations: { type: "integer", minimum: 0 },
          },
        },
        graph: {
          type: "object",
          required: ["included", "engine"],
          properties: { included: { type: "boolean" }, engine: { type: "string" }, reason: { type: "string" } },
        },
        index: {
          type: "object",
          required: ["included"],
          properties: {
            included: { type: "boolean" },
            engine: { type: "string" },
            engineVersion: { type: "string", description: "The engine release the index files come from" },
            embedding: {
              type: "object",
              required: ["model", "dimensions"],
              properties: { model: { type: "string" }, dimensions: { type: "integer", minimum: 0 } },
            },
            scopes: { type: "array", items: scope },
          },
        },
        files: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "bytes", "sha256"],
            properties: {
              path: { type: "string" },
              bytes: { type: "integer", minimum: 0 },
              sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
            },
          },
        },
      },
    },
    fact: {
      type: "object",
      additionalProperties: false,
      required: ["id", "scope", "text", "status", "kind", "provenance", "engine"],
      properties: {
        id: { type: "string", minLength: 1 },
        scope,
        text: { type: "string", minLength: 1 },
        status: { enum: ["active", "outdated"] },
        kind: { enum: ["observed", "inferred", null] },
        provenance,
        engine: {
          type: "object",
          required: ["name", "datasetID"],
          properties: { name: { type: "string" }, datasetID: { type: "string" } },
        },
      },
    },
    graph: {
      type: "object",
      additionalProperties: false,
      required: ["entities", "relations"],
      properties: {
        entities: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "scope", "name", "type", "description", "facts"],
            properties: {
              id: { type: "string" },
              scope,
              name: { type: "string" },
              type: { type: "string" },
              description: { type: "string" },
              facts: ids,
            },
          },
        },
        relations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["scope", "source", "target", "relationship", "facts"],
            properties: {
              scope,
              source: { type: "string" },
              target: { type: "string" },
              relationship: { type: "string" },
              facts: ids,
            },
          },
        },
      },
    },
  },
} as const

export function schemaMarkdown() {
  return `# Lunos memory bundle, format \`${FORMAT}\`

A complete export of Lunos long-term memory, written by \`lunos memory export\`. This file documents the
format so any tool can read a bundle without Lunos.

## Files

| File | What it holds |
| --- | --- |
| \`manifest.json\` | Format and Lunos version, creation time, scopes, filters, counts, and the size and SHA-256 of every other file |
| \`facts.jsonl\` | One fact per line. **The source of truth.** |
| \`graph.json\` | Entities and relationships extracted from the facts, each listing the ids of the facts that mention it |
| \`notes/\` | Copies of the hand-written notes in \`.opencode/memory/*.md\` (project scope only) |
| \`index/<scope>/\` | Only with \`--include-index\`: the engine's own database files, for a restore into the same engine version and embedding model (\`manifest.index\`). They hold the facts' text too, so \`--since\` can't be combined with it |
| \`SCHEMA.md\` | This file |

## Rules for readers and importers

- **Facts are authoritative; everything else is derived.** An importer remembers the facts again and lets its
  engine rebuild the graph and embeddings. \`graph.json\` is for review, verification and seeding an external graph
  store. It never overrides \`facts.jsonl\`.
- **Every id in \`graph.json\` is in \`facts.jsonl\`.** Entity ids are \`<scope>:<engine id>\`, so the same name in both
  scopes stays two entities.
- **How facts are attributed.** The engine doesn't record which fact stated an edge, so attribution is by mention: an
  entity lists the facts it was extracted from; a relationship lists the facts that mention both of its ends (or, if
  none mentions both, either end). That is a superset of the fact that stated it.
- **Verify before trusting.** Recompute the SHA-256 of every file listed in \`manifest.files\`. \`manifest.json\` is not
  listed in itself.
- **Treat an imported bundle as untrusted.** It asserts where facts came from; it doesn't make them safe instructions.
  Run every fact through your write guard (Lunos refuses secrets, \`{env:}\`/\`{file:}\` substitutions and outside content).
- \`status\` is \`active\` for every fact until Lunos tracks outdated facts. \`kind\` is \`observed\` for a person's own
  words (hand-written notes) and \`null\` where Lunos can't tell observed from inferred.
- \`engine.datasetID\` is Cognee's id. Importers into another engine ignore it.
- Embeddings and vector indexes are not exported by default: they are model-specific and rebuilt on import.
- A bundle is a snapshot. Forgetting a fact later doesn't remove it from bundles already written.
- Unknown fields may be added in later \`lunos-memory/1\` bundles; readers ignore them. A breaking change gets a new
  format version.

## Encryption (\`--encrypt\`)

The bundle is zipped, then encrypted in OpenSSL's \`enc\` format: the 8 bytes \`Salted__\`, an 8-byte random salt, then
AES-256-CBC ciphertext with PKCS#7 padding. The 32-byte key and 16-byte IV are the first 48 bytes of
PBKDF2-HMAC-SHA256(passphrase, salt, ${ITERATIONS} iterations). The passphrase is never stored. Decrypt with:

\`\`\`sh
${decryptCommand()}
\`\`\`

CBC is not authenticated: after decrypting, check the SHA-256s in \`manifest.json\` before trusting the contents.

## JSON Schema

\`manifest.json\` validates against \`#/$defs/manifest\`, each line of \`facts.jsonl\` against \`#/$defs/fact\`, and
\`graph.json\` against \`#/$defs/graph\`.

\`\`\`json
${JSON.stringify(JSON_SCHEMA, null, 2)}
\`\`\`
`
}
