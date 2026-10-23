// XCOD-310: which approval mode a workflow runs in. Manual (`normal`) asks before every action an
// `ask` rule covers; Auto answers those asks. `deny` rules never ask, so Auto never reaches them.

export type Mode = "auto" | "normal"

export type ApprovalConfig = {
  readonly $locked?: readonly string[]
  readonly agent?: Readonly<Record<string, { readonly permission_mode?: string } | undefined>>
}

/** The `$locked` entry that fixes this workflow's approval: `agent`, `agent.<name>` or `agent.<name>.permission_mode`. */
export function approvalLock(locked: readonly string[] | undefined, agent: string) {
  const key = `agent.${agent}.permission_mode`
  return locked?.find((entry) => key === entry || key.startsWith(`${entry}.`))
}

/**
 * The mode: an organisation lock wins (its configured value, else Manual), then what this session
 * chose for the workflow, then the workflow's `agent.<name>.permission_mode`, then `--auto`.
 */
export function resolveApproval(input: { agent: string; stored?: Mode; config?: ApprovalConfig; auto?: boolean }): {
  mode: Mode
  lock?: string
} {
  const configured = input.config?.agent?.[input.agent]?.permission_mode
  const lock = approvalLock(input.config?.$locked, input.agent)
  if (lock) return { mode: configured === "auto" ? "auto" : "normal", lock }
  if (input.stored) return { mode: input.stored }
  if (configured === "auto" || configured === "manual") return { mode: configured === "auto" ? "auto" : "normal" }
  return { mode: input.auto ? "auto" : "normal" }
}

/** The session whose workflow a request runs under: a subagent's asks follow its top-level session. */
export function rootSession(sessionID: string, parentOf: (id: string) => string | undefined) {
  const seen = new Set<string>()
  let current = sessionID
  while (!seen.has(current)) {
    seen.add(current)
    const parent = parentOf(current)
    if (!parent) return current
    current = parent
  }
  return current
}
