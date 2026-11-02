/**
 * XCOD-318: the Feedback button's request to the local server (`POST /global/feedback`), which sends
 * it on to Lunos Cloud with this machine's sign-in. Only these fields: the text, an optional
 * screenshot, where it came from, and the session id only when the box to share it is ticked.
 */

export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024

export type Screenshot = { type: string; data: string }

export function feedbackInput(input: {
  text: string
  consent: boolean
  sessionId?: string
  screenshot?: Screenshot
  desktop: boolean
}) {
  return {
    text: input.text.trim(),
    source: input.desktop ? ("desktop" as const) : ("app" as const),
    consent: input.consent,
    ...(input.consent && input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.screenshot ? { screenshot: input.screenshot } : {}),
  }
}

/** A chosen file as a screenshot: PNG, JPEG or WebP, at most 2 MB; otherwise why not. */
export async function readScreenshot(file: File): Promise<Screenshot | { error: "type" | "size" }> {
  if (!(SCREENSHOT_TYPES as readonly string[]).includes(file.type)) return { error: "type" }
  if (file.size > SCREENSHOT_MAX_BYTES) return { error: "size" }
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return { type: file.type, data: btoa(binary) }
}
