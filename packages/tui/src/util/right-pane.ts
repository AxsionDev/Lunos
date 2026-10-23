/**
 * XCOD-307: the right pane (the session sidebar, and the Agent Monitor's rail) can be hidden with one
 * obvious action and brought back as easily. Pure, so the toggle, what's docked, what the setting
 * shows and the attention badge are tested without a terminal.
 */

/** Auto (default): docked on a wide terminal, an overlay on demand below that. */
export type Pane = "auto" | "show" | "hide"

export const PANES: readonly Pane[] = ["auto", "show", "hide"]

export const PANE_LABEL: Record<Pane, string> = { auto: "Auto", show: "Always show", hide: "Hidden" }

export const PANE_HELP: Record<Pane, string> = {
  auto: "shown on a wide terminal; below that, opened over the conversation",
  show: "always beside the conversation, even on a narrow terminal",
  hide: "hidden until you bring it back",
}

/** Each view remembers its own choice (kv.json). `sidebar` is the key the main view always used. */
export type PaneView = "session" | "external" | "monitor"

export const PANE_KEY: Record<PaneView, string> = {
  session: "sidebar",
  external: "sidebar_external",
  monitor: "monitor_rail",
}

export const PANE_VIEW_LABEL: Record<PaneView, string> = {
  session: "Right pane",
  external: "Right pane in Claude Code and Codex sessions",
  monitor: "Agent Monitor's session list",
}

/** The pane's width when docked, in columns. */
export const PANE_WIDTH = 42

/** Above this many columns, Auto docks the pane. */
export const WIDE = 120

export function pane(value: unknown): Pane {
  return value === "show" || value === "hide" ? value : "auto"
}

export type PaneState = {
  pref: Pane
  /** Opened for now (not remembered): Auto's overlay on a narrow terminal, or brought back from Hidden. */
  open: boolean
  wide: boolean
}

/** Where the pane is: beside the conversation, over it, or not shown. */
export function placement(state: PaneState): "docked" | "overlay" | "hidden" {
  if (state.pref === "show") return "docked"
  if (state.wide && (state.pref === "auto" || state.open)) return "docked"
  if (state.open) return "overlay"
  return "hidden"
}

/**
 * One toggle for the keybind, the command palette, » and «. Hiding a docked pane is remembered
 * (Hidden); closing Auto's overlay on a narrow terminal is not, so the pane is still there once the
 * terminal is wide again. Bringing it back from Hidden returns to Auto.
 */
export function toggled(state: PaneState): { pref: Pane; open: boolean } {
  const where = placement(state)
  if (where === "overlay") return { pref: state.pref, open: false }
  if (where === "docked") return { pref: "hide", open: false }
  return { pref: state.pref === "hide" ? "auto" : state.pref, open: true }
}

/** The columns the conversation gives up: only a docked pane takes any. */
export function taken(state: PaneState) {
  return placement(state) === "docked" ? PANE_WIDTH : 0
}

export type AttentionInput = {
  /** Subagents (at any depth) with a permission or question waiting for you. */
  waiting: number
  /** Budgets at or past BUDGET_WARN percent. */
  budgets: readonly { percent: number }[]
  lsp: readonly { status: string }[]
  mcp: readonly { status: string }[]
}

/** The budget meter turns to its warning colour here; the badge counts the same budgets. */
export const BUDGET_WARN = 80

/** An MCP server that failed, or that can't connect until you do something (the sidebar's MCP section). */
export const mcpFailed = (status: string) =>
  status === "failed" || status === "needs_auth" || status === "needs_client_registration"

/**
 * What the hidden pane holds that needs you: only blocking or warning states, never updates.
 * `label` is the chip's accessible text ("2 need you: 1 waiting for action, 1 MCP server failed").
 */
export function attention(input: AttentionInput) {
  const parts = [
    { count: input.waiting, text: "waiting for action" },
    { count: input.budgets.filter((item) => item.percent >= BUDGET_WARN).length, text: "budget warning" },
    { count: input.lsp.filter((item) => item.status === "error").length, text: "LSP server failed" },
    { count: input.mcp.filter((item) => mcpFailed(item.status)).length, text: "MCP server failed" },
  ].filter((part) => part.count > 0)
  const count = parts.reduce((sum, part) => sum + part.count, 0)
  return {
    count,
    label: count
      ? `${count} need${count === 1 ? "s" : ""} you: ${parts.map((p) => `${p.count} ${p.text}`).join(", ")}`
      : "",
  }
}

/**
 * The session's subagents at any depth (nested ones too) with a permission or question pending. The
 * session's own asks are shown in the conversation, so they don't count.
 */
export function waitingSubagents(
  root: string,
  sessions: readonly { id: string; parentID?: string }[],
  pending: (sessionID: string) => boolean,
) {
  const children = new Map<string, string[]>()
  for (const item of sessions) {
    if (!item.parentID) continue
    children.set(item.parentID, [...(children.get(item.parentID) ?? []), item.id])
  }
  const seen = new Set([root])
  const queue = [...(children.get(root) ?? [])]
  let count = 0
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    if (pending(id)) count++
    queue.push(...(children.get(id) ?? []))
  }
  return count
}
