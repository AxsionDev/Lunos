export * as ConfigExternal from "./external"

import { Schema } from "effect"

/**
 * XCOD-204: driving Claude Code and Codex CLI from Lunos. Uses the user's own install and login;
 * Lunos never stores, copies or proxies their credentials. Declared in both config schemas.
 * Lock `external` (or `external.enabled`) with `$locked` to turn it off for an organisation.
 */

/**
 * XCOD-256: an empty or blank value means "unset" (the safe default), never an error. Its
 * identifier lets /settings list a field of known values plus Blank as a select.
 */
export const Blank = Schema.String.check(Schema.isPattern(/^\s*$/)).annotate({ identifier: "BlankString" })

/** Claude Code's permission modes Lunos knows, in the order /settings lists them. */
export const CLAUDE_MODES = [
  "default",
  "manual",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
] as const
export const CODEX_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const
export const CODEX_APPROVALS = ["untrusted", "on-request", "never"] as const

/** Values that skip approval or the sandbox: refused in config, only ever passed for one run. */
export const UNSAFE = new Set<string>(["bypassPermissions", "danger-full-access", "never"])

/**
 * XCOD-285: Claude Code's Shift+Tab cycle, as far as an install reports it: its default (named
 * `default`, or `manual` in newer releases), then acceptEdits, then plan, in that order, and only the
 * ones its `--help` lists. Modes that skip or auto-decide approvals (bypassPermissions, dontAsk, auto)
 * are never in the cycle. Without a readable `--help` there's no cycle.
 */
export const CYCLE = ["default", "acceptEdits", "plan"] as const

export function cycle(reported: readonly string[] | undefined) {
  if (!reported?.length) return []
  const base = reported.includes("default") ? "default" : reported.includes("manual") ? "manual" : undefined
  return [base, ...CYCLE.slice(1).filter((item) => reported.includes(item))].filter((x): x is string => !!x)
}

/** The mode after `current` in the cycle (wrapping); the first one after the default when unset. */
export function next(modes: readonly string[], current: string | undefined) {
  if (!modes.length) return undefined
  const normal = current === "manual" || current === "default" || current === undefined ? modes[0] : current
  const index = modes.indexOf(normal!)
  return modes[(index + 1) % modes.length]
}

/** What each value does, for /settings. */
export const DESCRIPTIONS: Record<string, string> = {
  default: "Every edit and command asks in Lunos",
  manual: "Every edit and command asks in Lunos (Claude Code's newer name for default)",
  acceptEdits: "File edits are accepted; commands still ask",
  plan: "Read and plan only, no changes",
  auto: "Claude Code's classifier approves routine actions itself; only the rest ask in Lunos",
  dontAsk: "Never asks: anything not already allowed is denied",
  bypassPermissions: "Skips every approval",
  "read-only": "Commands can read the workspace but not change it",
  "workspace-write": "Commands can change files in the workspace",
  "danger-full-access": "No sandbox: commands can change anything",
  untrusted: "Anything beyond reading asks in Lunos",
  "on-request": "Codex decides when to ask",
  never: "Never asks",
}

/** The value Lunos uses when the key is unset, blank, or holds a value refused in config. */
export const DEFAULTS: Record<string, string> = {
  "external.claude.permission_mode": "default",
  "external.codex.sandbox": "read-only",
  "external.codex.approval_policy": "untrusted",
}

export const DEFAULT_LABEL = "Manual approval (default)"

/** A configured value, with blank read as unset. */
export function value(input: unknown) {
  return typeof input === "string" && input.trim() !== "" ? input.trim() : undefined
}

/** "Manual approval (default)" for the default (and Claude Code's `manual`), otherwise the value. */
export function label(input: unknown, fallback: string) {
  const current = value(input) ?? fallback
  if (current === fallback || (fallback === "default" && current === "manual")) return DEFAULT_LABEL
  return current
}

const field = <const T extends readonly string[]>(values: T) => Schema.Union([Schema.Literals(values), Blank])

const Claude = Schema.Struct({
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "The tool's executable, when it isn't on PATH",
  }),
  permission_mode: field(CLAUDE_MODES).pipe(Schema.optional).annotate({
    description:
      "Claude Code's permission mode on every run. Unset or empty: manual approval (every edit and command asks in Lunos). bypassPermissions is refused here; pass it for one run only",
  }),
})

const Codex = Schema.Struct({
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "The tool's executable, when it isn't on PATH",
  }),
  sandbox: field(CODEX_SANDBOXES).pipe(Schema.optional).annotate({
    description:
      "Codex's sandbox on every run. Unset or empty: read-only. danger-full-access is refused here; pass it for one run only",
  }),
  approval_policy: field(CODEX_APPROVALS).pipe(Schema.optional).annotate({
    description:
      "Codex's approval policy on every run. Unset or empty: untrusted (anything beyond reading asks in Lunos). never is refused here; pass it for one run only",
  }),
  permission_mode: Schema.String.pipe(Schema.optional).annotate({
    description:
      "@deprecated Moved to sandbox / approval_policy: still read while those are unset, and saving either moves it",
  }),
})

/**
 * XCOD-254: what an external session may use from Lunos, once the user has agreed to share it with
 * that tool (the consent is asked once per tool and project, and kept outside config so a repository
 * can't agree on its users' behalf). Each is on unless set to false; an organisation can lock any.
 * `hooks` is the exception to the consent: hooks run in Lunos and send nothing to the tool's vendor.
 */
export const SHARE = ["mcp", "skills", "memory", "commands", "hooks"] as const
export type Share = Record<(typeof SHARE)[number], boolean>

const ShareInfo = Schema.Struct({
  mcp: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Offer Lunos's MCP servers to Claude Code / Codex through the Lunos bridge (default true)",
  }),
  skills: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Offer Lunos's skills to Claude Code / Codex through the Lunos bridge (default true)",
  }),
  memory: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Let Claude Code / Codex search and add to Lunos memory through the Lunos bridge, while memory is on (default true)",
  }),
  commands: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "List Lunos's custom commands, skills and MCP prompts in a Claude Code / Codex session (default true)",
  }),
  hooks: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Run Lunos plugins' tool.execute.before / tool.execute.after hooks on Claude Code / Codex's own tool calls (default true). They run on this machine, so they don't need the sharing consent",
  }),
})

/** Every `external.share.*` key with its default (true) filled in. */
export function share(config: Info | undefined): Share {
  return Object.fromEntries(SHARE.map((key) => [key, config?.share?.[key] !== false])) as Share
}

export const Info = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Allow Lunos to start Claude Code and Codex CLI sessions (default true). Lock it to turn it off",
  }),
  delegate: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Give Lunos agents the external_agent tool, so they can hand a task to Claude Code (off by default). Every approval the tool asks for comes to you",
  }),
  claude: Claude.pipe(Schema.optional).annotate({ description: "Claude Code" }),
  codex: Codex.pipe(Schema.optional).annotate({ description: "Codex CLI" }),
  share: ShareInfo.pipe(Schema.optional).annotate({
    description:
      "What Claude Code / Codex sessions may use from Lunos, after you agree to share it with that tool. Their results are sent to Anthropic or OpenAI with your prompts",
  }),
}).annotate({ identifier: "ExternalConfig" })
export type Info = Schema.Schema.Type<typeof Info>

const isSandbox = (input: string) => (CODEX_SANDBOXES as readonly string[]).includes(input)
const isApproval = (input: string) => (CODEX_APPROVALS as readonly string[]).includes(input)

/**
 * What a run takes from config: blank is unset, a value refused in config falls back to the safe
 * default, and Codex's sandbox / approval_policy win over the legacy permission_mode, which is read
 * as whichever of the two its value names.
 */
export function launch(tool: "claude" | "codex", config: Info | undefined) {
  const safe = (input: unknown) => {
    const current = value(input)
    return current && !UNSAFE.has(current) ? current : undefined
  }
  if (tool === "claude") return { permissionMode: safe(config?.claude?.permission_mode) }
  const legacy = safe(config?.codex?.permission_mode)
  return {
    sandbox: safe(config?.codex?.sandbox) ?? (legacy && isSandbox(legacy) ? legacy : undefined),
    approvalPolicy: safe(config?.codex?.approval_policy) ?? (legacy && isApproval(legacy) ? legacy : undefined),
  }
}

/** Why a configured value isn't used, for /settings and `lunos settings set`. */
export function refused(input: unknown) {
  const current = value(input)
  if (current && UNSAFE.has(current))
    return `"${current}" skips approval or the sandbox, so it's refused in config and the safe default is used. Pass it for one run only: lunos external run … --permission-mode ${current} --unsafe`
}

/**
 * The writes that save `key` and move a legacy Codex permission_mode out of the way: its value
 * goes to whichever of sandbox / approval_policy it names, unless that one is already set.
 */
export function migrate(key: string, codex: Info["codex"]) {
  if (key !== "external.codex.sandbox" && key !== "external.codex.approval_policy") return []
  if (codex?.permission_mode === undefined) return []
  // A refused value isn't carried over: it was never used, and it can't be saved.
  const legacy = value(codex.permission_mode)
  const carry = legacy && !UNSAFE.has(legacy) ? legacy : undefined
  const other: { key: string; value: string }[] = []
  if (carry && key === "external.codex.sandbox" && isApproval(carry) && !value(codex.approval_policy))
    other.push({ key: "external.codex.approval_policy", value: carry })
  if (carry && key === "external.codex.approval_policy" && isSandbox(carry) && !value(codex.sandbox))
    other.push({ key: "external.codex.sandbox", value: carry })
  return [...other, { key: "external.codex.permission_mode", unset: true as const }]
}
