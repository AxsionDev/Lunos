export * as ControlEphemeral from "./ephemeral"

import { randomUUID } from "crypto"

// XCOD-327: screenshots are sent to the model, never stored. A tool result marks its media
// ephemeral; the session processor swaps the data URL for a reference into this in-memory store
// before the part is written, and the message builder swaps it back when the next model request is
// made. After a restart (or once evicted) the image is gone and the model is told so.

export const SCHEME = "lunos-ephemeral:"
const MAX_ITEMS = 16
const TTL_MS = 30 * 60 * 1000

const items = new Map<string, { url: string; at: number }>()

/** Holds a data URL in memory and returns the reference stored in its place. */
export function put(url: string) {
  prune()
  const id = randomUUID()
  items.set(id, { url, at: Date.now() })
  while (items.size > MAX_ITEMS) items.delete(items.keys().next().value!)
  return SCHEME + id
}

/** The data URL behind a reference, or undefined when it's gone. Other URLs are returned as they are. */
export function resolve(url: string) {
  if (!url.startsWith(SCHEME)) return url
  prune()
  return items.get(url.slice(SCHEME.length))?.url
}

export function is(url: string) {
  return url.startsWith(SCHEME)
}

function prune() {
  const now = Date.now()
  for (const [id, item] of items) if (now - item.at > TTL_MS) items.delete(id)
}
