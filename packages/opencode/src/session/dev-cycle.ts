export const PHASES = ["discover", "architect", "plan", "build", "verify"] as const

export type Phase = (typeof PHASES)[number]
export type Gate = "pending" | "approved"
export type Cursor = { phase: Phase; gate: Gate }

export const DEFAULT_CURSOR: Cursor = { phase: "discover", gate: "pending" }

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/
const FIELD = (name: string) => new RegExp(`^${name}:[ \\t]*(\\S+)[ \\t]*$`, "m")

/**
 * Reads the phase cursor out of the artifact's frontmatter.
 *
 * Both the model and the human edit this block, so every input here is
 * untrusted: anything unrecognised degrades to DEFAULT_CURSOR rather than
 * throwing. A cycle that cannot be parsed restarts at discover, which is
 * recoverable; a reminder that throws takes the whole turn down.
 */
export function parseCursor(text: string | undefined): Cursor {
  const block = text?.match(FRONTMATTER)?.[1]
  if (!block) return DEFAULT_CURSOR

  const phase = block.match(FIELD("phase"))?.[1]
  const gate = block.match(FIELD("gate"))?.[1]

  return {
    phase: PHASES.includes(phase as Phase) ? (phase as Phase) : DEFAULT_CURSOR.phase,
    gate: gate === "approved" ? "approved" : DEFAULT_CURSOR.gate,
  }
}

export * as DevCycle from "./dev-cycle"
