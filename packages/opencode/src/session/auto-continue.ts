import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * XCOD-302: why a turn ended, and whether Lunos should carry on by itself.
 *
 * Some models end a turn by announcing the next step ("Next I'll implement…") without taking it,
 * and the session then sits idle until the user types "proceed". At the end of every turn of an
 * agent that opts in (Dev-Cycle, Build), the loop classifies the stop from the turn's messages and
 * the agent's position (for Dev-Cycle, the cycle file's frontmatter) and, on a stall only, sends a
 * short internal continuation.
 *
 * Everything here is pure and knows nothing about Dev-Cycle: the caller describes its position as
 * a `Position`, so other workflows (XCOD-303) can reuse the classification with their own state.
 */

/** At most this many continuations in a row without progress (a tool call or a file change). */
export const MAX = 3

/** Marks the internal continuation message: `metadata[METADATA] = { label, attempt }`. */
export const METADATA = "auto_continue"
/** Marks the message the "Continue" button sends after Lunos gave up: a reset, never an approval. */
export const RESUME = "auto_continue_resume"

/** Where the agent stands, as the caller reads it. */
export type Position = {
  /** The position can't be read; the agent was told to ask, so never continue. */
  unknown: boolean
  /** The work is finished (for Dev-Cycle: gate 3 approved). */
  done: boolean
  /** The current step ends in a gate the human hasn't approved yet. */
  pending: boolean
  /** Shown in brackets after "continued automatically", e.g. "plan approved → build". */
  label?: string
  /** When the human approved the pending gate this turn: the label, and what to tell the model. */
  approved?: { label?: string; note?: string }
}

export type Stop =
  | { kind: "error"; reason: string }
  | { kind: "question" }
  | { kind: "unknown" }
  | { kind: "done" }
  | { kind: "finished" }
  | { kind: "gate" }
  | { kind: "stalled"; label?: string; note?: string }

export type Input = {
  /** The session's messages, oldest first (the loop's `msgs`). */
  messages: readonly SessionV1.WithParts[]
  position: Position
  /** A turn that ends with no text at all counts as a stall (Dev-Cycle), not as finished (Build). */
  emptyStalls: boolean
  /** Set when a step limit was reached: the turn stops, with this reason. */
  limit?: string
}

const flatten = (text: string) => text.replace(/[’‘]/g, "'")

/** The words the model said at the end of the turn: the last assistant message's text parts only. */
export function finalText(message: SessionV1.WithParts | undefined) {
  if (!message || message.info.role !== "assistant") return ""
  return message.parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n")
    .trim()
}

/** The last paragraph, which is where an announcement or a question to the user sits. */
function tail(text: string) {
  const paragraphs = flatten(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  return paragraphs.at(-1) ?? ""
}

// First person, future tense: what the model says it is about to do.
const ANNOUNCE =
  /\b(?:i'll|i will|i'm going to|i am going to|i'm about to|let me|let's)\b|\b(?:moving|proceeding|continuing|turning)\s+(?:on\s+)?(?:to|with)\b|\bnext up\b|\bstarting (?:on|with|the)\b/i
// ... unless it hands the turn back: waiting for the human, or offering rather than doing.
const HANDBACK =
  /\b(?:wait|waiting|await|awaiting|pause|hold off|stop here|once you|after you|when you|until you|if you|let me know|your (?:approval|confirmation|go-ahead|review|answer|input|decision))\b/i

/** Whether the turn ends by announcing work it didn't do ("Next I'll implement the host…"). */
export function announces(text: string) {
  const last = tail(text)
  return ANNOUNCE.test(last) && !HANDBACK.test(last)
}

/** Whether the turn ends with a direct question to the user. */
export function asks(text: string) {
  const line = flatten(text)
    .split("\n")
    .map((l) => l.replace(/[*_`\s)]+$/g, "").trim())
    .filter(Boolean)
    .at(-1)
  return !!line && line.endsWith("?")
}

// Whole-message approvals only: a miss means the user types "proceed", which is the old behaviour,
// while a false approval would pass a gate.
const APPROVAL =
  /^(?:yes|y|ok|okay|sure|approved?|approve it|lgtm|proceed|go|go ahead|continue|accept|accepted|looks good|sounds good|ship it)(?: (?:the )?(?:plan|architecture|design|gate(?: \d)?|it))?(?: please)?(?:,? (?:and )?(?:proceed|continue|go ahead|carry on))?$/
const REJECTION = /\b(?:no|not|don't|do not|reject|rejected|revise|change|changes|wait|stop)\b/

/** Whether a human answer (a typed message or a picked option) approves a gate. */
export function approves(text: string) {
  const normal = flatten(text)
    .toLowerCase()
    .replace(/[.!\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!normal || normal.length > 60 || REJECTION.test(normal)) return false
  if (APPROVAL.test(normal)) return true
  // An option label the model wrote for the question tool: "Approve", "Approve plan (gate 2)".
  return /^(?:approve|approved|accept|yes)\b/.test(normal)
}

const marked = (message: SessionV1.WithParts, key: string) =>
  message.parts.some((part) => part.type === "text" && part.metadata?.[key] !== undefined)

/** The continuation Lunos sent, rather than anything the human wrote. */
export const isContinuation = (message: SessionV1.WithParts) =>
  message.info.role === "user" && marked(message, METADATA)

const progressed = (messages: readonly SessionV1.WithParts[], user: SessionV1.WithParts) =>
  messages.some(
    (message) =>
      message.info.role === "assistant" &&
      message.info.parentID === user.info.id &&
      message.parts.some((part) => part.type === "tool" || part.type === "patch"),
  )

/** How many continuations in a row, ending now, made no progress. */
export function streak(messages: readonly SessionV1.WithParts[]) {
  let count = 0
  for (const message of [...messages].reverse()) {
    if (message.info.role !== "user") continue
    if (!isContinuation(message) || progressed(messages, message)) break
    count++
  }
  return count
}

const GATE = /\b(?:approv\w*|gate)\b/i

/** Which of a `question` call's questions put a gate to the human (by their wording), by index. */
function gateQuestions(part: SessionV1.Part) {
  if (part.type !== "tool" || part.tool !== "question") return []
  const questions = (part.state.input?.questions ?? []) as ReadonlyArray<{ question?: string; header?: string }>
  return questions.flatMap((q, index) => (GATE.test(`${q.header ?? ""} ${q.question ?? ""}`) ? [index] : []))
}

/** Whether the turn before `index` put a gate to the human: a gate question (even a dismissed one) or asking in text. */
function askedForApproval(messages: readonly SessionV1.WithParts[], index: number) {
  const turn: SessionV1.WithParts[] = []
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role === "user") {
      if (isContinuation(message)) continue
      break
    }
    turn.push(message)
  }
  if (turn.some((message) => message.parts.some((part) => gateQuestions(part).length > 0))) return true
  return GATE.test(tail(finalText(turn[0])))
}

/**
 * Whether the human approved a gate this turn: the answer to a gate question in the `question` tool,
 * or else the message that started the turn, but only as the reply to a gate the turn before put
 * to them. "proceed" in the middle of a phase is a nudge, not an approval, and a "Yes" to an
 * unrelated question approves nothing. The "Continue" button and Lunos's own continuations never
 * count.
 */
export function approved(messages: readonly SessionV1.WithParts[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role === "assistant") {
      for (const part of [...message.parts].reverse()) {
        const gates = gateQuestions(part)
        if (!gates.length || part.type !== "tool" || part.state.status !== "completed") continue
        const answers = (part.state.metadata?.answers ?? []) as ReadonlyArray<ReadonlyArray<string>>
        return gates.every((index) => !!answers[index]?.length && answers[index].every(approves))
      }
      continue
    }
    if (isContinuation(message)) continue
    if (marked(message, RESUME)) return false
    const typed = message.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
      .join("\n")
    return approves(typed) && askedForApproval(messages, i)
  }
  return false
}

const waiting = (messages: readonly SessionV1.WithParts[]) => {
  for (const message of [...messages].reverse()) {
    if (message.info.role === "user" && !isContinuation(message)) return false
    if (
      message.parts.some(
        (part) =>
          part.type === "tool" &&
          part.tool === "question" &&
          (part.state.status === "pending" || part.state.status === "running"),
      )
    )
      return true
  }
  return false
}

/** Why the turn ended. Only `stalled` continues; every other stop waits for the human. */
export function classify(input: Input): Stop {
  const last = input.messages.findLast((message) => message.info.role === "assistant")
  if (!last || last.info.role !== "assistant") return { kind: "finished" }
  if (last.info.error) return { kind: "error", reason: last.info.error.name }
  if (last.info.finish && last.info.finish !== "stop") return { kind: "error", reason: `finish: ${last.info.finish}` }
  if (input.limit) return { kind: "error", reason: input.limit }
  if (waiting(input.messages)) return { kind: "question" }
  const text = finalText(last)
  if (asks(text)) return { kind: "question" }
  if (input.position.unknown) return { kind: "unknown" }
  if (input.position.done) return { kind: "done" }
  if (!announces(text) && !(input.emptyStalls && !text)) return { kind: "finished" }
  if (!input.position.pending) return { kind: "stalled", label: input.position.label }
  // A continuation never passes a gate: only the human's approval this turn lets it go on.
  if (input.position.approved && approved(input.messages))
    return { kind: "stalled", label: input.position.approved.label, note: input.position.approved.note }
  return { kind: "gate" }
}

/** The dim line in the transcript: "Dev-Cycle continued automatically (plan approved → build)". */
export function line(title: string, label?: string) {
  return `${title} continued automatically${label ? ` (${label})` : ""}`
}

/** What the model is told. Internal; the transcript shows `line()` instead. */
export function prompt(input: { gated: boolean; note?: string }) {
  return [
    input.gated
      ? "Continue the current phase now. Don't stop to announce next steps; stop only at a gate, a real question, the end, or an error."
      : "Continue the task now. Don't stop to announce next steps; do them. Stop only when the work is done and checked, to ask a real question with the question tool, or on an error.",
    input.note,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** Why Lunos stopped continuing. */
export function gaveUp(title: string) {
  return `${title} stopped making progress after ${MAX} retries.`
}

export * as AutoContinue from "./auto-continue"
