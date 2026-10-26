export * as MemorySourceGraph from "./graph"

import type { ConfigMemorySource } from "@opencode-ai/core/config/memory-source"

/**
 * A knowledge-graph memory source (XCOD-135): read-only queries against Neo4j. Lunos only ever runs
 * the two fixed, parameterised Cypher reads below, in READ transactions, so nothing is written even
 * if the account could write. Give the account read-only rights anyway.
 */

export interface Client {
  search(query: string, limit: number, timeoutMs: number): Promise<string[]>
  close(): Promise<void>
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu
const STOP = new Set(
  "a an and are as at be by did do does for from has have how i in is it its me my of on or our the their this to was we what when where which who whom why with you your".split(
    " ",
  ),
)

/** The words of a question worth searching for, lower-cased, without stop words. */
export function words(query: string) {
  const out = new Set<string>()
  for (const match of query.toLowerCase().matchAll(WORD)) {
    const word = match[0].replace(/[.-]+$/, "")
    if (word.length >= 2 && !STOP.has(word)) out.add(word)
  }
  return [...out].slice(0, 16)
}

/** A Lucene query that matches any of the words, with every special character escaped. */
export function lucene(query: string) {
  return words(query)
    .map((word) => word.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, (c) => `\\${c}`))
    .join(" OR ")
}

const NAME = "coalesce(n.name, n.title, n.id, n.key)"
const OTHER = "coalesce(m.name, m.title, m.id, m.key, head(labels(m)))"

const FULLTEXT = `CALL db.index.fulltext.queryNodes($index, $q) YIELD node AS n, score
WITH n, score ORDER BY score DESC LIMIT $limit
OPTIONAL MATCH (n)-[r]-(m)
WITH n, score, collect({rel: type(r), out: startNode(r) = n, other: ${OTHER}})[..12] AS links
RETURN ${NAME} AS name, labels(n) AS labels, coalesce(n.description, n.summary, n.text, n.fact) AS about, links
ORDER BY score DESC`

const CONTAINS = `MATCH (n) WHERE any(w IN $words WHERE toLower(toString(${NAME})) CONTAINS w)
WITH n LIMIT $limit
OPTIONAL MATCH (n)-[r]-(m)
WITH n, collect({rel: type(r), out: startNode(r) = n, other: ${OTHER}})[..12] AS links
RETURN ${NAME} AS name, labels(n) AS labels, coalesce(n.description, n.summary, n.text, n.fact) AS about, links`

interface Row {
  name: unknown
  labels: unknown
  about: unknown
  links: { rel: unknown; out: unknown; other: unknown }[] | null
}

const str = (value: unknown) => (value === null || value === undefined ? "" : String(value))

/** One node as one line: its name and labels, what it says about itself, and its relationships. */
export function describe(row: Row) {
  const name = str(row.name) || "(unnamed)"
  const labels = Array.isArray(row.labels) && row.labels.length ? ` [${row.labels.map(str).join(", ")}]` : ""
  const about = str(row.about).trim()
  const links = (row.links ?? [])
    .filter((link) => link && link.rel)
    .map((link) =>
      link.out ? `${name} ${str(link.rel)} ${str(link.other)}` : `${str(link.other)} ${str(link.rel)} ${name}`,
    )
  return `${name}${labels}${about ? `: ${about}` : ""}${links.length ? `. ${links.join("; ")}` : ""}`
}

export async function connect(source: ConfigMemorySource.Info & { url: string }): Promise<Client> {
  // Imported only here: nothing opens a socket until the residency check has passed.
  const lib = (await import("neo4j-driver")).default
  const timeout = source.timeout_ms ?? 2000
  const auth = source.username ? lib.auth.basic(source.username, source.password ?? "") : undefined
  const driver = lib.driver(source.url, auth, {
    disableLosslessIntegers: true,
    logging: undefined,
    maxConnectionPoolSize: 2,
    connectionTimeout: timeout,
    connectionAcquisitionTimeout: timeout,
    maxTransactionRetryTime: 0,
    userAgent: "lunos-memory-source",
  })
  let index = source.index
  const read = async <T>(cypher: string, params: Record<string, unknown>, timeoutMs: number) => {
    const session = driver.session({ database: source.database, defaultAccessMode: lib.session.READ })
    try {
      return await session.executeRead(
        async (tx) => (await tx.run(cypher, params)).records.map((record) => record.toObject() as T),
        { timeout: timeoutMs },
      )
    } finally {
      void session.close().catch(() => {})
    }
  }
  return {
    async search(query, limit, timeoutMs) {
      if ((source.query ?? "fulltext") === "contains") {
        const list = words(query).filter((word) => word.length >= 3)
        if (!list.length) return []
        return (await read<Row>(CONTAINS, { words: list, limit: lib.int(limit) }, timeoutMs)).map(describe)
      }
      const q = lucene(query)
      if (!q) return []
      if (!index) {
        const found = await read<{ name: string }>(
          "SHOW FULLTEXT INDEXES YIELD name, entityType WHERE entityType = 'NODE' RETURN name ORDER BY name LIMIT 1",
          {},
          timeoutMs,
        )
        index = found[0]?.name
        if (!index) throw new Error('the database has no full-text index; create one, or set query to "contains"')
      }
      return (await read<Row>(FULLTEXT, { index, q, limit: lib.int(limit) }, timeoutMs)).map(describe)
    },
    close: () => driver.close(),
  }
}
