import type { TuiMarketplaceEntry } from "@opencode-ai/plugin/tui"

// XCOD-258: the marketplace's tab bar. Tabs come from the kinds the catalogue reports, so a kind a
// later manifest adds gets a tab of its own; search filters every tab at once, so each tab's count
// is what it would show.

export type Tab = string

/** Known kinds, in the bar's order; any other kind follows them, alphabetically. */
const ORDER = ["plugin", "skill", "hook", "mcp"]
const TITLES: Record<string, string> = {
  all: "All",
  plugin: "Plugins",
  skill: "Skills",
  hook: "Hooks",
  mcp: "MCP",
  installed: "Installed",
}

export function title(tab: Tab) {
  return TITLES[tab] ?? tab.charAt(0).toUpperCase() + tab.slice(1) + "s"
}

/** All · the kinds · Installed. The four known kinds always have a tab, even an empty one. */
export function tabs(items: readonly Pick<TuiMarketplaceEntry, "kind">[]): Tab[] {
  const extra = [...new Set(items.map((item) => item.kind as string))].filter((kind) => !ORDER.includes(kind)).sort()
  return ["all", ...ORDER, ...extra, "installed"]
}

/** The words a search looks in: what the row shows. */
export function matches(item: TuiMarketplaceEntry, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const details = item.details ?? {}
  return [item.name, item.description, item.marketplace, details.event, details.command, details.host]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(needle))
}

export function inTab(item: TuiMarketplaceEntry, tab: Tab) {
  if (tab === "all") return true
  if (tab === "installed") return item.installed !== undefined
  return item.kind === tab
}

/** What a tab lists for a search: Installed puts updates first, then groups by kind. */
export function rows(items: readonly TuiMarketplaceEntry[], tab: Tab, query: string) {
  const shown = items.filter((item) => inTab(item, tab) && matches(item, query))
  if (tab !== "installed") return shown
  const rank = (item: TuiMarketplaceEntry) => (item.installed === "update" ? 0 : 1)
  const kind = (item: TuiMarketplaceEntry) => {
    const index = ORDER.indexOf(item.kind)
    return index === -1 ? ORDER.length : index
  }
  return shown.toSorted((a, b) => rank(a) - rank(b) || kind(a) - kind(b))
}

export function counts(items: readonly TuiMarketplaceEntry[], query: string) {
  return Object.fromEntries(tabs(items).map((tab) => [tab, rows(items, tab, query).length])) as Record<Tab, number>
}

/** The row's middle column, per kind: what matters for that kind, the hook's command always. */
export function describe(item: TuiMarketplaceEntry, withKind: boolean) {
  const details = item.details ?? {}
  const shorten = (text: string, max = 40) => (text.length > max ? text.slice(0, max - 1) + "…" : text)
  const parts: (string | undefined)[] =
    item.kind === "hook"
      ? [
          [details.event, details.matcher].filter(Boolean).join(" · ") || undefined,
          details.command ? `runs ${shorten(details.command)}` : undefined,
        ]
      : item.kind === "mcp"
        ? [
            details.transport,
            details.host,
            details.region,
            details.policy === "blocked" ? "blocked by policy" : details.policy === "allowed" ? "allowed" : undefined,
          ]
        : item.kind === "plugin"
          ? [details.version ? `v${details.version}` : undefined, item.description]
          : [item.description]
  return [withKind ? title(item.kind).replace(/s$/, "") : undefined, ...parts].filter(Boolean).join(" · ")
}

/** The empty-tab text: what's missing, and how to add a marketplace that has it. */
export function empty(tab: Tab) {
  if (tab === "installed") return "Nothing from your marketplaces is installed."
  const noun: Record<string, string> = {
    all: "entries",
    plugin: "plugins",
    skill: "skill sources",
    hook: "hooks",
    mcp: "MCP servers",
  }
  return `No ${noun[tab] ?? title(tab).toLowerCase()} in your marketplaces. Add one: lunos marketplace add <owner/repo>`
}

/** The row's stable key, so a reopened list can come back to the same row. */
export function key(item: Pick<TuiMarketplaceEntry, "kind" | "marketplace" | "name">) {
  return `${item.kind}:${item.marketplace}:${item.name}`
}
