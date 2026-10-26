import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { DynamicWorkflows } from "./workflows"

/**
 * XCOD-302: why a turn ended, and whether Lunos should carry on by itself.
 *
 * Some models end a turn by announcing the next step ("Next I'll implement…") without taking it,
 * and the session then sits idle until the user types "proceed". At the end of every turn of an
 * agent that opts in (Dev-Cycle, Build), the loop classifies the stop from the turn's messages and
 * the agent's position (for Dev-Cycle, the cycle file's frontmatter) and, on a stall only, sends a
 * short internal continuation.
 *
 * XCOD-324: in a Dynamic workflow the turn's open work decides, not its wording. A turn that ends
 * with a status report ("…remains in the build phase while I address them") while qa's checks
 * failed, todos are open, the phase is unfinished or a failed subagent step may be retried has
 * stalled too. It stops for the human only when the human is needed (see `why`).
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

/** XCOD-324: the work a Dynamic workflow's turn left open, read from the session's messages. */
export type Work = {
  /** The ✗ lines of qa's latest Verification block (none once it passes, or before qa ran). */
  gaps: string[]
  /** qa's latest Verification block: how many of its checks passed. */
  check?: { passing: number; total: number }
  /** qa reports in a row, ending with the latest, whose Verification block failed. */
  rounds: number
  /** Todo items neither completed nor cancelled. */
  todos: number
  /** Subagent steps whose latest run failed. */
  failed: { description: string; error: string; exhausted: boolean }[]
  /** A subagent finished work that no passing qa report has checked since. */
  unverified: boolean
}

export type Stop =
  | { kind: "error"; reason: string }
  | { kind: "question" }
  | { kind: "unknown" }
  | { kind: "done" }
  | { kind: "finished" }
  | { kind: "gate" }
  /** XCOD-324: a subagent reported a secret, credential or `.env` value only the human has. */
  | { kind: "secret"; reason: string }
  /** XCOD-324: a step, or qa's gaps, re-dispatched `MAX_REDISPATCH` times and still failing. */
  | { kind: "exhausted"; reason: string }
  | { kind: "stalled"; label?: string; note?: string; work?: Work }

export type Input = {
  /** The session's messages, oldest first (the loop's `msgs`). */
  messages: readonly SessionV1.WithParts[]
  position: Position
  /** A turn that ends with no text at all counts as a stall (Dev-Cycle), not as finished (Build). */
  emptyStalls: boolean
  /** Set when a step limit was reached: the turn stops, with this reason. */
  limit?: string
  /** XCOD-324: a Dynamic workflow, where open work continues the turn. Off: the XCOD-302 rules alone. */
  dynamic?: boolean
  /** XCOD-324: mid-phase by the agent's own state (Dev-Cycle: a cycle file, neither done nor gated). */
  midPhase?: boolean
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

/**
 * Whether the turn a continuation started made progress: a tool call or a file change, or (XCOD-324)
 * a changed check result. A subagent's task result is a tool part, and a background one arrives as
 * a message of its own, which ends the streak in `streak` by itself.
 */
const progressed = (messages: readonly SessionV1.WithParts[], index: number) => {
  const user = messages[index]
  if (
    messages.some(
      (message) =>
        message.info.role === "assistant" &&
        message.info.parentID === user.info.id &&
        message.parts.some((part) => part.type === "tool" || part.type === "patch"),
    )
  )
    return true
  const next = messages.findIndex((message, i) => i > index && message.info.role === "user")
  const before = work(messages.slice(0, index)).check
  const after = work(next === -1 ? messages : messages.slice(0, next)).check
  return before?.passing !== after?.passing || before?.total !== after?.total
}

/** How many continuations in a row, ending now, made no progress. */
export function streak(messages: readonly SessionV1.WithParts[]) {
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "user") continue
    if (!isContinuation(message) || progressed(messages, i)) break
    count++
  }
  return count
}

// A Verification block: its heading, then one ✓ or ✗ line per check (qa-proof.txt).
const HEADING = /^[#*_\s]*verification\b[*_:\s]*$/i
const CHECK = /^\s*(?:[-*]\s*)?([✓✔✗✘])\s*(.*)$/

/** The checks of the last Verification block in a report, or undefined if it has none. */
export function verification(text: string) {
  const lines = text.split("\n")
  const start = lines.findLastIndex((line) => HEADING.test(line))
  if (start === -1) return
  const checks: { ok: boolean; text: string }[] = []
  for (const line of lines.slice(start + 1)) {
    const match = CHECK.exec(line)
    if (match) {
      checks.push({ ok: match[1] === "✓" || match[1] === "✔", text: match[2]!.trim() })
      continue
    }
    if (line.trim() && checks.length) break
  }
  return checks.length ? checks : undefined
}

// What only the human can supply: a secret, a credential, an `.env` value, said to be missing.
const SECRET =
  /\.env\b|\b(?:secrets?|credentials?|api[ _-]?keys?|access tokens?|tokens?|passwords?)\b|\benv(?:ironment)? var/i
const MISSING =
  /\b(?:missing|isn't set|is not set|not set|unset|not configured|isn't configured|not provided|no (?:api[ _-]?key|secret|credentials?|access token|token|password))\b/i
const UNSET = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b[^.\n]*?\b(?:isn't|is not|not|wasn't|was not) (?:set|defined|configured)\b/

/** Whether a failed check or step needs a secret, credential or `.env` value only the human has. */
export function needsSecret(text: string) {
  return (SECRET.test(text) && MISSING.test(text)) || UNSET.test(text)
}

type ToolState = {
  status: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Step = { key: string; agent: string; description: string; input: Record<string, unknown> }

const TASK_RESULT = /<task id="([^"]+)" state="(completed|error)">([\s\S]*)<\/task>/

/**
 * XCOD-324: the open work in a Dynamic workflow: qa's latest Verification block, the todo list,
 * and subagent steps whose latest run failed. A subagent's result is read from its task call, or
 * from the message a background one sends when it lands; the main agent's own text never counts
 * (its report repeats qa's block). With `agent`, only that agent's own dispatches count, not a
 * subtask a command started (its message is the subagent's).
 */
export function work(messages: readonly SessionV1.WithParts[], agent?: string): Work {
  const result: Work = { gaps: [], rounds: 0, todos: 0, failed: [], unverified: false }
  // Each step, known by its subagent session, and the latest outcome of each step.
  const steps = new Map<string, Step>()
  const outcomes = new Map<string, { description: string; error?: string; input: Record<string, unknown> }>()

  const qaReport = (text: string) => {
    const checks = verification(text)
    if (!checks) return
    const gaps = checks.filter((check) => !check.ok).map((check) => check.text)
    result.gaps = gaps
    result.check = { passing: checks.length - gaps.length, total: checks.length }
    result.rounds = gaps.length ? result.rounds + 1 : 0
    if (!gaps.length) result.unverified = false
  }
  const finished = (step: Step, text: string) => {
    outcomes.set(step.key, { description: step.description, input: step.input })
    if (step.agent === "qa") qaReport(text)
    else result.unverified = true
  }

  for (const message of messages) {
    if (message.info.role === "user") {
      for (const part of message.parts) {
        if (part.type !== "text" || !part.synthetic) continue
        const match = TASK_RESULT.exec(part.text)
        const step = match && steps.get(match[1]!)
        if (!step) continue
        if (match[2] === "completed") {
          finished(step, match[3]!)
          continue
        }
        outcomes.set(step.key, { description: step.description, error: firstLine(match[3]!), input: step.input })
      }
      continue
    }
    if (agent && message.info.agent !== agent) continue
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      const state = part.state as ToolState
      const input = state.input ?? {}
      if (part.tool === "todowrite" && state.status === "completed") {
        const todos = (input.todos ?? []) as ReadonlyArray<{ status?: string }>
        result.todos = todos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled").length
        continue
      }
      if (part.tool !== "task" || (state.status !== "completed" && state.status !== "error")) continue
      const type = String(input.subagent_type ?? "")
      const description = String(input.description ?? "")
      const session = typeof state.metadata?.sessionId === "string" ? state.metadata.sessionId : undefined
      const resumed = typeof input.task_id === "string" ? steps.get(input.task_id) : undefined
      const key = resumed?.key ?? `${type}\n${description}`
      const step = { key, agent: type, description, input }
      if (session) steps.set(session, step)
      if (state.status === "error") {
        outcomes.set(key, { description, error: firstLine(state.error ?? ""), input })
        continue
      }
      // Still running in the background: its result lands later, as a message of its own.
      if (state.metadata?.background === true && /state="running"/.test(state.output ?? "")) continue
      finished(step, state.output ?? "")
    }
  }

  for (const outcome of outcomes.values()) {
    if (outcome.error === undefined) continue
    const call = {
      subagent_type: String(outcome.input.subagent_type ?? ""),
      description: outcome.description,
      ...(typeof outcome.input.task_id === "string" ? { task_id: outcome.input.task_id } : {}),
    }
    result.failed.push({
      description: outcome.description,
      error: outcome.error,
      exhausted:
        /re-dispatched \d+ times/.test(outcome.error) ||
        DynamicWorkflows.dispatches(messages, call) > DynamicWorkflows.MAX_REDISPATCH,
    })
  }
  return result
}

const firstLine = (text: string) =>
  text
    .replace(/<\/?task_(?:result|error)>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? ""

/** Whether the work is still open: what makes a Dynamic workflow's turn a stall. */
export const open = (work: Work) =>
  work.gaps.some((gap) => !needsSecret(gap)) ||
  work.todos > 0 ||
  work.failed.some((step) => !step.exhausted && !needsSecret(step.error))

/** The quiet status in the continuation's line: "Working on 5 gaps · 3 todos open · check: 2/5 passing". */
export function status(work: Work) {
  const gaps = work.gaps.filter((gap) => !needsSecret(gap)).length
  const failed = work.failed.filter((step) => !step.exhausted).length
  return [
    gaps ? `Working on ${gaps} ${gaps === 1 ? "gap" : "gaps"}` : undefined,
    failed ? `${failed} failed ${failed === 1 ? "step" : "steps"} to retry` : undefined,
    work.todos ? `${work.todos} ${work.todos === 1 ? "todo" : "todos"} open` : undefined,
    work.check ? `check: ${work.check.passing}/${work.check.total} passing` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
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

  // XCOD-324: the open work, in a Dynamic workflow only, and the stops it needs the human for.
  const found = input.dynamic ? work(input.messages, last.info.agent) : undefined
  if (found) {
    const secret =
      found.failed.find((step) => needsSecret(step.error))?.error ??
      (found.gaps.length && found.gaps.every(needsSecret) ? found.gaps[0] : undefined)
    if (secret) return { kind: "secret", reason: secret }
    const exhausted = found.failed.find((step) => step.exhausted)
    if (exhausted)
      return {
        kind: "exhausted",
        reason: `"${exhausted.description}" failed after ${DynamicWorkflows.MAX_REDISPATCH} re-dispatches`,
      }
    if (found.rounds > DynamicWorkflows.MAX_REDISPATCH)
      return { kind: "exhausted", reason: `qa still fails after ${DynamicWorkflows.MAX_REDISPATCH} rounds of fixes` }
  }
  // Mid-phase alone isn't open work (a plain answer in the build phase finishes): only while what a
  // subagent did there hasn't passed qa yet.
  const busy = !!found && (open(found) || (!!input.midPhase && found.unverified))
  if (!busy && !announces(text) && !(input.emptyStalls && !text)) return { kind: "finished" }
  const extra = busy && found ? { work: found } : {}
  if (!input.position.pending) return { kind: "stalled", label: input.position.label, ...extra }
  // A continuation never passes a gate: only the human's approval this turn lets it go on.
  if (input.position.approved && approved(input.messages))
    return { kind: "stalled", label: input.position.approved.label, note: input.position.approved.note, ...extra }
  return { kind: "gate" }
}

/** XCOD-324: why Lunos didn't continue, in one line, or nothing for a turn that simply finished. */
export function why(title: string, stop: Stop) {
  switch (stop.kind) {
    case "error":
      return `${title} stopped: ${stop.reason}.`
    case "question":
      return `${title} is waiting for your answer.`
    case "unknown":
      return `${title} stopped: its position can't be read.`
    case "done":
      return `${title} is done.`
    case "gate":
      return `${title} is waiting for your approval.`
    case "secret":
      return `${title} needs a value only you have: ${stop.reason}`
    case "exhausted":
      return `${title} needs you: ${stop.reason}.`
    default:
      return undefined
  }
}

/** The dim line in the transcript: "Dev-Cycle continued automatically (plan approved → build)". */
export function line(title: string, label?: string) {
  return `${title} continued automatically${label ? ` (${label})` : ""}`
}

/** What the model is told. Internal; the transcript shows `line()` instead. */
export function prompt(input: { gated: boolean; note?: string; work?: Work; maxParallel?: number }) {
  return [
    input.gated
      ? "Continue the current phase now. Don't stop to announce next steps; stop only at a gate, a real question, the end, or an error."
      : "Continue the task now. Don't stop to announce next steps; do them. Stop only when the work is done and checked, to ask a real question with the question tool, or on an error.",
    input.work ? openWork(input.work, input.maxParallel ?? 3) : undefined,
    input.note,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** XCOD-324: what's left, and how to go on with it, for a Dynamic workflow's orchestrator. */
function openWork(work: Work, maxParallel: number) {
  const gaps = work.gaps.filter((gap) => !needsSecret(gap))
  const waiting = work.gaps.filter(needsSecret)
  const failed = work.failed.filter((step) => !step.exhausted)
  if (gaps.length)
    return [
      `qa reported ${gaps.length} blocking ${gaps.length === 1 ? "gap" : "gaps"}; the work isn't done until qa passes:`,
      ...gaps.map((gap) => `- ✗ ${gap}`),
      `Don't report them and stop. Turn each gap into an item in the todo list, then dispatch subagents to fix them with the task tool: gaps that touch different files go out together, as several task calls in one message, at most ${maxParallel} at once; gaps in the same files go one after another. Then dispatch qa again to re-run the checks. Re-dispatch a fix at most ${DynamicWorkflows.MAX_REDISPATCH} times; after that, ask the user with the question tool.`,
      waiting.length
        ? `Leave these for the user, who has to supply the value, and say so in your report: ${waiting.join("; ")}`
        : undefined,
    ]
      .filter(Boolean)
      .join("\n")
  if (failed.length)
    return [
      `${failed.length === 1 ? "A subagent step" : "Subagent steps"} failed:`,
      ...failed.map((step) => `- ${step.description}: ${step.error}`),
      `Dispatch each again (pass its task_id so the same subagent continues), or dispatch a step that fixes the cause, then have qa verify. A step may be re-dispatched at most ${DynamicWorkflows.MAX_REDISPATCH} times.`,
    ].join("\n")
  if (work.unverified && !work.todos)
    return "What the subagents did in this phase hasn't been verified yet. Dispatch the `qa` subagent to check it, then go on with the phase."
  if (work.todos)
    return `${work.todos} ${work.todos === 1 ? "item" : "items"} in the todo list ${work.todos === 1 ? "isn't" : "aren't"} done. Dispatch the next steps, mark items done as their results come in, and have qa verify before you report.`
  return undefined
}

/** Why Lunos stopped continuing. */
export function gaveUp(title: string) {
  return `${title} stopped making progress after ${MAX} retries.`
}

export * as AutoContinue from "./auto-continue"
