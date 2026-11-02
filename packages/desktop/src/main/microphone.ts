/** XCOD-336: the microphone for voice input, and nothing else a "media" request could ask for. */
export function microphoneOnly(permission: string, details: object) {
  if (permission !== "media") return false
  const media = details as { mediaTypes?: string[]; mediaType?: string }
  const types = media.mediaTypes ?? (media.mediaType ? [media.mediaType] : [])
  return types.length > 0 && types.every((type) => type === "audio")
}
