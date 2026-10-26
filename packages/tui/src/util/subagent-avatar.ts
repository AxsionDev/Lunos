/**
 * XCOD-287: every subagent in the sidebar gets a pixel-art animal and a funny name. Both come from a
 * hash of the subagent's session id, never from Math.random, so a subagent keeps its face and name on
 * every render, after a restart and on every client. Among one session's subagents, none share a name,
 * and none share an animal while unused ones remain.
 *
 * The sprites are drawn for Lunos (8x8, one letter per pixel) and the colours are theme keys, never
 * hex, so an animal follows the user's theme like the rest of the TUI.
 */
import NAMES from "./subagent-names.json"

/** One letter per pixel. "." is see-through (the sidebar's own background shows). */
export type Pixel = "." | "B" | "L" | "D" | "E" | "M"

/**
 * Which theme colour each fixed pixel letter takes. B, the body, varies per subagent (BODY_COLORS);
 * M, the mark (nose, beak, feet, mane), is picked so it never matches the body.
 */
export const PIXEL_COLOR = {
  L: "text",
  D: "textMuted",
  E: "background",
} as const

/** Body colours a subagent can get: theme keys every theme defines. */
export const BODY_COLORS = ["primary", "secondary", "accent", "info", "success", "warning"] as const
export type BodyColor = (typeof BODY_COLORS)[number]

export const SPRITE_WIDTH = 8
export const SPRITE_HEIGHT = 8

export type Animal = { name: string; sprite: readonly string[] }

// Original 8x8 drawings, made for Lunos. B body, L light, D dark detail, E eye, M mark.
export const ANIMALS: readonly Animal[] = [
  {
    name: "Cat",
    sprite: ["B......B", "BB....BB", "BBBBBBBB", "BEBBBBEB", "BBBMMBBB", "BBBBBBBB", ".BBBBBB.", ".B.BB.B."],
  },
  {
    name: "Owl",
    sprite: [".B....B.", ".BBBBBB.", "BLLBBLLB", "BLEBBELB", "BBBMMBBB", "BBDBBDBB", ".BDDDDB.", "..M..M.."],
  },
  {
    name: "Frog",
    sprite: [".LL..LL.", "LEL..LEL", "BBBBBBBB", "BBBBBBBB", "BDDDDDDB", ".BBBBBB.", "BB.BB.BB", "........"],
  },
  {
    name: "Bunny",
    sprite: [".BB..BB.", ".BL..LB.", ".BB..BB.", ".BBBBBB.", "BBEBBEBB", "BBBMMBBB", ".BBBBBB.", "..B..B.."],
  },
  {
    name: "Pig",
    sprite: ["........", "B.BBBB.B", "BBBBBBBB", "BEBBBBEB", "BBMMMMBB", "BBMDDMBB", ".BBBBBB.", ".B.BB.B."],
  },
  {
    name: "Penguin",
    sprite: ["..BBBB..", ".BBBBBB.", ".BELLEB.", ".BLMMLB.", "BBLLLLBB", "BBLLLLBB", ".BLLLLB.", ".MM..MM."],
  },
  {
    name: "Duck",
    sprite: ["...BBB..", "..BBEBMM", "..BBBB..", "B.BBBB..", "BBBBBBB.", "BBDBBBB.", ".BBBBB..", "..M.M..."],
  },
  {
    name: "Bear",
    sprite: [".BB..BB.", ".BBBBBB.", "BBEBBEBB", "BBBLLBBB", "BBLDDLBB", ".BBLLBB.", "BBBBBBBB", "BB....BB"],
  },
  {
    name: "Octopus",
    sprite: ["..BBBB..", ".BBBBBB.", "BBEBBEBB", "BBBBBBBB", ".BBBBBB.", ".B.BB.B.", "B.B..B.B", "........"],
  },
  {
    name: "Fox",
    sprite: ["B......B", "BB....BB", "BBBBBBBB", "BEBBBBEB", "LLBBBBLL", ".LLDDLL.", "..LLLL..", "...LL..."],
  },
  {
    name: "Mouse",
    sprite: ["BB....BB", "BLB..BLB", "BBBBBBBB", ".BEBBEB.", ".BBBBBB.", "..BDDB..", "...BB...", "..M....."],
  },
  {
    name: "Otter",
    sprite: ["..BBBB..", ".BBBBBB.", ".BEBBEB.", ".BLMMLB.", ".BLLLLB.", "BBBBBBBB", ".BBBBBB.", "..B..B.."],
  },
  {
    name: "Hedgehog",
    sprite: ["..D.D...", ".DDDDD..", "DDDDDDBB", "DDDDDBEB", "DDDDDBBM", ".DDDDBB.", "..B..B..", "........"],
  },
  {
    name: "Capybara",
    sprite: ["........", ".BB.....", "BEBBBBB.", "BBBBBBBB", "DBBBBBBB", ".BBBBBBB", ".B.B.B.B", "........"],
  },
  {
    name: "Axolotl",
    sprite: ["M.BBBB.M", "MBBBBBBM", ".BEBBEB.", "MBBBBBBM", "..BDDB..", ".BBBBBB.", ".B....B.", "........"],
  },
  {
    name: "Red Panda",
    sprite: ["LB....BL", "BBBBBBBB", "BLLBBLLB", "BEBBBBEB", "BLLDDLLB", ".BBLLBB.", ".DDDDDD.", ".D....D."],
  },
  {
    name: "Sloth",
    sprite: ["..BBBB..", ".BLLLLB.", "BDEBBEDB", "BLLDDLLB", ".BLLLLB.", "B.BBBB.B", "B.BBBB.B", "..B..B.."],
  },
  {
    name: "Badger",
    sprite: ["...LL...", ".BBLLBB.", "BBELLEBB", "BBBLLBBB", ".BBDDBB.", "BBBBBBBB", "BBBBBBBB", ".B....B."],
  },
  {
    name: "Lynx",
    sprite: ["D......D", "B......B", "BB....BB", "BBBBBBBB", "BEBBBBEB", "LLBMMBLL", ".LLLLLL.", "..L..L.."],
  },
  {
    name: "Crab",
    sprite: ["B.L..L.B", "BBE..EBB", ".BBBBBB.", "BBBBBBBB", ".BBBBBB.", "B.B..B.B", "........", "........"],
  },
  {
    name: "Bee",
    sprite: ["..L..L..", "...LL...", ".BBBBBB.", "BEBBBBBB", "DDDDDDDD", "BBBBBBBB", "DDDDDDDD", ".BBBBBM."],
  },
  {
    name: "Whale",
    sprite: ["......B.", ".....BBB", ".BBBBB..", "BBBBBBB.", "BEBBBBBB", "BLLLLLBB", ".LLLLLB.", "........"],
  },
  {
    name: "Raccoon",
    sprite: ["B......B", "BB....BB", "BBBBBBBB", "DEDBBDED", "BLLBBLLB", ".BLDDLB.", "..BBBB..", "........"],
  },
  {
    name: "Hamster",
    sprite: [".B....B.", "BBBBBBBB", "BEBBBBEB", "LLBMMBLL", "LLLLLLLL", ".LLLLLL.", "..M..M..", "........"],
  },
  {
    name: "Goat",
    sprite: ["D......D", ".D....D.", ".BBBBBB.", "BEBBBBEB", ".BBBBBB.", "..BMMB..", "...LL...", "...L...."],
  },
  {
    name: "Heron",
    sprite: ["...BB...", "..BEBMMM", "...BB...", "...B....", "..BBBB..", ".BBBBB..", "...D....", "...D...."],
  },
  {
    name: "Turtle",
    sprite: ["........", "..DDDD..", ".DBDDBD.", "DDDDDDBB", "DDDDDDBE", ".B..B.BB", "........", "........"],
  },
  {
    name: "Koala",
    sprite: ["LB....BL", "BBB..BBB", "BBBBBBBB", "BBEBBEBB", "BBBDDBBB", ".BBDDBB.", "..BBBB..", "........"],
  },
  {
    name: "Panda",
    sprite: ["D......D", "LLLLLLLL", "LDDLLDDL", "LDELLEDL", "LLLDDLLL", ".LLLLLL.", "DDLLLLDD", "D......D"],
  },
  {
    name: "Lion",
    sprite: ["MMMMMMMM", "MBBBBBBM", "MBEBBEBM", "MBBDDBBM", "MBBLLBBM", "MMBBBBMM", ".MMMMMM.", "........"],
  },
  {
    name: "Tiger",
    sprite: ["B......B", "BBDBBDBB", "DBBBBBBD", "BEBDDBEB", "DBLLLLBD", "BBLMMLBB", ".BBLLBB.", "........"],
  },
  {
    name: "Monkey",
    sprite: ["..BBBB..", ".BBBBBB.", "LBLLLLBL", "LBELLEBL", "BBLLLLBB", ".BLDDLB.", "..BBBB..", "........"],
  },
  {
    name: "Elephant",
    sprite: ["........", "BBBBBBBB", "BBEBBEBB", "BBBBBBBB", "B.BBBB.B", "...BB...", "...BB...", "....B..."],
  },
  {
    name: "Cow",
    sprite: ["D......D", "LBBBBBBL", ".BEBBEB.", ".BBBBBB.", ".LLLLLL.", ".LDLLDL.", "..LLLL..", "........"],
  },
  {
    name: "Sheep",
    sprite: [".LLLLLL.", "LLLLLLLL", "LDDDDDDL", "LDEDDEDL", "LLDDDDLL", "LLLLLLLL", ".D....D.", ".D....D."],
  },
  {
    name: "Chick",
    sprite: ["...B....", "..BBBB..", ".BBBBBB.", ".BEBBEB.", ".BBMMBB.", ".BBBBBB.", "..BBBB..", "..M..M.."],
  },
  {
    name: "Snail",
    sprite: ["E.E.....", "B.B.DDD.", "BBBDBBBD", "BBBDBDBD", "BBBDBBDD", ".BBBDDDB", "BBBBBBBB", "........"],
  },
  {
    name: "Seal",
    sprite: ["........", "..BBBB..", ".BEBBEB.", ".BBDDBB.", "LBBBBBB.", ".BBBBBBB", "..BBBBB.", ".BB...BB"],
  },
  {
    name: "Wolf",
    sprite: ["B......B", "BB....BB", "BBBBBBBB", "BEBBBBEB", "BBLLLLBB", ".BLDDLB.", "..BLLB..", "...BB..."],
  },
  {
    name: "Deer",
    sprite: ["D.D..D.D", ".DD..DD.", "B.BBBB.B", ".BEBBEB.", "..BBBB..", "..BLLB..", "...DD...", "........"],
  },
  {
    name: "Bat",
    sprite: ["B.B..B.B", "BBB..BBB", "BBBBBBBB", "BBEBBEBB", "BBBBBBBB", ".BBLLBB.", "..B..B..", "........"],
  },
  {
    name: "Ladybug",
    sprite: ["...DD...", "..EDDE..", ".BBDDBB.", "BDBBDBDB", "BBBBDBBB", "BDBBDBDB", ".BBBDBB.", "..D..D.."],
  },
  {
    name: "Squirrel",
    sprite: ["..BBB...", ".B...B..", ".B.BB.BB", "..BEBBB.", "..BBBMB.", ".BBBBB..", ".BBBBB..", "BB..B..."],
  },
  {
    name: "Llama",
    sprite: [".B....B.", ".BB..BB.", ".BBBBBB.", ".BEBBEB.", "..BBBB..", "..BMMB..", "..BBBB..", "..B..B.."],
  },
]

/** First words: adjectives and titles ("Turbo", "Captain"). Curated, in subagent-names.json. */
export const TITLES: readonly string[] = NAMES.titles
/** Second words: playful nouns ("Pickle", "Wobblesworth"). Curated, in subagent-names.json. */
export const NOUNS: readonly string[] = NAMES.nouns

/** FNV-1a, 32-bit: small, stable across runtimes, good enough to spread ids over a few lists. */
export function hash(input: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export type Avatar = {
  /** "Turbo Pickle". */
  name: string
  animal: Animal
  body: BodyColor
  mark: BodyColor
}

const pick = <T>(list: readonly T[], seed: string) => list[hash(seed) % list.length]

function bodyOf(id: string) {
  const body = pick(BODY_COLORS, `body:${id}`)
  const mark: BodyColor = body === "warning" ? "accent" : "warning"
  return { body, mark }
}

function nameOf(id: string, salt: number) {
  const seed = salt === 0 ? id : `${id}#${salt}`
  return `${pick(TITLES, `title:${seed}`)} ${pick(NOUNS, `noun:${seed}`)}`
}

function animalOf(id: string, salt: number) {
  return pick(ANIMALS, salt === 0 ? `animal:${id}` : `animal:${id}#${salt}`)
}

/** One subagent's avatar on its own, without its siblings (see assignAvatars). */
export function avatar(id: string): Avatar {
  return { name: nameOf(id, 0), animal: animalOf(id, 0), ...bodyOf(id) }
}

/**
 * Avatars for one session's subagents, given in the order they were created. A name, or an animal,
 * an earlier subagent already has is re-picked with a salt (an animal only while unused ones remain),
 * so subagents side by side differ. Subagents are only ever added at the end, so an earlier one's
 * avatar never changes when a new one starts.
 */
export function assignAvatars(ids: readonly string[]) {
  const names = new Set<string>()
  const animals = new Set<string>()
  const result = new Map<string, Avatar>()
  for (const id of ids) {
    if (result.has(id)) continue
    let name = nameOf(id, 0)
    // Bounded: there are tens of thousands of names; past that a repeat is fine.
    for (let salt = 1; names.has(name) && salt < 64; salt++) name = nameOf(id, salt)
    let animal = animalOf(id, 0)
    if (animals.size < ANIMALS.length && animals.has(animal.name)) {
      // Walk on from the hashed pick to the next unused one: always finds one, stays deterministic.
      const start = ANIMALS.indexOf(animal)
      for (let step = 1; step < ANIMALS.length && animals.has(animal.name); step++)
        animal = ANIMALS[(start + step) % ANIMALS.length]
    }
    names.add(name)
    animals.add(animal.name)
    result.set(id, { name, animal, ...bodyOf(id) })
  }
  return result
}

/** `subagent.fun_names: false`: "Subagent 2". Numbered by creation, from 1. */
export function plainName(index: number) {
  return `Subagent ${index + 1}`
}

/** The one-character stand-in for the animal under NO_COLOR or in a narrow sidebar. */
export function glyph(animal: Animal) {
  return animal.name[0]!
}

/** The idle frame: eyes closed (eye pixels take the body colour). Same size, so nothing shifts. */
export function blink(sprite: readonly string[]) {
  return sprite.map((row) => row.replaceAll("E", "B"))
}

export type HalfCell = { top: Pixel; bottom: Pixel }

/**
 * A sprite as terminal rows: each character cell shows two pixels with a half block (top pixel in
 * the foreground of "▀", bottom pixel in its background), so an 8x8 sprite takes 8x4 cells.
 */
export function halfRows(sprite: readonly string[]): HalfCell[][] {
  const rows: HalfCell[][] = []
  for (let y = 0; y < sprite.length; y += 2) {
    const top = sprite[y] ?? ""
    const bottom = sprite[y + 1] ?? ""
    const width = Math.max(top.length, bottom.length)
    const row: HalfCell[] = []
    for (let x = 0; x < width; x++) {
      row.push({ top: (top[x] ?? ".") as Pixel, bottom: (bottom[x] ?? ".") as Pixel })
    }
    rows.push(row)
  }
  return rows
}

/** The character and which pixel takes the foreground / background for one half cell. */
export function halfCell(cell: HalfCell): { char: string; fg?: Pixel; bg?: Pixel } {
  if (cell.top === "." && cell.bottom === ".") return { char: " " }
  if (cell.top === ".") return { char: "▄", fg: cell.bottom }
  if (cell.bottom === ".") return { char: "▀", fg: cell.top }
  return { char: "▀", fg: cell.top, bg: cell.bottom }
}

export type SubagentState = "waiting" | "running" | "queued" | "done" | "failed"

/** The group's order: the ones that need you first, finished ones last. */
export const STATE_ORDER: readonly SubagentState[] = ["waiting", "running", "queued", "done", "failed"]

export const STATE_LABEL: Record<SubagentState, string> = {
  waiting: "Waiting for you",
  running: "Working",
  queued: "Queued",
  done: "Done",
  failed: "Failed",
}

export type SubagentEntry = {
  id: string
  agent: string
  description: string
  state: SubagentState
  background: boolean
  /** "provider/model", when the task call resolved one. */
  model?: string
  /** When the task call started (ms). */
  started?: number
  /** When it ended (ms), for a foreground call. */
  ended?: number
  /** Why it failed, for a failed one (XCOD-299). */
  error?: string
}

/** What the TUI knows about a subagent's own session. */
export type ChildInfo = {
  /** Its session status type: "busy", "retry", "idle". */
  status?: string
  /** It has a permission request or a question open. */
  waiting?: boolean
  /** It is waiting for a slot (`subagent.max_parallel`), from its session metadata. */
  queued?: boolean
  /** Why its last turn failed, when it did (XCOD-299: a background one's tool call never errors). */
  error?: string
}

type TaskLikePart = {
  type: string
  tool?: string
  state?: {
    status: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number }
    error?: unknown
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

function modelOf(value: unknown) {
  if (!value || typeof value !== "object") return
  const model = value as { providerID?: unknown; modelID?: unknown }
  if (typeof model.providerID !== "string" || typeof model.modelID !== "string") return
  return `${model.providerID}/${model.modelID}`
}

/**
 * The subagents a session launched, from its own `task` tool calls, in launch order. A call that has
 * no child session yet (pending) is left out. A background subagent's tool call finishes at once, so
 * its live state comes from its session instead.
 */
export function subagentsOf(parts: readonly TaskLikePart[], child: (sessionID: string) => ChildInfo): SubagentEntry[] {
  const index = new Map<string, number>()
  const result: SubagentEntry[] = []
  for (const part of parts) {
    if (part.type !== "tool" || part.tool !== "task" || !part.state) continue
    const id = text(part.state.metadata?.sessionId)
    if (!id) continue
    const background = part.state.metadata?.background === true
    const info = child(id)
    const busy = info.status !== undefined && info.status !== "idle"
    const live = part.state.status === "running" || (background && (busy || info.queued === true))
    const state: SubagentState =
      part.state.status === "error" || (background && !live && info.error)
        ? "failed"
        : !live
          ? "done"
          : info.waiting
            ? "waiting"
            : info.queued && !busy
              ? "queued"
              : "running"
    const entry: SubagentEntry = {
      id,
      agent: text(part.state.input?.subagent_type) ?? "general",
      description: text(part.state.input?.description) ?? "",
      state,
      background,
      model: modelOf(part.state.metadata?.model),
      started: part.state.time?.start,
      ended: background ? undefined : part.state.time?.end,
      error: state === "failed" ? (text(part.state.error) ?? info.error) : undefined,
    }
    // Resuming a subagent (task_id) calls the tool again on the same session: keep its place, take
    // the newest call's state.
    const at = index.get(id)
    if (at === undefined) {
      index.set(id, result.length)
      result.push(entry)
    } else result[at] = entry
  }
  return result
}

/** Display order: waiting, running, queued, done, failed; launch order within each. */
export function ordered(entries: readonly SubagentEntry[]) {
  return entries
    .map((entry, at) => ({ entry, at }))
    .toSorted((a, b) => STATE_ORDER.indexOf(a.entry.state) - STATE_ORDER.indexOf(b.entry.state) || a.at - b.at)
    .map((item) => item.entry)
}

/** "42s", "3m 05s", "1h 02m". */
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

/** "12.3k", "940". */
export function tokens(count: number) {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}
