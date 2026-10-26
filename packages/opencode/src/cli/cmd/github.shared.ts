import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { ShareNext } from "@/share/share-next"

export { parseGitHubRemote } from "@/util/repository"

/**
 * Extracts displayable text from assistant response parts.
 * Returns null for non-text responses (signals summary needed).
 * Throws only for truly empty responses.
 */
export function extractResponseText(parts: SessionV1.Part[]): string | null {
  const textPart = parts.findLast((p) => p.type === "text")
  if (textPart) return textPart.text

  // Non-text parts (tools, reasoning, step-start/step-finish, etc.) - signal summary needed
  if (parts.length > 0) return null

  throw new Error("Failed to parse response: no parts returned")
}

/**
 * Formats a PROMPT_TOO_LARGE error message with details about files in the prompt.
 * Content is base64 encoded, so we calculate original size by multiplying by 0.75.
 */
export function formatPromptTooLargeError(files: { filename: string; content: string }[]): string {
  const fileDetails =
    files.length > 0
      ? `\n\nFiles in prompt:\n${files.map((f) => `  - ${f.filename} (${((f.content.length * 0.75) / 1024).toFixed(0)} KB)`).join("\n")}`
      : ""
  return `PROMPT_TOO_LARGE: The prompt exceeds the model's context limit.${fileDetails}`
}

/**
 * XCOD-266: the share link for the PR comment. With no organisation console or enterprise.url there's
 * nowhere to share to: `warn` says so and the run carries on without a link. Other failures still fail.
 */
export function shareLink<R>(share: Effect.Effect<{ url: string }, unknown, R>, warn: (message: string) => void) {
  return share.pipe(
    Effect.map((result): string | undefined => result.url),
    Effect.catchIf(ShareNext.isNoTarget, (error) => Effect.sync(() => (warn(error.message), undefined))),
  )
}
