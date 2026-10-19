export * as SessionPromptQueue from "./prompt-queue"

import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AuditLog } from "@/audit/log"
import { SessionLive } from "./live"
import { SessionOverview } from "./overview"
import { SessionPeerControl } from "./peer-control"
import type { Session } from "./session"

/**
 * XCOD-262: prompts the Agent Monitor sends to a session this process runs. A session that is idle
 * gets the prompt as its next turn now; one that is busy (running, or waiting on an approval) holds
 * it here until the turn ends, first in first out, one prompt per turn. Sending to a busy session
 * directly would slip the text into the running turn instead.
 *
 * Everything goes through this process's own HTTP API (`/session/:id/prompt_async`, `/abort`,
 * `/question/:id/reply`), the same calls its window makes, so the session's agent, policy and
 * residency apply exactly as if the prompt were typed there. A prompt is never an approval: a
 * session waiting on a permission holds the prompt, and the permission still needs its own answer.
 */

export const MAX_TEXT = SessionPeerControl.MAX_PROMPT

export type Delivery = "now" | "queued" | "interrupted" | "answered"

export type Entry = {
  sessionID: string
  directory: string
  text: string
  agent?: string
  /** A session the monitor just started: the model picked there. */
  model?: { providerID: string; modelID: string }
  variant?: string
}

/** A pending question, as the session's own question route lists it. */
type PendingQuestion = { id: string; sessionID: string; questions: Array<{ custom?: boolean }> }

/**
 * What to do with a prompt for a session in this state. Pure: the "never approves" rule lives here.
 *
 * - waiting on a permission: hold it, even with `interrupt`. Answering it would mean approving or
 *   denying a tool call, and stopping the turn would drop it unanswered.
 * - waiting on one question that takes a typed answer: the prompt is the answer.
 * - busy: hold it, or with `interrupt`, stop the turn and send it first.
 * - idle: send it now.
 */
export function decide(input: {
  busy: boolean
  permissions: number
  question?: { questions: number; custom: boolean }
  interrupt?: boolean
}): Delivery {
  // Not even Ctrl+Enter: stopping the turn would drop the ask unanswered.
  if (input.permissions > 0) return "queued"
  if (input.question && input.question.questions === 1 && input.question.custom) return "answered"
  if (!input.busy) return "now"
  return input.interrupt ? "interrupted" : "queued"
}

/**
 * The agent a prompt runs with: the session's own, as if typed in it (prompt_async without one uses
 * the default agent). None for a Claude Code / Codex session: a Lunos mode such as plan would refuse
 * every approval the tool asks for, so its own window sends none either.
 */
export function agentFor(session: Pick<Session.Info, "agent" | "metadata">, lastUserAgent?: string) {
  if (SessionOverview.externalOf(session)) return undefined
  return session.agent ?? lastUserAgent
}

const queues = new Map<string, Entry[]>()

/** Tests: what's held for a session, oldest first. */
export function list(sessionID: string): readonly Entry[] {
  return queues.get(sessionID) ?? []
}

function changed(sessionID: string, directory: string) {
  SessionLive.setQueued(sessionID, queues.get(sessionID)?.length ?? 0, directory)
}

async function expect(response: Response, what: string) {
  if (response.ok) return
  const text = await response.text().catch(() => "")
  throw new Error(`${what} failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`)
}

async function send(entry: Entry) {
  await expect(
    await SessionPeerControl.api(`/session/${entry.sessionID}/prompt_async`, entry.directory, {
      method: "POST",
      body: JSON.stringify({
        ...(entry.agent ? { agent: entry.agent } : {}),
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.variant ? { variant: entry.variant } : {}),
        parts: [{ type: "text", text: entry.text }],
      }),
    }),
    "Sending the prompt",
  )
}

/** The session's turn ended: its oldest held prompt is its next turn. */
function drain(sessionID: string) {
  const queue = queues.get(sessionID)
  const next = queue?.shift()
  if (!next) return
  if (queue!.length === 0) queues.delete(sessionID)
  changed(sessionID, next.directory)
  void send(next).catch(() => {
    // The session can't take it (deleted, its project closed): nothing else would ever send it.
  })
}

function onEvent(event: GlobalEvent) {
  const payload = event.payload
  if (payload?.type !== "session.status") return
  const props = (payload.properties ?? {}) as { sessionID?: unknown; status?: { type?: unknown } }
  if (typeof props.sessionID !== "string" || props.status?.type !== "idle") return
  if (!queues.has(props.sessionID)) return
  // After SessionLive has seen the same event, so the session reads as idle when the prompt lands.
  queueMicrotask(() => drain(props.sessionID as string))
}

let started = false
function start() {
  if (started) return
  started = true
  GlobalBus.on("event", onEvent)
}

async function pendingQuestion(sessionID: string, directory: string) {
  const response = await SessionPeerControl.api("/question", directory)
  if (!response.ok) return undefined
  const list = (await response.json()) as PendingQuestion[]
  return list.find((item) => item.sessionID === sessionID)
}

/**
 * Delivers a monitor prompt to a session this process runs (or that nobody runs). Audited as
 * `session.prompt` with `origin: "monitor"`: the session, how it was delivered and whether another
 * process forwarded it; never the text.
 */
export async function submit(input: Entry & { interrupt?: boolean; via?: "local" | "peer" }) {
  start()
  const activity = SessionLive.get(input.sessionID)
  const busy = !!activity.status || activity.permissions > 0 || activity.questions > 0
  const question =
    activity.questions > 0 && activity.permissions === 0
      ? await pendingQuestion(input.sessionID, input.directory)
      : undefined
  const delivery = decide({
    busy,
    permissions: activity.permissions,
    question: question
      ? { questions: question.questions.length, custom: question.questions[0]?.custom !== false }
      : undefined,
    interrupt: input.interrupt,
  })
  const entry: Entry = {
    sessionID: input.sessionID,
    directory: input.directory,
    text: input.text,
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.variant ? { variant: input.variant } : {}),
  }
  let position: number | undefined
  if (delivery === "answered") {
    await expect(
      await SessionPeerControl.api(`/question/${question!.id}/reply`, input.directory, {
        method: "POST",
        body: JSON.stringify({ answers: [[input.text]] }),
      }),
      "Answering the question",
    )
  } else if (delivery === "now") {
    await send(entry)
  } else {
    const queue = queues.get(input.sessionID) ?? []
    // Ctrl+Enter: this prompt goes before anything already held, and stopping the turn sends it.
    if (delivery === "interrupted") queue.unshift(entry)
    else queue.push(entry)
    queues.set(input.sessionID, queue)
    position = delivery === "interrupted" ? 1 : queue.length
    changed(input.sessionID, input.directory)
    if (delivery === "interrupted")
      await expect(
        await SessionPeerControl.api(`/session/${input.sessionID}/abort`, input.directory, { method: "POST" }),
        "Stopping the turn",
      )
  }
  AuditLog.emit("session.prompt", {
    session: input.sessionID,
    origin: "monitor",
    delivery,
    via: input.via ?? "local",
  })
  return { delivery, ...(position !== undefined ? { position } : {}) }
}

/** For tests. */
export function reset() {
  const held = [...queues.keys()]
  queues.clear()
  for (const sessionID of held) SessionLive.setQueued(sessionID, 0, "")
}
