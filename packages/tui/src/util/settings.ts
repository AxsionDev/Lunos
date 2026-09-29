// XCOD-128: the pure parts of the /settings screen, kept apart from the component so they can be
// tested without a renderer.

export type SettingRowLike = {
  key: string
  label: string
  description: string
  kind: string
  values?: ReadonlyArray<string | boolean>
  value?: unknown
  display: string
  source: string
  locked: boolean
}

export const TABS = ["status", "settings", "usage"] as const
export type Tab = (typeof TABS)[number]

export function nextTab(tab: Tab, direction: 1 | -1): Tab {
  const index = TABS.indexOf(tab)
  return TABS[(index + direction + TABS.length) % TABS.length]
}

/**
 * `/settings share=disabled` (or `/config ...`) sets one value. Bare `/settings` opens the screen,
 * which the slash list already does, so it isn't handled here.
 */
export function parseSettingsSlash(input: string): { key: string; value: string } | { error: string } | undefined {
  const match = input.trim().match(/^\/(settings|config)\s+(.+)$/s)
  if (!match) return
  const rest = match[2].trim()
  const eq = rest.indexOf("=")
  if (eq <= 0) return { error: `Use /${match[1]} key=value, e.g. /${match[1]} share=disabled` }
  return { key: rest.slice(0, eq).trim(), value: rest.slice(eq + 1).trim() }
}

/** Typing filters by label, key and description; label and key matches come first. */
export function filterRows<T extends SettingRowLike>(rows: ReadonlyArray<T>, query: string): T[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...rows]
  const strong = rows.filter(
    (row) => row.label.toLowerCase().includes(needle) || row.key.toLowerCase().includes(needle),
  )
  const weak = rows.filter((row) => !strong.includes(row) && row.description.toLowerCase().includes(needle))
  return [...strong, ...weak]
}

/** The value after a Space press: booleans flip, enums move to the next value. */
export function cycle(row: SettingRowLike): string | undefined {
  if (row.kind === "boolean") return String(!(row.value === true))
  if (row.kind === "enum" && row.values?.length) {
    const index = row.values.findIndex((value) => value === row.value)
    return String(row.values[(index + 1) % row.values.length])
  }
  return
}

export function badge(row: Pick<SettingRowLike, "source" | "locked">) {
  return row.locked ? "🔒 managed" : row.source
}

/** The value as the inline editor should start with it. */
export function editText(row: SettingRowLike) {
  if (row.value === undefined || row.value === null) return ""
  if (typeof row.value === "string") return row.value
  if (Array.isArray(row.value) && row.value.every((item) => typeof item === "string")) return row.value.join(", ")
  return JSON.stringify(row.value)
}

export function formatTokens(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

export function formatCost(value: number) {
  return `$${value.toFixed(2)}`
}
