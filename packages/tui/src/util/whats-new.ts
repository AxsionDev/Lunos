import { Changelog } from "@opencode-ai/core/changelog"

/**
 * XCOD-248: what the first start of a version shows. `seen` is the newest version this machine's TUI
 * has started (kept in kv); the panel covers everything after it, so skipped versions are included.
 * - first install (nothing seen): no panel, only a hint that `/whatsnew` exists;
 * - a newer version than seen: the panel, once, unless `whats_new` is false;
 * - the same or an older version (a downgrade): nothing.
 * A development build (no semver version) never shows anything and isn't recorded.
 */
export type WhatsNewStart = { record?: string; hint?: boolean; show?: { since: string; to: string } }

export function whatsNewOnStart(input: { current: string; seen: string | undefined; enabled: boolean }): WhatsNewStart {
  if (!Changelog.isVersion(input.current)) return {}
  if (!Changelog.isVersion(input.seen)) return { record: input.current, hint: true }
  if (!Changelog.isNewer(input.current, input.seen)) return {}
  return { record: input.current, ...(input.enabled ? { show: { since: input.seen, to: input.current } } : {}) }
}
