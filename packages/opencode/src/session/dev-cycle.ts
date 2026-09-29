export const PHASES = ["discover", "architect", "plan", "build", "verify"] as const

export type Phase = (typeof PHASES)[number]
export type Gate = "pending" | "approved"
export type Cursor = { phase: Phase; gate: Gate }

export const DEFAULT_CURSOR: Cursor = { phase: "discover", gate: "pending" }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const FIELD = (name: string) => new RegExp(`^${name}:[ \\t]*(\\S+)[ \\t]*$`, "m")

/**
 * The outcome of reading the cursor, discriminated on whether the *phase* was
 * genuinely read from the file.
 *
 * Both arms carry a usable cursor; `ok` says whether to trust it. On the
 * `false` arm `cursor` is the degraded fallback — a position nobody wrote
 * down — and a caller that can address the reader should say so rather than
 * present it as fact.
 */
export type ParseResult = { ok: true; cursor: Cursor } | { ok: false; cursor: Cursor }

/**
 * Reads the phase cursor out of the artifact's frontmatter, reporting whether
 * the phase was actually found.
 *
 * Both the model and the human edit this block, so every input here is
 * untrusted: anything unrecognised degrades to DEFAULT_CURSOR rather than
 * throwing. A reminder that throws takes the whole turn down.
 *
 * `ok` is false only when the *phase* is unreadable — no frontmatter block, no
 * `phase:` line matching FIELD, or a value outside PHASES. An unreadable
 * `gate` is not a failure: it degrades to `pending` on its own, which errs
 * toward asking for an approval that may already have been given. An
 * unreadable phase degrades to `discover`, which rewinds the cycle to its
 * first step and invites redoing finished work — that is worth reporting.
 *
 * The strictness is deliberate and must stay: `phase: Architect` and
 * `phase: architect  # waiting` both fail to match, and a loud "I don't know
 * where we are" beats a quiet wrong guess.
 */
export function parseCursorResult(text: string | undefined): ParseResult {
  const block = text?.match(FRONTMATTER)?.[1]
  if (!block) return { ok: false, cursor: DEFAULT_CURSOR }

  const phase = block.match(FIELD("phase"))?.[1]
  const gate = block.match(FIELD("gate"))?.[1]

  const cursor: Cursor = {
    phase: PHASES.includes(phase as Phase) ? (phase as Phase) : DEFAULT_CURSOR.phase,
    gate: gate === "approved" ? "approved" : DEFAULT_CURSOR.gate,
  }
  return { ok: cursor.phase === phase, cursor }
}

/** The cursor alone, for callers that have nothing useful to do with a failure. */
export function parseCursor(text: string | undefined): Cursor {
  return parseCursorResult(text).cursor
}

export * as DevCycle from "./dev-cycle"
