export * as ConfigPolicy from "./policy"

import { Effect } from "effect"

// XCOD-102: organisation policy. Managed config (the system directory, or an MDM profile) can list
// keys under `$locked`. A locked key takes its value from managed config only: whatever user or
// project config, environment variables, CLI flags or in-session commands say is ignored, and every
// attempt to change it is refused through `refused()`.

export const FIELD = "$locked"

/** Keys this version knows how to lock. Others are kept, with a warning, for newer versions. */
export const KNOWN = [
  "residency",
  "share",
  "enabled_providers",
  "disabled_providers",
  "marketplace",
  "marketplace_default",
  "marketplace_allow",
  "autoupdate",
  "memory",
  "memory.enabled",
] as const

type Record_ = Record<string, unknown>
const isRecord = (value: unknown): value is Record_ => !!value && typeof value === "object" && !Array.isArray(value)

export function get(doc: unknown, key: string): unknown {
  let current = doc
  for (const part of key.split(".")) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

// Copies only the containers along the key's path and passes values through untouched: decoded
// config holds Schema class instances (e.g. ConfigV2.Residency), and a deep clone would turn them
// into plain objects that the config endpoint then refuses to encode.
function set(doc: Record_, key: string, value: unknown) {
  const parts = key.split(".")
  let current = doc
  for (const part of parts.slice(0, -1)) {
    current[part] = isRecord(current[part]) ? { ...(current[part] as Record_) } : {}
    current = current[part] as Record_
  }
  const last = parts.at(-1)!
  if (value === undefined) delete current[last]
  else current[last] = value
}

/** `$locked` from one managed document: string entries only. */
export function lockList(doc: unknown): string[] {
  const list = isRecord(doc) ? doc[FIELD] : undefined
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []
}

/** Lock lists from several managed documents are unioned, never replaced by the last one. */
export function union(...lists: ReadonlyArray<ReadonlyArray<string>>) {
  return [...new Set(lists.flat())]
}

/** A lock on `share` covers `share.x`, and a lock on `memory` covers `memory.enabled`. */
export function isLocked(locked: ReadonlyArray<string> | undefined, key: string) {
  return !!locked?.some((entry) => key === entry || key.startsWith(`${entry}.`))
}

/**
 * Makes every locked key hold exactly what managed config says, replacing (not merging) whole
 * subtrees, so a lower layer can't slip in `residency.audit: false` under a locked `residency`.
 * A locked key managed config doesn't set becomes unset, falling back to the default.
 */
export function apply<T extends Record_>(resolved: T, managed: Record_, locked: ReadonlyArray<string>): T {
  const next = { ...resolved } as Record_
  for (const key of locked) set(next, key, get(managed, key))
  // The deprecated `autoshare: true` still maps to `share: "auto"`, so it can't survive a lock.
  if (isLocked(locked, "share")) delete next.autoshare
  if (locked.length) next[FIELD] = [...locked]
  else delete next[FIELD]
  return next as T
}

/** A copy of `doc` without `key` (dotted keys remove the leaf only). */
export function omit<T>(doc: T, key: string): T {
  if (!isRecord(doc)) return doc
  const next = { ...doc } as Record_
  set(next, key, undefined)
  return next as T
}

export type Refusal = { key: string; via: string; at: string }
const listeners = new Set<(refusal: Refusal) => void>()

/** Observe refusals. The audit trail (XCOD-103) subscribes here to write `policy.override_refused`. */
export function onRefused(listener: (refusal: Refusal) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The one seam every refused override goes through, whichever surface it came from: an env var,
 * a CLI flag, an in-session command or a config write.
 */
export const refused = (key: string, via: string) =>
  Effect.gen(function* () {
    const refusal = { key, via, at: new Date().toISOString() }
    yield* Effect.logWarning(message(key), { via })
    for (const listener of listeners) listener(refusal)
    return refusal
  })

/** `$locked` means nothing outside managed config, and must never be written back to it. */
export function strip<T>(doc: T): T {
  if (!isRecord(doc) || !(FIELD in doc)) return doc
  const { [FIELD]: _, ...rest } = doc
  return rest as T
}

export function unknownKeys(locked: ReadonlyArray<string>) {
  return locked.filter((key) => !(KNOWN as ReadonlyArray<string>).includes(key))
}

/** The one message every refused override shows, whichever surface it came through. */
export function message(key: string) {
  return `${key} is set by your organisation's policy and can't be changed here`
}

export class LockedError extends Error {
  constructor(
    readonly key: string,
    readonly via: string,
  ) {
    super(message(key))
    this.name = "PolicyLockedError"
  }
}
