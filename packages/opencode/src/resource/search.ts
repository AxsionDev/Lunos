export * as ResourceSearch from "./search"

/**
 * Search over resource chunks (XCOD-300), on this computer only.
 *
 * The ticket asked for memory's local embeddings. Those exist only inside memory's cognee sidecar,
 * whose ingestion runs extraction through the user's model (MCP sampling): indexing a resource
 * there would send its content out, which Search mode promises not to do, and it needs `uv`,
 * Python and memory turned on. So this is a lexical index (BM25), in plain TypeScript, behind
 * `Index`: an embedding index can replace it without touching the tool, the prompt or the TUI.
 */

export interface Chunk {
  /** The resource's name. */
  resource: string
  /** Path, URL or MCP URI, relative to the resource's root where it has one. */
  source: string
  /** First line of the chunk in its source, 1-based. */
  line: number
  text: string
}

export interface Hit {
  chunk: Chunk
  score: number
}

export interface Index {
  search(query: string, limit: number): Hit[]
}

const STOP = new Set(
  "a an and are as at be but by can do does for from has have how i if in into is it its of on or so that the their then there these this to was were what when where which who why will with you your".split(
    " ",
  ),
)

/** Lower-cased words and numbers; camelCase and snake_case identifiers also give their parts. */
export function tokens(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const word = match[0]
    const parts = word
      .replace(/([a-z\d])([A-Z])/g, "$1 $2")
      .split(/[_\s]+/)
      .filter(Boolean)
    const all = parts.length > 1 ? [word, ...parts] : [word]
    for (const item of all) {
      const lower = item.toLowerCase()
      if (lower.length < 2 || STOP.has(lower)) continue
      out.push(lower)
    }
  }
  return out
}

const K1 = 1.2
const B = 0.75

/** Okapi BM25 over the given chunks. Built in memory; cheap enough to rebuild when chunks change. */
export function bm25(chunks: readonly Chunk[]): Index {
  const docs = chunks.map((chunk) => {
    const freq = new Map<string, number>()
    const words = tokens(`${chunk.source}\n${chunk.text}`)
    for (const word of words) freq.set(word, (freq.get(word) ?? 0) + 1)
    return { chunk, freq, length: words.length }
  })
  const df = new Map<string, number>()
  for (const doc of docs) for (const word of doc.freq.keys()) df.set(word, (df.get(word) ?? 0) + 1)
  const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length)
  const n = docs.length
  return {
    search(query, limit) {
      const terms = [...new Set(tokens(query))]
      if (!terms.length) return []
      const hits: Hit[] = []
      for (const doc of docs) {
        let score = 0
        for (const term of terms) {
          const tf = doc.freq.get(term)
          if (!tf) continue
          const idf = Math.log(1 + (n - df.get(term)! + 0.5) / (df.get(term)! + 0.5))
          score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / (avg || 1)))
        }
        if (score > 0) hits.push({ chunk: doc.chunk, score })
      }
      return hits.toSorted((a, b) => b.score - a.score).slice(0, limit)
    },
  }
}

/** Splits text into chunks of about `size` characters on line boundaries. */
export function chunk(resource: string, source: string, text: string, size = 1600): Chunk[] {
  const lines = text.split("\n")
  const out: Chunk[] = []
  let start = 0
  let buffer: string[] = []
  let length = 0
  const flush = () => {
    const body = buffer.join("\n").trim()
    if (body) out.push({ resource, source, line: start + 1, text: body })
    buffer = []
    length = 0
  }
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!
    if (!buffer.length) start = index
    // A single very long line (minified text) is cut, so no chunk is unbounded.
    while (line.length > size) {
      if (buffer.length) flush()
      start = index
      buffer.push(line.slice(0, size))
      flush()
      line = line.slice(size)
    }
    if (!buffer.length) start = index
    buffer.push(line)
    length += line.length + 1
    if (length >= size) flush()
  }
  flush()
  return out
}
