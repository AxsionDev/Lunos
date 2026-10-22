export * as SandboxEffective from "./effective"

import fs from "node:fs"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Flag } from "@opencode-ai/core/flag/flag"
import type { SandboxSetting } from "@opencode-ai/tui/util/sandbox"
import { ConfigManaged } from "@/config/managed"
import { ConfigPolicy } from "@/config/policy"
import { SandboxConfig } from "./config"
import { SandboxDisabled } from "./disabled"

// XCOD-297: whether the sandbox is on here, and why, in one place: startup (`wanted`), /settings,
// the "no sandbox" badge and `lunos sandbox status|off` all ask this. `sandbox.enabled` isn't
// last-wins (see SandboxConfig.load): any layer that says true turns it on, so writing false to one
// file did nothing while another still said true, and /settings showed "off" for a sandbox that
// started anyway. Turning it off therefore writes false to every file that turns it on.

export type Layer = "user" | "project" | "env" | "managed"

/** A config layer that turns the sandbox on. */
export type Source = { layer: Layer; file: string; key: "enabled" | "required" }

export type State = {
  config: SandboxConfig.Resolved
  /** Whether a plain `lunos` start here uses the sandbox. */
  on: boolean
  /** The layers that turn it on, highest precedence first. */
  sources: Source[]
  /** Why it can't be turned off here, and who set it. */
  fixed?: string
  /** XCOD-281: turned off here after it failed to start; the config still turns it on. */
  disabled?: SandboxDisabled.Entry
}

type Doc = Record<string, unknown>

function readDoc(file: string): Doc | undefined {
  try {
    const data = parse(fs.readFileSync(file, "utf8"), [], { allowTrailingComma: true })
    return data && typeof data === "object" && !Array.isArray(data) ? data : undefined
  } catch {
    return undefined
  }
}

const sets = (doc: unknown, key: Source["key"]) => ConfigPolicy.get(doc, `sandbox.${key}`) === true

/** Every layer that sets sandbox.enabled or sandbox.required to true, highest precedence first. */
function sources(directory: string, managed: Doc): Source[] {
  const all = SandboxConfig.files(directory, SandboxConfig.worktreeOf(directory))
  const user = SandboxConfig.globalFiles().length
  const out: Source[] = []
  const add = (layer: Layer, file: string, doc: unknown) => {
    for (const key of ["required", "enabled"] as const) if (sets(doc, key)) out.push({ layer, file, key })
  }
  add("managed", ConfigManaged.managedConfigLocation().dir, managed)
  if (Flag.OPENCODE_CONFIG_CONTENT)
    add("env", "OPENCODE_CONFIG_CONTENT", parse(Flag.OPENCODE_CONFIG_CONTENT, [], { allowTrailingComma: true }))
  for (let index = all.length - 1; index >= 0; index--)
    add(index < user ? "user" : "project", all[index]!, readDoc(all[index]!))
  return out
}

const where = (source: Source) =>
  source.layer === "managed"
    ? "your organisation's managed config"
    : source.layer === "env" && source.file === "OPENCODE_CONFIG_CONTENT"
      ? "OPENCODE_CONFIG_CONTENT"
      : source.file

function fixed(found: Source[], locked: boolean) {
  const required = found.find((source) => source.key === "required")
  if (required)
    return required.layer === "managed"
      ? "sandbox.required is set by your organisation's managed config, so the sandbox can't be turned off here. Ask your administrator."
      : `sandbox.required is set in ${where(required)}, so the sandbox can't be turned off: remove sandbox.required there first.`
  if (locked) return ConfigPolicy.message("sandbox.enabled")
  if (found.some((source) => source.layer === "managed"))
    return "sandbox.enabled is set by your organisation's managed config, so the sandbox can't be turned off here. Ask your administrator."
  return undefined
}

export function resolve(directory: string): State {
  const config = SandboxConfig.load(directory)
  const managed = SandboxConfig.mergeDocs(ConfigManaged.readManagedDocsSync())
  const found = sources(directory, managed)
  const locked = ConfigPolicy.isLocked(ConfigPolicy.lockList(managed), "sandbox.enabled")
  // As `wanted` decides: required always runs sandboxed; otherwise enabled, unless it failed here.
  const disabled = !config.required && config.enabled ? SandboxDisabled.get(directory, config) : undefined
  return {
    config,
    on: config.required || (config.enabled && !disabled),
    sources: found,
    fixed: config.enabled ? fixed(found, locked) : locked ? ConfigPolicy.message("sandbox.enabled") : undefined,
    ...(disabled ? { disabled } : {}),
  }
}

const day = (time: string) => {
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? time : date.toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

/** Where it's turned on, in one phrase: "set in ~/repo/opencode.json (project)". */
export function origin(state: State) {
  const shown = state.sources.filter((source) => source.key === "enabled" || state.config.required)
  if (!shown.length) return undefined
  return "set in " + shown.map((source) => `${where(source)} (${source.layer})`).join(" and ")
}

/** The setting as /settings and `lunos sandbox status` show it. */
export function view(state: State): SandboxSetting {
  const top = state.sources[0]
  const from = origin(state)
  const base = { on: state.on, ...(top ? { layer: top.layer, file: where(top) } : {}) }
  if (state.disabled)
    return {
      ...base,
      display: "off (after a failure)",
      detail:
        `off · turned off after it failed to start on ${day(state.disabled.time)}: ${state.disabled.fix ?? state.disabled.reason}. ` +
        `sandbox.enabled is still on (${from}): Re-enable tries it again, Turn off keeps it off.`,
      disabled: true,
    }
  if (!state.on) return { ...base, display: "off", detail: state.fixed ? `off · ${state.fixed}` : "off" }
  return {
    ...base,
    display: state.config.required ? "on (required)" : "on",
    detail: `on · ${from ?? "set by --sandbox"}`,
    ...(state.fixed ? { fixed: state.fixed } : {}),
  }
}

export type TurnedOff =
  | { ok: true; files: string[]; state: State; still?: string }
  | { ok: false; reason: string; state: State }

/**
 * Turn the sandbox off here: sandbox.enabled is set to false in every file of yours (or, with
 * `scope`, of that scope) that sets it to true, in place, comments kept. No file is created. Refused
 * when it's fixed (sandbox.required, an organisation lock). `still` says where it's still on.
 */
export function turnOff(directory: string, scope?: "user" | "project"): TurnedOff {
  const before = resolve(directory)
  if (before.fixed) return { ok: false, reason: before.fixed, state: before }
  const files = [
    ...new Set(
      before.sources
        .filter((source) => source.key === "enabled" && (source.layer === "user" || source.layer === "project"))
        .filter((source) => !scope || source.layer === scope)
        .map((source) => source.file),
    ),
  ]
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8")
    const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
    fs.writeFileSync(file, applyEdits(text, modify(text, ["sandbox", "enabled"], false, options)))
  }
  // Off by your choice now, not because it failed: nothing is left for Re-enable to undo.
  SandboxDisabled.clear(directory)
  const state = resolve(directory)
  if (!state.config.enabled) return { ok: true, files, state }
  const left = state.sources.filter((source) => source.key === "enabled")
  const still =
    `the sandbox is still on: ${origin(state)}` +
    (left.some((source) => source.layer === "env")
      ? ". Remove it from the environment to turn it off."
      : `. \`lunos sandbox off\`${scope ? ` without --${scope}` : ""} turns it off there too.`)
  return { ok: true, files, state, still }
}
