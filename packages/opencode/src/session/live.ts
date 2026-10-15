export * as SessionLive from "./live"

import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { SessionPeers } from "./peers"

/**
 * XCOD-205: what every session served by this process is doing right now, across all projects,
 * for the Sessions window. Session status and pending approvals live in per-project instance
 * state; this listens to the process-wide bus instead, so one request can answer for every
 * project. Sessions run by another Lunos process (a separate TUI) aren't seen here; XCOD-234 shares
 * this process's with them through SessionPeers.
 */

export type Activity = { status?: "busy" | "retry"; permissions: number; questions: number }

const status = new Map<string, { type: "busy" | "retry"; directory?: string }>()
const asks = new Map<string, { sessionID: string; kind: "permission" | "question"; directory?: string }>()

function drop(predicate: (directory: string | undefined, sessionID: string) => boolean) {
  for (const [id, item] of status) if (predicate(item.directory, id)) status.delete(id)
  for (const [id, item] of asks) if (predicate(item.directory, item.sessionID)) asks.delete(id)
}

let pending: ReturnType<typeof setTimeout> | undefined

/** XCOD-234: tell other Lunos processes what this one's sessions are doing (debounced). */
function share() {
  if (!started || pending) return
  pending = setTimeout(() => {
    pending = undefined
    SessionPeers.publish(Object.fromEntries([...active()].map((id) => [id, get(id)])))
  }, 50)
  pending.unref?.()
}

export function handle(event: GlobalEvent) {
  apply(event)
  share()
}

function apply(event: GlobalEvent) {
  const payload = event.payload
  if (!payload || typeof payload !== "object") return
  const props = (payload.properties ?? {}) as Record<string, any>
  switch (payload.type) {
    case "session.status": {
      const sessionID = props.sessionID
      const type = props.status?.type
      if (typeof sessionID !== "string") return
      if (type === "busy" || type === "retry") {
        status.set(sessionID, { type, directory: event.directory })
        return
      }
      // An idle session can't be waiting on a prompt. Stopping a session drops its pending
      // approvals without a "replied" event, so this is where they are forgotten.
      drop((_, id) => id === sessionID)
      return
    }
    case "permission.asked":
    case "permission.v2.asked":
    case "question.asked":
    case "question.v2.asked":
      if (typeof props.id === "string" && typeof props.sessionID === "string")
        asks.set(props.id, {
          sessionID: props.sessionID,
          kind: payload.type.startsWith("permission") ? "permission" : "question",
          directory: event.directory,
        })
      return
    case "permission.replied":
    case "permission.v2.replied":
    case "question.replied":
    case "question.v2.replied":
    case "question.rejected":
    case "question.v2.rejected":
      if (typeof props.requestID === "string") asks.delete(props.requestID)
      return
    case "session.deleted": {
      const sessionID = props.sessionID ?? props.info?.id
      if (typeof sessionID === "string") drop((_, id) => id === sessionID)
      return
    }
    // A disposed instance drops its pending approvals and stops its runs without per-request events.
    case "server.instance.disposed":
      if (typeof props.directory === "string") drop((directory) => directory === props.directory)
      return
    case "global.disposed":
      drop(() => true)
      return
  }
}

let started = false

/** Starts listening. Idempotent; the server calls it once at startup. */
export function start() {
  if (started) return
  started = true
  GlobalBus.on("event", handle)
}

export function get(sessionID: string): Activity {
  let permissions = 0
  let questions = 0
  for (const item of asks.values()) {
    if (item.sessionID !== sessionID) continue
    if (item.kind === "permission") permissions++
    else questions++
  }
  return { status: status.get(sessionID)?.type, permissions, questions }
}

/** Session ids this process knows to be running or waiting, so they're listed however old they are. */
export function active() {
  return new Set([...status.keys(), ...[...asks.values()].map((item) => item.sessionID)])
}

/** For tests. */
export function reset() {
  status.clear()
  asks.clear()
  if (pending) clearTimeout(pending)
  pending = undefined
}
