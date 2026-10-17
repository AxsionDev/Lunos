import type { TuiMarketplaceKind } from "@opencode-ai/plugin/tui"

/**
 * XCOD-251: `/marketplace [plugins|skills|hooks|mcp|installed|<search words>]` (alias `/discover`).
 * The Discover view lives in the internal plugins feature; the prompt only parses what was typed
 * and leaves it here for the `plugins.discover` command to pick up when it opens the view.
 */
export type DiscoverRequest = { kind?: TuiMarketplaceKind; search?: string; installed?: boolean }

const TABS: Record<string, TuiMarketplaceKind> = {
  plugin: "plugin",
  plugins: "plugin",
  skill: "skill",
  skills: "skill",
  hook: "hook",
  hooks: "hook",
  mcp: "mcp",
}

export function parseMarketplaceSlash(input: string): DiscoverRequest | undefined {
  const match = input.trim().match(/^\/(?:marketplace|discover)(?:\s+([\s\S]*))?$/)
  if (!match) return undefined
  const rest = (match[1] ?? "").trim()
  if (!rest) return {}
  const tab = TABS[rest.toLowerCase()]
  if (tab) return { kind: tab }
  if (rest.toLowerCase() === "installed") return { installed: true }
  return { search: rest }
}

let pending: DiscoverRequest | undefined

export function requestDiscover(request: DiscoverRequest) {
  pending = request
}

/** The request left by the prompt, once; a palette or keybind open finds none and gets the default. */
export function takeDiscoverRequest() {
  const request = pending
  pending = undefined
  return request ?? {}
}
