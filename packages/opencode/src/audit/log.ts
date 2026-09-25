export * as AuditLog from "./log"

import path from "path"
import { Audit } from "@opencode-ai/core/audit"
import { Global } from "@opencode-ai/core/global"
import { Residency } from "@opencode-ai/core/residency"

// XCOD-103: the CLI's side of the audit trail. The config loader activates it with the resolved
// settings; every emitter calls `emit()`. Events emitted before activation (a policy refusal
// during config load, the upgrade check) are held and written once the settings are known.

export type Settings = {
  enabled: boolean
  file: string
  redact: readonly string[]
  maxBytes?: number
  maxAgeDays?: number
  forward?: { syslog?: string; otlp?: string }
  /** The residency policy's allowed regions, if one is set: forwarding destinations are checked against it. */
  residencyAllow?: readonly string[]
}

type AuditBlock = {
  enabled?: boolean
  path?: string
  redact?: readonly string[]
  max_bytes?: number
  max_age_days?: number
  forward?: { syslog?: string; otlp?: string }
}

export const DEFAULT_FILE = () => path.join(Global.Path.log, "residency-egress.log")

/** On when `audit.enabled`, or when a residency policy is set with auditing on (its default). */
export function resolve(config: {
  audit?: AuditBlock
  residency?: { audit?: boolean; auditPath?: string; allow?: readonly string[] }
}): Settings {
  const residencyAudit = !!config.residency && config.residency.audit !== false
  return {
    enabled: config.audit?.enabled === true || residencyAudit,
    file: config.audit?.path ?? config.residency?.auditPath ?? DEFAULT_FILE(),
    redact: config.audit?.redact ?? [],
    maxBytes: config.audit?.max_bytes,
    maxAgeDays: config.audit?.max_age_days,
    forward: config.audit?.forward,
    residencyAllow: config.residency?.allow,
  }
}

/**
 * What the model-call fetch wrapper enforces and records: the residency policy when there is one
 * (its audit path follows `audit.path` too), otherwise record-only when the trail is on.
 */
export function residency(config: Parameters<typeof resolve>[0] & { residency?: Residency.ConfigBlock }) {
  const settings = resolve(config)
  const resolved = Residency.resolve(config.residency)
  if (resolved) return { ...resolved, auditPath: settings.file }
  return settings.enabled ? Residency.observe(settings.file) : undefined
}

let active: Settings | undefined
let pending: { event: Audit.EventName; fields: Audit.Fields; at: Date }[] = []
const activation = new Set<(settings: Settings) => void>()

export function onActivate(listener: (settings: Settings) => void) {
  activation.add(listener)
  if (active) listener(active)
  return () => activation.delete(listener)
}

export function activate(settings: Settings) {
  active = settings
  Audit.configure({ redact: settings.redact, maxBytes: settings.maxBytes, maxAgeDays: settings.maxAgeDays })
  for (const listener of activation) listener(settings)
  const held = pending
  pending = []
  if (settings.enabled)
    for (const item of held) void Audit.write({ file: settings.file }, item.event, item.fields, item.at)
}

export function current() {
  return active
}

export function emit(event: Audit.EventName, fields: Audit.Fields = {}) {
  if (!active) {
    pending.push({ event, fields, at: new Date() })
    return
  }
  if (!active.enabled) return
  void Audit.write({ file: active.file }, event, fields)
}

export const flush = () => Audit.flush()

const PATH_ARGS = ["filePath", "path", "move_path", "workdir", "directory"] as const

/**
 * `tool.run`: tool name, agent, session, the command line for shell tools and any file paths.
 * Never file contents, patches or tool output.
 */
export function toolRun(input: { tool: string; agent: string; session: string; args: unknown; server?: string }) {
  const args = (input.args && typeof input.args === "object" ? input.args : {}) as Record<string, unknown>
  const paths = PATH_ARGS.map((key) => args[key]).filter((value): value is string => typeof value === "string")
  emit("tool.run", {
    tool: input.tool,
    agent: input.agent,
    session: input.session,
    server: input.server,
    command: input.tool === "bash" || input.tool === "shell" ? String(args.command ?? "") : undefined,
    paths: paths.length ? paths : undefined,
  })
}
