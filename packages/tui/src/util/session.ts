import type { OpencodeClient, SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { errorMessage } from "./error"

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}

/** XCOD-308: the longest session name (the server keeps the first 80 characters). */
export const RENAME_MAX = 80

/** XCOD-308: what the rename prompts say under their field. */
export const RENAME_HINT = `Up to ${RENAME_MAX} characters. Leave it empty to go back to the automatic name.`

/**
 * XCOD-308: what a rename sends, or undefined when nothing changes. The server trims it to one line
 * of at most 80 characters; an empty name (sent as "") hands the title back to the automatic one.
 */
export function renameValue(typed: string | null | undefined, current: string | undefined) {
  if (typed === null || typed === undefined) return undefined
  const name = typed.replace(/\s+/g, " ").trim().slice(0, RENAME_MAX).trim()
  if (name === (current ?? "")) return undefined
  return name
}

/**
 * XCOD-325: renames any row of "Sessions on this computer": a Claude Code / Codex session (only its
 * name in Lunos; the tool's own id is untouched), a session another Lunos runs (that Lunos stores and
 * audits it) or one of this Lunos's. Throws when it couldn't be saved; `renameFailure` says why.
 */
export async function renameSession(
  client: OpencodeClient,
  item: Pick<SessionOverviewItem, "id" | "directory" | "elsewhere">,
  title: string,
) {
  const options = { throwOnError: true } as const
  if (item.id.startsWith("external:"))
    return client.experimental.external.rename({ sessionID: item.id.slice("external:".length), title }, options)
  if (item.elsewhere) return client.experimental.peer.rename({ sessionID: item.id, title }, options)
  return client.session.update({ sessionID: item.id, directory: item.directory, title }, options)
}

/** XCOD-325: why a rename failed, for the row: "the session was deleted", or the server's reason. */
export function renameFailure(cause: unknown) {
  // The SDK's error carries the response as its cause.
  const response = (cause as { cause?: { status?: unknown } } | undefined)?.cause
  if (response?.status === 404) return "the session was deleted"
  return errorMessage(cause)
}
