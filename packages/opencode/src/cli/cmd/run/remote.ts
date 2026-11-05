// XCOD-338: `lunos run --remote`. A run has no prompt to type `/remote` into, so the flag turns
// remote control on for the run's session before its prompt is sent, and off when the run ends.
// While it is on, approvals the run would refuse (nobody is at the terminal to answer them) wait for
// an answer from app.lunos.tech instead, and the agent may ask questions there.
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"

/** The flags `--remote` can't be used with yet, and why; undefined when it can. */
export function conflict(args: { remote?: boolean; mini?: boolean; cloud?: boolean; sandbox?: boolean }) {
  if (!args.remote) return undefined
  if (args.mini) return "--remote cannot be used with --mini yet; type /remote in the TUI instead"
  if (args.cloud) return "--remote cannot be used with --cloud: the session runs on a Lunos Cloud worker, not here"
  if (args.sandbox) return "--remote cannot be used with --sandbox yet"
  return undefined
}

/**
 * The non-interactive run's rules. Without --remote nobody can answer a question, or approve entering
 * or leaving plan mode, so all three are denied. With it, questions go to app.lunos.tech; plan mode
 * stays denied, since a run has no plan mode to come back from.
 */
export function rules(remote: boolean): PermissionV1.Ruleset {
  return [
    ...(remote ? [] : [{ permission: "question", action: "deny" as const, pattern: "*" }]),
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" },
  ]
}

/**
 * What the run does with an approval. --auto approves what it may (never a manual ask, XCOD-327);
 * with remote control on, the rest waits for app.lunos.tech; otherwise it is refused.
 */
export function onAsk(input: { auto: boolean; remote: boolean; manual: boolean }): "approve" | "wait" | "reject" {
  if (input.auto && !input.manual) return "approve"
  if (input.remote) return "wait"
  return "reject"
}

export type Status = { url: string; expiresAt?: number }

/** Turns remote control on for the session. Throws with the reason the process gave when it refuses. */
export async function start(client: OpencodeClient, sessionID: string): Promise<Status> {
  const res = await client.experimental.session.remoteSet({ sessionID, on: true }).catch((error: unknown) => ({
    error,
    data: undefined,
  }))
  if (res.data?.on && res.data.url) return { url: res.data.url, expiresAt: res.data.expiresAt }
  throw new Error(reason(res.error) ?? "Remote control couldn't be turned on")
}

/** Turns it off; never throws (the link also ends on its own when this process stops answering). */
export async function stop(client: OpencodeClient, sessionID: string) {
  await client.experimental.session.remoteSet({ sessionID, on: false }).catch(() => undefined)
}

function reason(error: unknown) {
  if (!error) return undefined
  if (error instanceof Error) return error.message
  const body = error as { message?: unknown; data?: { message?: unknown } }
  if (typeof body.message === "string") return body.message
  if (typeof body.data?.message === "string") return body.data.message
  return undefined
}

export * as RunRemote from "./remote"
