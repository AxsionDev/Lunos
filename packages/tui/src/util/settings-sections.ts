import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import type { SettingRow } from "@opencode-ai/sdk/v2"

// XCOD-259: /settings opens on a list of sections, each a window of its own with sub-tabs where it
// has distinct parts. The sub-tab of every key comes from the server (`row.sub`, settings.ts).

export const SECTIONS = [
  { category: "Models & agents", slug: "models", aliases: ["agents", "model"] },
  { category: "Permissions", slug: "permissions", aliases: ["permission", "sandbox"] },
  { category: "Residency & privacy", slug: "residency", aliases: ["privacy", "audit"] },
  { category: "Memory", slug: "memory", aliases: [] },
  { category: "Marketplace & plugins", slug: "marketplace", aliases: ["plugins", "plugin"] },
  { category: "Appearance", slug: "appearance", aliases: ["theme"] },
  { category: "Updates", slug: "updates", aliases: ["update"] },
  { category: "Tools", slug: "tools", aliases: ["lsp", "mcp"] },
  { category: "Advanced / experimental", slug: "advanced", aliases: ["experimental"] },
] as const

export const SUBTABS: Record<string, readonly string[]> = {
  "Models & agents": ["Models", "Agents", "Providers", "External sessions"],
  Permissions: ["Rules", "Tools", "Sandbox"],
  "Residency & privacy": ["Residency", "Audit", "Sharing"],
  Memory: ["Overview", "Settings", "Advanced"],
  "Marketplace & plugins": ["Marketplaces", "Plugins", "Policy"],
  Appearance: ["Theme", "Layout"],
  Tools: ["LSP", "Formatters", "MCP", "Commands", "Skills", "Hooks", "Shell", "References"],
}

export type Target = { category: string; sub?: string }

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

/**
 * `/settings memory`, `/settings tools lsp`, `/settings models external`: a section, and optionally
 * a sub-tab of it, by name or alias. Undefined when the words name no section.
 */
export function target(text: string): Target | undefined {
  const [first, ...rest] = words(text).split(" ")
  if (!first) return undefined
  const section =
    SECTIONS.find((item) => item.slug === first || (item.aliases as readonly string[]).includes(first)) ??
    SECTIONS.find((item) => words(item.category).startsWith(first))
  if (!section) return undefined
  const tabs = SUBTABS[section.category] ?? []
  const wanted = rest.join(" ")
  // An alias that is a sub-tab (`/settings lsp`) lands on it.
  const sub =
    tabs.find((tab) => wanted && words(tab).startsWith(wanted)) ??
    (!wanted ? tabs.find((tab) => words(tab) === first) : undefined)
  return { category: section.category, ...(sub ? { sub } : {}) }
}

/** Where a key lives, for search results: "Memory › Advanced › memory.audit.enabled". */
export function breadcrumb(row: Pick<SettingRow, "category" | "sub" | "key">) {
  return [row.category, row.sub, row.key].filter(Boolean).join(" › ")
}

/** Changed from the default, locked by the organisation, and whether a saved change waits for a restart. */
export function badges(rows: readonly Pick<SettingRow, "source" | "locked" | "key">[], pending: ReadonlySet<string>) {
  const changed = rows.filter((row) => row.source !== "default" && !row.locked).length
  const locked = rows.filter((row) => row.locked).length
  const restart = rows.some((row) => pending.has(row.key))
  return [
    changed ? `${changed} changed` : undefined,
    locked ? `🔒 ${locked}` : undefined,
    restart ? "↻ restart" : undefined,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** A section's one-line summary from its rows' values, so the home says what's set at a glance. */
export function summary(category: string, rows: readonly Pick<SettingRow, "key" | "display" | "source">[]) {
  const value = (key: string) => rows.find((row) => row.key === key)?.display
  const set = (key: string) => {
    const row = rows.find((item) => item.key === key)
    return row && row.source !== "default" ? row.display : undefined
  }
  const parts: (string | undefined)[] =
    category === "Models & agents"
      ? [set("model") ?? "no model chosen", set("default_agent") ? `starts with ${set("default_agent")}` : undefined]
      : category === "Permissions"
        ? [
            value("sandbox.enabled") === "true" ? "sandbox on" : "sandbox off",
            set("permission") ? "custom rules" : undefined,
          ]
        : category === "Residency & privacy"
          ? [
              set("residency.allow") ? `residency ${set("residency.allow")}` : "no residency policy",
              value("share") ? `share ${value("share")}` : undefined,
            ]
          : category === "Memory"
            ? [
                value("memory.enabled") === "true" ? "on" : "off",
                // XCOD-264: plain words, never the config value "embedded".
                set("memory.backend.type") ? MemoryStorage.short({ type: set("memory.backend.type") }) : undefined,
              ]
            : category === "Marketplace & plugins"
              ? [
                  set("marketplace") ? "marketplaces added" : "built-in marketplace",
                  set("plugin") ? "plugins set" : undefined,
                ]
              : category === "Appearance"
                ? [value("tui.theme")]
                : category === "Updates"
                  ? [`auto-update ${value("autoupdate") ?? "on"}`]
                  : category === "Tools"
                    ? [value("lsp") === "false" ? "LSP off" : "LSP on", set("mcp") ? "MCP servers set" : undefined]
                    : ["for troubleshooting and early features"]
  return parts.filter(Boolean).join(" · ")
}

let pending: Target | { unknown: string } | undefined

/** Left by `/settings <section>` for the settings command to pick up when it opens the window. */
export function requestSettings(request: Target | { unknown: string }) {
  pending = request
}

export function takeSettingsRequest() {
  const request = pending
  pending = undefined
  return request
}
