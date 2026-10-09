export * as ExternalRun from "./run"

import { ExternalClaude } from "./claude"
import { ExternalCodex } from "./codex"
import { ExternalDetect } from "./detect"

/**
 * XCOD-204: one way to start either tool, so the CLI and the external_agent tool don't care
 * which. `permissionMode` is Claude Code's permission mode, or for Codex its sandbox or approval
 * policy (whichever the value names).
 */

export interface Options {
  tool: ExternalDetect.Tool
  cwd: string
  prompt: string
  resume?: string
  permissionMode?: string
  /** The tool's model; validated as an id because it reaches Claude Code's command line. */
  model?: string
  allowUnsafe?: boolean
  executable?: string
  maxBudgetUSD?: number
  ask: ExternalClaude.Options["ask"]
  onEvent?: ExternalClaude.Options["onEvent"]
}

export function start(options: Options): ExternalClaude.Running {
  if (options.tool === "claude") return ExternalClaude.start(options)
  const mode = options.permissionMode
  return ExternalCodex.start({
    ...options,
    sandbox: mode && ["read-only", "workspace-write", "danger-full-access"].includes(mode) ? mode : undefined,
    approvalPolicy: mode && ["untrusted", "on-request", "never"].includes(mode) ? mode : undefined,
  })
}

/** The tool's executable as configured (`external.claude.path` / `external.codex.path`). */
export function configuredPath(tool: ExternalDetect.Tool, config: { external?: Record<string, any> }) {
  return config.external?.[tool]?.path as string | undefined
}

/** "$0.3211 (as reported by Claude Code)", or the tokens Codex reports, or "not reported". */
export function cost(tool: ExternalDetect.Tool, result: { costUSD?: number; tokens?: number }) {
  const label = ExternalDetect.TOOLS[tool].label
  if (result.costUSD !== undefined) return `$${result.costUSD.toFixed(4)} (as reported by ${label})`
  if (result.tokens !== undefined)
    return `${result.tokens.toLocaleString("en")} tokens (${label} reports tokens, not money)`
  return "not reported"
}
