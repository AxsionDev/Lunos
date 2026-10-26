/**
 * XCOD-312: a disabled Lunos account, as the server tells the desktop and web app (`GET /global/account`,
 * from the record the TUI, `lunos login` and the server's own Lunos Cloud calls keep on that machine).
 * The same content as the TUI's notice (packages/tui/src/util/account.ts): the reason category, the end
 * date, and the support address; never the admin's free-text reason, which never reaches the client.
 */

export const SUPPORT_EMAIL = "support@lunos.tech"

export const DISABLED_CATEGORIES = ["abuse", "security", "terms", "payment", "offboarding", "other"] as const

export type DisabledCategory = (typeof DISABLED_CATEGORIES)[number]

export type Disabled = { category?: DisabledCategory; until?: string }

/**
 * The `disabled` part of the answer, or undefined: not disabled, an older server without the route, or
 * anything malformed. An unknown category and an end that isn't a date are left out.
 */
export function parseAccount(body: unknown): Disabled | undefined {
  if (!body || typeof body !== "object") return undefined
  const disabled = (body as { disabled?: unknown }).disabled
  if (!disabled || typeof disabled !== "object") return undefined
  const raw = disabled as { category?: unknown; until?: unknown }
  const category = DISABLED_CATEGORIES.find((item) => item === raw.category)
  const until = typeof raw.until === "string" && !Number.isNaN(Date.parse(raw.until)) ? raw.until : undefined
  return { ...(category ? { category } : {}), ...(until ? { until } : {}) }
}

type Translate = (key: string, params?: Record<string, string>) => string

/** "Reason: A payment issue", "Until 2026-12-01": the lines under the title (the support address follows, as a link). */
export function disabledLines(disabled: Disabled, t: Translate) {
  return [
    ...(disabled.category
      ? [t("account.disabled.reason", { reason: t(`account.disabled.category.${disabled.category}`) })]
      : []),
    ...(disabled.until
      ? [t("account.disabled.until", { date: new Date(disabled.until).toISOString().slice(0, 10) })]
      : []),
  ]
}
