// XCOD-124: upstream pages the Lunos docs leave out, because they describe upstream's hosted
// products or services, which don't exist for Lunos. Used by prepare.ts (not copied),
// starlight.mjs (not in the sidebar) and check-built.ts (links to them fail).
export const EXCLUDED_PAGES = [
  "zen", // OpenCode Zen, upstream's paid model gateway
  "go", // OpenCode Go, upstream's subscription
  "ecosystem", // upstream's community listing
  "share", // opncd.ai sharing; Lunos turns sharing off by default
  "gitlab", // upstream's GitLab integration
]
