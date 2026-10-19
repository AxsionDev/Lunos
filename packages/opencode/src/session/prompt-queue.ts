export * as SessionPromptQueue from "./prompt-queue"

import { randomBytes } from "crypto"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { AuditLog } from "@/audit/log"
import { registerDisposer } from "@/effect/instance-registry"
import { SessionLive } from "./live"
import { SessionOverview } from "./overview"
import { SessionPeerControl } from "./peer-control"
import { SessionPeers } from "./peers"
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
 *
 * Held prompts are also written to this process's peer file (SessionPeers, 0600) before each change
 * takes effect, so they outlive it. When it exits with prompts held, the session shows "N queued
 * (owner closed)", and nothing sends them until another Lunos takes the session over (`takeover`),
 * which the user confirms. Each prompt leaves a file before it is sent or moved, so a crash at any
 * point never sends one twice: delivery is at most once, and a crash at the wrong moment can lose
 * the one prompt in flight.
 */

export const MAX_TEXT = SessionPeerControl.MAX_PROMPT

export type Delivery = "now" | "queued" | "interrupted" | "answered"

export type Entry = {
  /** Names the prompt in the peer file and in the audit, never its text. */
  id: string
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

/** Writes the session's queue to the peer file now (before anything is sent), then tells the windows. */
function changed(sessionID: string, directory: string) {
  const queue = queues.get(sessionID) ?? []
  SessionPeers.setQueue(sessionID, queue)
  SessionLive.setQueued(sessionID, queue.length, directory)
}

const newID = () => `qp_${randomBytes(8).toString("hex")}`

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

/**
 * Projects being closed. Closing stops their sessions, which then read as idle, but that isn't a
 * turn ending: the prompts stay held (and in the file) rather than go to a project that is going away.
 */
const closing = new Set<string>()
/** How long after a project closed its held prompts wait: long enough for a quitting process to exit. */
const REOPEN_MS = 1_000

/** The session's oldest held prompt, sent as its next turn. Out of the file before it is sent. */
function next(sessionID: string) {
  const queue = queues.get(sessionID)
  const entry = queue?.[0]
  // This process is going away (its file is final): what it holds stays there for a take-over.
  if (!entry || closing.has(entry.directory) || SessionPeers.closed()) return undefined
  queue!.shift()
  if (queue!.length === 0) queues.delete(sessionID)
  changed(sessionID, entry.directory)
  return send(entry)
}

/** The session's turn ended: its oldest held prompt is its next turn. */
function drain(sessionID: string) {
  void next(sessionID)?.catch(() => {
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
  // Called as a project starts closing, before its sessions stop and read as idle. A project that
  // closes while this process stays (a config reload) gets its held prompts moving again after a
  // moment; a quitting process exits first (the timer doesn't hold it open).
  registerDisposer(async (directory) => {
    closing.add(directory)
    setTimeout(() => {
      closing.delete(directory)
      for (const [sessionID, queue] of queues)
        if (queue[0]?.directory === directory && !SessionLive.get(sessionID).status) drain(sessionID)
    }, REOPEN_MS).unref?.()
  })
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
export async function submit(input: Omit<Entry, "id"> & { interrupt?: boolean; via?: "local" | "peer" }) {
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
    id: newID(),
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

/** Tests: a hook after each prompt leaves a stopped process's file, to stand in for a crash there. */
export const testing: { moved?: (id: string) => void } = {}

/**
 * XCOD-262: takes over a session whose Lunos stopped with prompts queued for it, after the user
 * confirmed it. `queued: "send"` runs them here first, in the order they were queued, one per turn,
 * then `text` (the prompt being sent, if any); "discard" drops them. Refused while the process that
 * queued them still exists (stopped or suspended, it could still send them itself).
 *
 * Each prompt is removed from the old file before it joins this process's queue (and file), so a
 * crash part-way never sends one twice; the prompts not yet moved stay for the next take-over.
 * Audited as `session.takeover` with counts and prompt ids, never the text.
 */
export async function takeover(input: {
  sessionID: string
  directory: string
  queued: "send" | "discard"
  text?: string
  agent?: string
}) {
  start()
  const release = SessionPeers.lockTakeover(input.sessionID)
  try {
    const held = SessionPeers.orphaned(input.sessionID)
    if (held.some((item) => !item.gone))
      throw new Error(
        "The Lunos that queued prompts for this session is still running, but not responding. Close it, or try again once it has.",
      )
    const ids: string[] = []
    for (const item of held)
      for (const prompt of item.entries) {
        SessionPeers.removeHeld(item.file, input.sessionID, prompt.id)
        testing.moved?.(prompt.id)
        ids.push(prompt.id)
        if (input.queued !== "send") continue
        const queue = queues.get(input.sessionID) ?? []
        queue.push({
          id: prompt.id,
          sessionID: input.sessionID,
          directory: input.directory,
          text: prompt.text,
          ...(input.agent ? { agent: input.agent } : {}),
        })
        queues.set(input.sessionID, queue)
        changed(input.sessionID, input.directory)
      }
    const sent = input.queued === "send" ? ids.length : 0
    AuditLog.emit("session.takeover", {
      session: input.sessionID,
      origin: "monitor",
      queued: input.queued,
      sent,
      discarded: ids.length - sent,
      ids,
    })
    // The new prompt goes behind the ones taken over, so they run in the order they were written.
    let delivery: Delivery | undefined
    let position: number | undefined
    if (input.text !== undefined) {
      const queue = queues.get(input.sessionID) ?? []
      const busy = !!SessionLive.get(input.sessionID).status
      delivery = queue.length > 0 || busy ? "queued" : "now"
      queue.push({
        id: newID(),
        sessionID: input.sessionID,
        directory: input.directory,
        text: input.text,
        ...(input.agent ? { agent: input.agent } : {}),
      })
      queues.set(input.sessionID, queue)
      // Its place once the head (when nothing runs) has gone.
      position = delivery === "queued" ? queue.length - (busy ? 0 : 1) : undefined
      changed(input.sessionID, input.directory)
      AuditLog.emit("session.prompt", { session: input.sessionID, origin: "monitor", delivery, via: "local" })
    }
    // Nobody runs the session now: its first prompt goes now, the rest as each turn ends.
    if (!SessionLive.get(input.sessionID).status) await next(input.sessionID)
    return { sent, discarded: ids.length - sent, ...(delivery ? { delivery } : {}), ...(position ? { position } : {}) }
  } finally {
    release()
  }
}

/** For tests. */
export function reset() {
  const held = [...queues.keys()]
  queues.clear()
  closing.clear()
  for (const sessionID of held) {
    SessionPeers.setQueue(sessionID, [])
    SessionLive.setQueued(sessionID, 0, "")
  }
}
