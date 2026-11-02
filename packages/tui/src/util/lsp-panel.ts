export * as LspPanel from "./lsp-panel"

import type { LspOverview, LspServerInfo } from "@opencode-ai/sdk/v2"

// XCOD-257: what /lsp says about each language server, in words.

export const EXPLANATION =
  "When the agent reads or edits a file, Lunos starts the language server for it and passes its errors and warnings back to the agent, so it can fix them in the same turn."

export function label(item: Pick<LspServerInfo, "state">) {
  return {
    running: "Running",
    starting: "Starting…",
    failed: "Failed",
    not_started: "Not started",
    disabled: "Off",
  }[item.state]
}

/** Running and failed first, then not started, then off. */
export function group(item: Pick<LspServerInfo, "state">) {
  if (item.state === "running" || item.state === "failed" || item.state === "starting") return "Active"
  if (item.state === "not_started") return "Starts when a matching file is read"
  return "Off"
}

export function describe(item: LspServerInfo) {
  const types = item.extensions.slice(0, 4).join(" ") + (item.extensions.length > 4 ? " …" : "")
  if (item.state === "failed") return `${item.reason ?? "failed"}`
  if (item.state === "running")
    return [item.source, item.diagnostics !== undefined ? `${item.diagnostics} diagnostics` : undefined]
      .filter(Boolean)
      .join(" · ")
  return [types, item.custom ? "custom" : undefined, item.state === "disabled" ? item.reason : undefined]
    .filter(Boolean)
    .join(" · ")
}

export function uptime(started: number | undefined, now = Date.now()) {
  if (!started) return undefined
  const seconds = Math.max(0, Math.round((now - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

/** The detail screen's lines. */
export function details(item: LspServerInfo, now = Date.now()) {
  return [
    item.state === "failed" ? `Failed: ${item.reason ?? "unknown reason"}` : undefined,
    item.extensions.length ? `Files: ${item.extensions.join(" ")}` : undefined,
    item.source ? `From: ${item.source}` : undefined,
    item.root ? `Project root: ${item.root}` : undefined,
    item.pid ? `PID ${item.pid}, up ${uptime(item.started, now)}` : undefined,
    item.diagnostics !== undefined ? `${item.diagnostics} diagnostics in the files it has open` : undefined,
    item.state === "disabled" ? (item.reason ?? "off") : undefined,
  ].filter((line): line is string => Boolean(line))
}

export function summary(overview: Pick<LspOverview, "servers">) {
  const count = (state: LspServerInfo["state"]) => overview.servers.filter((item) => item.state === state).length
  const diagnostics = overview.servers.reduce((total, item) => total + (item.diagnostics ?? 0), 0)
  return `${count("running")} running · ${count("failed")} failed · ${count("not_started")} not started · ${diagnostics} diagnostics given to the agent`
}
