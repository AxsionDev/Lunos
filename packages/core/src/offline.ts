export * as Offline from "./offline"

import { truthy } from "./flag/flag"

/**
 * Offline mode (XCOD-121). `LUNOS_OFFLINE=1` turns off, in one switch, every outbound call Lunos
 * makes on its own behalf: built-in and public hosts. Calls to endpoints the administrator
 * configures (the model provider, MCP servers, audit forwarding, ...) still happen: offline mode
 * means "only talk to what I set up", not "no network at all".
 *
 * `CALLS` is the one list of outbound calls. docs/deployment/self-hosted.md is generated from it
 * (script/offline-calls.ts), so the documented list can't drift from what the code gates.
 */

export const ENV = "LUNOS_OFFLINE"

/** Read at call time, not import time, so tests and wrappers can set it late. */
export function enabled() {
  return truthy(ENV)
}

/** The message every gate uses, so a blocked call always names the switch. */
export function message(what: string) {
  return `${what} is disabled because ${ENV} is set (offline mode)`
}

export class DisabledError extends Error {
  constructor(what: string) {
    super(message(what))
    this.name = "OfflineDisabledError"
  }
}

export type Call = {
  id: string
  what: string
  hosts: string
  when: string
  /**
   * - `blocked`: built-in or public host; offline mode turns it off.
   * - `yours`: an endpoint the administrator configured; offline mode leaves it on.
   * - `tool`: an agent tool that reaches the internet; offline mode doesn't offer it.
   * - `command`: only when someone runs that command; it fails without a network.
   */
  offline: "blocked" | "yours" | "tool" | "command"
  /** The narrower switch that also turns it off, if there is one. */
  alsoOffBy?: string
}

export const CALLS: Call[] = [
  {
    id: "models-catalogue",
    what: "Models catalogue refresh",
    hosts: "models.dev (or `OPENCODE_MODELS_URL`)",
    when: "startup, then hourly",
    offline: "blocked",
    alsoOffBy: "`OPENCODE_DISABLE_MODELS_FETCH`. The catalogue snapshot built into the binary is used instead",
  },
  {
    id: "update-check",
    what: "Update check (`lunos update` notice) and automatic update",
    hosts: "npm registry (or your `.npmrc` registry)",
    when: "every start, in the background (3 s timeout)",
    offline: "blocked",
    alsoOffBy: '`LUNOS_DISABLE_AUTOUPDATE`, or `"autoupdate": false`',
  },
  {
    id: "npm-install",
    what: "npm installs: LSP servers, formatters, the plugin SDK, npm plugins, provider SDKs",
    hosts: "npm registry (or your `.npmrc` registry)",
    when: "startup, and when a file type or provider is first used",
    offline: "blocked",
    alsoOffBy: "`OPENCODE_DISABLE_LSP_DOWNLOAD` (LSP servers only)",
  },
  {
    id: "lsp-download",
    what: "LSP server downloads and toolchain installs (`go install`, `gem`, `dotnet tool`)",
    hosts: "github.com, download-cdn.jetbrains.com, releases.hashicorp.com, proxy.golang.org, rubygems.org, nuget.org",
    when: "when a matching file is first opened",
    offline: "blocked",
    alsoOffBy: "`OPENCODE_DISABLE_LSP_DOWNLOAD`",
  },
  {
    id: "ripgrep",
    what: "ripgrep download, when `rg` isn't installed",
    hosts: "github.com",
    when: "first search",
    offline: "blocked",
  },
  {
    id: "tree-sitter",
    what: "Syntax-highlighting grammars for the TUI",
    hosts: "github.com, raw.githubusercontent.com",
    when: "when the TUI first shows code in that language",
    offline: "blocked",
  },
  {
    id: "share",
    what: "Session sharing",
    hosts: "opncd.ai, or your enterprise share URL",
    when: "only when you share (off by default)",
    offline: "blocked",
    alsoOffBy: "`OPENCODE_DISABLE_SHARE`",
  },
  {
    id: "marketplace",
    what: "Marketplace index, manifests and integrity lookups",
    hosts: "lunos.tech, raw.githubusercontent.com, api.github.com, npm registry",
    when: "`lunos marketplace` and the Discover view",
    offline: "blocked",
  },
  {
    id: "console-account",
    what: "Console account: organisation config and token refresh",
    hosts: "the console URL you logged in to (there is no default)",
    when: "startup, only if you logged in with `lunos account login <url>`",
    offline: "blocked",
  },
  {
    id: "memory-deps",
    what: "Memory sidecar dependencies and embedding model",
    hosts: "pypi.org, huggingface.co",
    when: "first memory use (memory is opt-in). Offline, uv and Hugging Face only use what is already cached",
    offline: "blocked",
    alsoOffBy: "`LUNOS_DISABLE_MEMORY`",
  },
  {
    id: "webfetch",
    what: "`webfetch` tool",
    hosts: "any URL the agent chooses",
    when: "when the agent calls it",
    offline: "tool",
  },
  {
    id: "websearch",
    what: "`websearch` tool",
    hosts: "mcp.exa.ai, search.parallel.ai",
    when: "when the agent calls it (off unless enabled)",
    offline: "tool",
  },
  {
    id: "model-provider",
    what: "Model provider API, including its login and model list",
    hosts: "the provider you configure",
    when: "every model call",
    offline: "yours",
  },
  {
    id: "mcp",
    what: "Remote MCP servers, and their OAuth",
    hosts: "URLs in `mcp`",
    when: "startup, and on each MCP tool call",
    offline: "yours",
  },
  {
    id: "remote-config",
    what: "Remote config from `.well-known/opencode`",
    hosts: "URLs you added with `lunos providers login <url>`",
    when: "startup",
    offline: "yours",
  },
  {
    id: "remote-skills",
    what: "Remote skills and URL instructions",
    hosts: "URLs in `skills.urls` and `instructions`",
    when: "startup and each prompt",
    offline: "yours",
  },
  {
    id: "audit-forward",
    what: "Audit forwarding to your SIEM",
    hosts: "`audit.forward` endpoint (OTLP/HTTP or syslog)",
    when: "background, only if configured",
    offline: "yours",
  },
  {
    id: "otlp",
    what: "OpenTelemetry export",
    hosts: "`OTEL_EXPORTER_OTLP_ENDPOINT`",
    when: "background, only if set",
    offline: "yours",
  },
  {
    id: "workspaces",
    what: "Remote workspaces (experimental)",
    hosts: "your workspace URL",
    when: "only with `OPENCODE_EXPERIMENTAL_WORKSPACES`",
    offline: "yours",
  },
  {
    id: "git",
    what: "`git fetch` when resetting a worktree",
    hosts: "your git remote",
    when: "on demand",
    offline: "yours",
  },
  {
    id: "agent-run-notify",
    what: "Notification after an unattended agent run (`lunos agent run --notify`)",
    hosts: "the https URL you pass to --notify",
    when: "after a scheduled or unattended run, only if you set --notify",
    offline: "blocked",
  },
  {
    id: "commands",
    what: "`account login`, `providers login`, `import <url>`, `agent import <url>`, `github install` / `run`",
    hosts: "api.github.com, the URL you pass",
    when: "only when you run that command",
    offline: "command",
  },
]

/** One line per blocked call, for `lunos --version --verbose`. */
export function report(on = enabled()) {
  const blocked = CALLS.filter((call) => call.offline === "blocked" || call.offline === "tool")
  if (!on) return `offline mode: off (${ENV} not set); ${blocked.length} built-in outbound calls allowed`
  return [`offline mode: on (${ENV}); disabled:`, ...blocked.map((call) => `  - ${call.what}`)].join("\n")
}
