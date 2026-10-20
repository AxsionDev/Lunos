import TIPS_JSON from "../feature-plugins/home/tips.json"

/**
 * XCOD-278: the tips shown on the home screen and under the working indicator. Every draw comes from
 * one shuffled deck kept per user in kv, so no tip repeats until every eligible one has been seen,
 * and the same tip never shows twice in a row. Everything here is local: nothing about which tips
 * were seen leaves the computer.
 */
export type Tip = {
  /** Stable, never reused: the deck in kv keeps ids. */
  id: string
  category: string
  /** `{highlight}…{/highlight}` for commands, `{key:<keybind name>}` for a key from the user's keybinds. */
  text: string
  /** Every condition must hold for the tip to be drawn. */
  requires?: string[]
  /** Config keys the tip names (dotted paths in the main config or tui.json), checked by the validator. */
  config?: string[]
}

export const TIPS = TIPS_JSON as Tip[]

/** Tips preferred during a user's first starts. */
export const FIRST_STEPS = "Getting started"
export const FIRST_STEPS_STARTS = 10

/**
 * What a tip's `requires` can say. `flag:<name>` holds while that feature flag is on (unknown flags
 * never hold: a tip for an unshipped feature stays hidden), `plugin:<name>` while that plugin is installed.
 */
export const CONDITIONS = [
  "memory.on",
  "memory.off",
  "external.enabled",
  "signedIn",
  "notWindows",
  "mcp.configured",
  "lsp.on",
  "share.enabled",
] as const
export type Condition = (typeof CONDITIONS)[number]

export type Context = Record<Condition, boolean> & {
  flags: ReadonlySet<string>
  plugins: ReadonlySet<string>
}

/** The parts of the effective config (organisation policy included) that tips depend on. */
export type ContextConfig = {
  $locked?: readonly string[]
  memory?: { enabled?: boolean }
  external?: { enabled?: boolean }
  mcp?: Record<string, unknown>
  lsp?: unknown
  share?: string
  plugin?: readonly (string | readonly [string, ...unknown[]])[]
}

export function context(input: {
  config: ContextConfig
  signedIn: boolean
  platform: string
  flags: Record<string, boolean>
}): Context {
  const config = input.config
  const locked = new Set(config.$locked ?? [])
  const memory = config.memory?.enabled === true
  return {
    "memory.on": memory,
    // "Turn memory on" means nothing where the organisation keeps it off.
    "memory.off": !memory && !locked.has("memory") && !locked.has("memory.enabled"),
    "external.enabled": config.external?.enabled !== false,
    signedIn: input.signedIn,
    notWindows: input.platform !== "win32",
    "mcp.configured": Object.keys(config.mcp ?? {}).length > 0,
    "lsp.on": config.lsp !== false,
    // Sharing is off unless `share` turns it on.
    "share.enabled": config.share === "manual" || config.share === "auto" || config.share === "cloud",
    flags: new Set(Object.entries(input.flags).flatMap(([name, on]) => (on ? [name] : []))),
    // A plugin by package name, without its version.
    plugins: new Set(
      (config.plugin ?? []).map((spec) => (typeof spec === "string" ? spec : spec[0]).replace(/(.)@[^/@]*$/, "$1")),
    ),
  }
}

export function knownCondition(value: string) {
  return (
    (CONDITIONS as readonly string[]).includes(value) ||
    /^flag:[a-z0-9_-]+$/.test(value) ||
    /^plugin:[^\s]+$/.test(value)
  )
}

export function holds(condition: string, context: Context) {
  if (condition.startsWith("flag:")) return context.flags.has(condition.slice(5))
  if (condition.startsWith("plugin:")) return context.plugins.has(condition.slice(7))
  return context[condition as Condition] === true
}

export function eligible(tip: Tip, context: Context) {
  return (tip.requires ?? []).every((condition) => holds(condition, context))
}

/** The keybind names a tip's text uses. */
export function keys(text: string) {
  return Array.from(text.matchAll(/\{key:([^}]+)\}/g), (match) => match[1]!)
}

/**
 * The text with each `{key:name}` replaced by the user's key, highlighted. Undefined when a binding
 * is unset (`none`): a tip about a key the user turned off is skipped.
 */
export function render(text: string, key: (name: string) => string | undefined) {
  let missing = false
  const result = text.replace(/\{key:([^}]+)\}/g, (_, name: string) => {
    const value = key(name)
    if (!value) missing = true
    return `{highlight}${value ?? ""}{/highlight}`
  })
  return missing ? undefined : result
}

export type TipPart = { text: string; highlight: boolean }

export function parts(text: string): TipPart[] {
  const result: TipPart[] = []
  let index = 0
  for (const match of text.matchAll(/\{highlight\}(.*?)\{\/highlight\}/g)) {
    const start = match.index ?? 0
    if (start > index) result.push({ text: text.slice(index, start), highlight: false })
    result.push({ text: match[1]!, highlight: true })
    index = start + match[0].length
  }
  if (index < text.length) result.push({ text: text.slice(index), highlight: false })
  return result
}

/** The parts cut to `width` characters, ending in "…" when anything was cut. */
export function truncate(list: readonly TipPart[], width: number): TipPart[] {
  const total = list.reduce((sum, part) => sum + part.text.length, 0)
  if (total <= width) return [...list]
  const result: TipPart[] = []
  let room = Math.max(0, width - 1)
  for (const part of list) {
    if (room <= 0) break
    const text = part.text.slice(0, room)
    result.push({ ...part, text })
    room -= text.length
  }
  const last = result.at(-1)
  if (last) last.text = last.text.trimEnd() + "…"
  return result
}

/** The text as shown, without markup. */
export function plain(text: string) {
  return parts(text)
    .map((part) => part.text)
    .join("")
}

/** What kv keeps between starts. */
export type Deck = {
  /** This round's cards still to draw, in order. */
  pending: string[]
  /** Drawn this round. */
  drawn: string[]
  /** Ever shown, for /tips. */
  seen: string[]
  last?: string
  starts: number
}

export const EMPTY_DECK: Deck = { pending: [], drawn: [], seen: [], starts: 0 }

export function deck(value: unknown): Deck {
  const item = value && typeof value === "object" ? (value as Partial<Deck>) : {}
  const ids = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [])
  return {
    pending: ids(item.pending),
    drawn: ids(item.drawn),
    seen: ids(item.seen),
    last: typeof item.last === "string" ? item.last : undefined,
    starts: typeof item.starts === "number" ? item.starts : 0,
  }
}

export function shuffle<T>(items: readonly T[], random: () => number) {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[result[index], result[other]] = [result[other]!, result[index]!]
  }
  return result
}

/** A seeded random source (mulberry32), for tests. */
export function seeded(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Draws the next tip. `ids` is every tip (a round covers them all, so a tip whose condition stops
 * and starts holding again doesn't come round twice); only `eligible` ones are drawn. New ids (a tip
 * added in an update) join this round at a random place, and ids that no longer exist are dropped.
 * A round ends when no eligible tip is left in it. `preferred` ids go first while any are left.
 */
export function draw(
  current: Deck,
  ids: readonly string[],
  input: {
    eligible: ReadonlySet<string>
    random: () => number
    preferred?: ReadonlySet<string>
    /** false: draw nothing rather than start a new round (a narrow draw leaves the round's long tips). */
    restart?: boolean
  },
): { id?: string; deck: Deck } {
  const known = new Set(ids)
  const drawn = current.drawn.filter((id) => known.has(id))
  const pending = current.pending.filter((id) => known.has(id) && !drawn.includes(id))
  for (const id of ids) {
    if (pending.includes(id) || drawn.includes(id)) continue
    pending.splice(Math.floor(input.random() * (pending.length + 1)), 0, id)
  }
  const candidates = (list: string[]) => {
    const open = list.filter((id) => input.eligible.has(id))
    if (!input.preferred) return open
    return [...open.filter((id) => input.preferred!.has(id)), ...open.filter((id) => !input.preferred!.has(id))]
  }
  let round = { pending, drawn }
  if (!candidates(pending).length) {
    if (input.restart === false) return { deck: { ...current, pending, drawn } }
    round = { pending: shuffle(ids, input.random), drawn: [] }
  }
  const order = candidates(round.pending)
  // Never the tip just shown, unless it is the only one.
  const id = order.find((item) => item !== current.last) ?? order[0]
  if (!id) return { deck: { ...current, pending: round.pending, drawn: round.drawn } }
  return {
    id,
    deck: {
      pending: round.pending.filter((item) => item !== id),
      drawn: [...round.drawn, id],
      seen: [...current.seen.filter((item) => known.has(item) && item !== id), id],
      last: id,
      starts: current.starts,
    },
  }
}
