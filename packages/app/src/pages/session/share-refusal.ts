/**
 * XCOD-266: why the server refused to share, as a key to show it in the user's language. "no-target"
 * is sharing switched on with nowhere to upload to (no organisation console, no enterprise.url).
 */
export function shareRefusalKey(error: unknown) {
  if (!error || typeof error !== "object") return
  return (error as { reason?: unknown }).reason === "no-target"
    ? ("toast.session.share.noTarget.description" as const)
    : undefined
}
