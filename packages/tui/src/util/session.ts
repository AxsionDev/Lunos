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
