export * as ConfigMemorySource from "./memory-source"

import { Schema } from "effect"

/**
 * An external, read-only memory source (XCOD-135): a knowledge graph or an MCP memory server that
 * Lunos recalls from alongside its own memory and never writes to. Everything a source returns is
 * untrusted reference: screened, size-capped, labelled with the source, and never stored locally.
 */
export const Info = Schema.Struct({
  name: Schema.String.annotate({
    description: 'A unique name for the source, e.g. "platform-kg". Shown as the label on everything it returns',
  }),
  type: Schema.Literals(["graph", "mcp"]).annotate({
    description:
      '"graph": a read-only query against a Neo4j knowledge graph. "mcp": a search tool on an MCP server configured under "mcp"',
  }),
  jurisdiction: Schema.String.pipe(Schema.optional).annotate({
    description:
      'Where the source runs, e.g. "EU-DE", "EU" or "US". Required: checked against the residency policy before the source is first contacted. A source without one is never queried',
  }),
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Set to false to keep the source configured but never query it (default true)",
  }),
  max_tokens: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: "Most tokens this source may add to a turn (default 500), within memory.retrieval.max_tokens overall",
  }),
  timeout_ms: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.optional).annotate({
    description: "How long a query may take before the source is skipped for that turn (default 2000)",
  }),
  trusted: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Honoured only in managed config: results are labelled as organisation-managed and skip the instruction-pattern screen (secret screening and size caps still apply). Ignored anywhere else",
  }),
  url: Schema.String.pipe(Schema.optional).annotate({
    description:
      'graph: the Neo4j URL, e.g. "bolt+s://kg.internal:7687". Plain bolt:// or neo4j:// only to this machine',
  }),
  database: Schema.String.pipe(Schema.optional).annotate({
    description: "graph: the database to read (default: the server's default database)",
  }),
  query: Schema.Literals(["fulltext", "contains"]).pipe(Schema.optional).annotate({
    description:
      'graph: how nodes are found. "fulltext" (the default) uses a full-text index; "contains" matches node names containing a word of the question',
  }),
  index: Schema.String.pipe(Schema.optional).annotate({
    description: 'graph, "fulltext": the full-text index to search (default: the first one the database has)',
  }),
  username: Schema.String.pipe(Schema.optional).annotate({
    description: 'graph: the user to connect as, e.g. "{env:KG_USER}". Give it read-only rights',
  }),
  password: Schema.String.pipe(Schema.optional).annotate({
    description: 'graph: the password, e.g. "{env:KG_PASS}"',
  }),
  server: Schema.String.pipe(Schema.optional).annotate({
    description:
      'mcp: the name of a server under "mcp". Memory opens its own connection to it, after the residency check; set that server\'s "enabled" to false so the agent is not also given its tools',
  }),
  tool: Schema.String.pipe(Schema.optional).annotate({
    description: 'mcp: the search tool to call, e.g. "search_memory_facts". Only this tool is ever called',
  }),
  argument: Schema.String.pipe(Schema.optional).annotate({
    description: 'mcp: the tool argument that takes the query (default "query")',
  }),
}).annotate({ identifier: "MemorySourceConfig" })
export type Info = Schema.Schema.Type<typeof Info>
