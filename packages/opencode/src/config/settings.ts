export * as ConfigSettings from "./settings"

import path from "path"
import { existsSync } from "fs"
import fs from "fs/promises"
import { Schema, SchemaAST } from "effect"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import * as TuiConfig from "@opencode-ai/tui/config/schema"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
import { ConfigParse } from "./parse"
import { ConfigPolicy } from "./policy"
import { ConfigManaged } from "./managed"
import { ConfigVariable } from "./variable"
import { ConfigV2Compat } from "./v2-compat"
import { MemorySwitch } from "@/memory/switch"
import { normalizeLoadedConfig } from "./config"
import fuzzysort from "fuzzysort"

// XCOD-128: every configuration option in one place, for the TUI's /settings screen and for
// `lunos settings list|get|set`. The list is generated from the live schemas (ConfigV1.Info for
// opencode.json, TuiConfig.Info for tui.json), so a new key shows up without touching this file.
// What this file adds is judgement the schema can't carry: which category a key belongs in, which
// existing dialog edits it, and whether a change needs a restart. `CATEGORY` must classify every
// top-level ConfigV1 key; a test walks the schema and fails on any key missing from it.

export const CATEGORIES = [
  "Models & agents",
  "Permissions",
  "Residency & privacy",
  "Memory",
  "Marketplace & plugins",
  "Appearance",
  "Updates",
  "Tools",
  "Advanced / experimental",
] as const
export type Category = (typeof CATEGORIES)[number]

/** The category of every top-level opencode.json key. */
export const CATEGORY: Record<keyof typeof ConfigV1.Info.fields, Category> = {
  model: "Models & agents",
  small_model: "Models & agents",
  default_agent: "Models & agents",
  subagent: "Models & agents",
  external: "Models & agents",
  subagent_depth: "Models & agents",
  agent: "Models & agents",
  mode: "Models & agents",
  provider: "Models & agents",
  enabled_providers: "Models & agents",
  disabled_providers: "Models & agents",
  permission: "Permissions",
  tools: "Permissions",
  // XCOD-144: a sandbox bounds what the agent can do to this machine, the same question permissions
  // answer, but enforced by the container rather than by prompts. Not residency: it doesn't decide
  // where data goes (network egress isn't restricted yet).
  sandbox: "Permissions",
  residency: "Residency & privacy",
  audit: "Residency & privacy",
  share: "Residency & privacy",
  autoshare: "Residency & privacy",
  memory: "Memory",
  marketplace: "Marketplace & plugins",
  marketplace_default: "Marketplace & plugins",
  marketplace_unreviewed: "Marketplace & plugins",
  agent_import: "Models & agents",
  marketplace_allow: "Marketplace & plugins",
  plugin: "Marketplace & plugins",
  layout: "Appearance",
  username: "Appearance",
  autoupdate: "Updates",
  lsp: "Tools",
  formatter: "Tools",
  mcp: "Tools",
  command: "Tools",
  skills: "Tools",
  hooks: "Tools",
  references: "Tools",
  reference: "Tools",
  shell: "Tools",
  instructions: "Advanced / experimental",
  snapshot: "Advanced / experimental",
  compaction: "Advanced / experimental",
  tool_output: "Advanced / experimental",
  attachment: "Advanced / experimental",
  watcher: "Advanced / experimental",
  server: "Advanced / experimental",
  enterprise: "Advanced / experimental",
  logLevel: "Advanced / experimental",
  experimental: "Advanced / experimental",
  $schema: "Advanced / experimental",
  $locked: "Advanced / experimental",
}

/** Keys edited in an existing dialog rather than in place. */
export type Dialog = "models" | "themes" | "mcps" | "providers" | "modes"
const DIALOG: Record<string, Dialog> = {
  model: "models",
  small_model: "models",
  "subagent.model": "models",
  "subagent.dynamic.allow": "models",
  mcp: "mcps",
  provider: "providers",
  "tui.theme": "themes",
}

/** Changes the running app only picks up on a restart (the ticket's "restart required"). */
const RESTART = [
  "plugin",
  "mcp",
  "memory",
  "lsp",
  "formatter",
  "server",
  "logLevel",
  "watcher",
  "enterprise",
  "tui.",
  // Read once, when `lunos` / `lunos run` starts, to decide whether to start a sandbox.
  "sandbox",
]
const NO_RESTART = ["tui.theme"]

const READONLY = ["$schema", "$locked"]

/** Shown when a key is unset. Only where Lunos's effective default differs from "nothing". */
const DEFAULTS: Record<string, unknown> = {
  share: "disabled",
  autoupdate: true,
  snapshot: true,
  subagent_depth: 1,
  marketplace_default: true,
  "memory.enabled": false,
  "sandbox.enabled": false,
  "sandbox.required": false,
  "sandbox.workspace": "copy",
  "sandbox.on_finish": "destroy",
  "sandbox.network": "policy",
  "sandbox.results": "branch",
  "sandbox.devcontainer": "image",
  "sandbox.resources.cpus": 2,
  "sandbox.resources.memory": "4g",
  "sandbox.resources.pids": 512,
  "sandbox.resources.tmp": "1g",
  "compaction.auto": true,
  "compaction.prune": false,
  "tool_output.max_lines": 2000,
  "tool_output.max_bytes": 51200,
  "tui.theme": "catppuccin",
  "tui.mouse": true,
}

/** Environment variables that win over whatever the files say. */
const ENV_OVERRIDES: { key: string; active: (env: Record<string, string | undefined>) => string | undefined }[] = [
  {
    key: "autoupdate",
    active: (env) =>
      ["OPENCODE_DISABLE_AUTOUPDATE", "LUNOS_DISABLE_AUTOUPDATE", "LUNOS_OFFLINE"].find((name) => truthy(env[name])),
  },
  {
    key: "compaction.auto",
    active: (env) => (truthy(env.OPENCODE_DISABLE_AUTOCOMPACT) ? "OPENCODE_DISABLE_AUTOCOMPACT" : undefined),
  },
  {
    key: "compaction.prune",
    active: (env) => (truthy(env.OPENCODE_DISABLE_PRUNE) ? "OPENCODE_DISABLE_PRUNE" : undefined),
  },
  { key: "memory.enabled", active: (env) => (MemorySwitch.envDisables(env) ? MemorySwitch.ENV : undefined) },
  { key: "memory", active: (env) => (MemorySwitch.envDisables(env) ? MemorySwitch.ENV : undefined) },
  {
    key: "share",
    active: (env) =>
      ["OPENCODE_DISABLE_SHARE", "LUNOS_OFFLINE"].find((name) => truthy(env[name])) ??
      (truthy(env.OPENCODE_AUTO_SHARE) ? "OPENCODE_AUTO_SHARE" : undefined),
  },
  { key: "permission", active: (env) => (env.OPENCODE_PERMISSION ? "OPENCODE_PERMISSION" : undefined) },
]

function truthy(value: string | undefined) {
  const v = value?.toLowerCase()
  return v === "true" || v === "1"
}

export type Kind = "boolean" | "enum" | "string" | "number" | "list" | "object"
export type Target = "config" | "tui"
export type Scope = "user" | "project"
export type Source = "default" | "user" | "project" | "env" | "managed" | "remote"

export type Entry = {
  /** Dotted path, e.g. `share`, `compaction.auto`, `tui.theme`. */
  key: string
  target: Target
  label: string
  category: Category
  description: string
  kind: Kind
  /** Enum values, in schema order. Booleans in a union (`autoupdate`) appear as `true`/`false`. */
  values?: (string | boolean)[]
  dialog?: Dialog
  restart: boolean
  deprecated: boolean
  /** A top-level key: its nested leaves may also have entries of their own. */
  top: boolean
  /** Shown, never written from here (`$locked` only means something in managed config). */
  readonly: boolean
}

// ---------------------------------------------------------------------------------------------
// Schema walk

function members(ast: SchemaAST.AST): SchemaAST.AST[] {
  if (ast._tag === "Union") return ast.types.flatMap(members)
  return [ast]
}

function concrete(ast: SchemaAST.AST) {
  return members(ast).filter((item) => item._tag !== "Undefined")
}

function struct(ast: SchemaAST.AST): SchemaAST.Objects | undefined {
  const list = concrete(ast)
  if (list.length !== 1) return
  const only = list[0]
  if (only._tag === "Objects" && only.indexSignatures.length === 0) return only
  if (only._tag === "Declaration" && only.typeParameters.length === 1) {
    const inner = only.typeParameters[0]
    if (inner._tag === "Objects" && inner.indexSignatures.length === 0) return inner
  }
}

function classify(ast: SchemaAST.AST): Pick<Entry, "kind" | "values"> {
  const list = concrete(ast)
  if (list.length === 0) return { kind: "object" }
  if (list.every((item) => item._tag === "Boolean")) return { kind: "boolean" }
  if (list.every((item) => item._tag === "Literal" || item._tag === "Boolean")) {
    const values = list.flatMap((item): (string | boolean)[] =>
      item._tag === "Boolean"
        ? [true, false]
        : item._tag === "Literal" && typeof item.literal === "string"
          ? [item.literal]
          : [],
    )
    if (
      values.length ===
      list.filter((i) => i._tag === "Literal").length + (list.some((i) => i._tag === "Boolean") ? 2 : 0)
    )
      return { kind: "enum", values }
  }
  if (list.length === 1 && list[0]._tag === "String") return { kind: "string" }
  if (list.length === 1 && list[0]._tag === "Number") return { kind: "number" }
  if (list.length === 1 && list[0]._tag === "Arrays") {
    const arr = list[0]
    const item = arr.rest[0]
    if (arr.elements.length === 0 && item && concrete(item).every((i) => i._tag === "String" || i._tag === "Literal"))
      return { kind: "list", values: listValues(item) }
  }
  return { kind: "object" }
}

function listValues(ast: SchemaAST.AST) {
  const list = concrete(ast)
  if (!list.every((i) => i._tag === "Literal")) return undefined
  return list.map((i) => String((i as SchemaAST.Literal).literal))
}

function describe(ast: SchemaAST.AST) {
  return (
    SchemaAST.resolveDescription(ast) ??
    concrete(ast)
      .map((i) => SchemaAST.resolveDescription(i))
      .find(Boolean) ??
    ""
  )
}

function labelOf(key: string) {
  const last = key.split(".").slice(key.startsWith("tui.") ? 1 : 0)
  const words = last
    .join(" ")
    .replace(/^\$/, "")
    .replace(/[_.]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase()
}

function needsRestart(key: string) {
  if (NO_RESTART.includes(key)) return false
  return RESTART.some((item) =>
    item.endsWith(".") ? key.startsWith(item) : key === item || key.startsWith(item + "."),
  )
}

function entry(key: string, target: Target, category: Category, ast: SchemaAST.AST, top: boolean): Entry {
  const description = describe(ast)
  const classified = classify(ast)
  return {
    key,
    target,
    label: labelOf(key),
    category,
    description,
    ...classified,
    dialog: DIALOG[key],
    restart: needsRestart(key),
    deprecated: description.startsWith("@deprecated"),
    top,
    readonly: READONLY.includes(key),
  }
}

function walk(prefix: string, target: Target, category: Category, ast: SchemaAST.AST, depth: number): Entry[] {
  const inner = struct(ast)
  if (!inner || depth > 2) return []
  return inner.propertySignatures.flatMap((prop) => {
    const key = `${prefix}.${String(prop.name)}`
    const child = entry(key, target, category, prop.type, false)
    if (child.kind !== "object") return [child]
    // XCOD-158: a list of objects has no fields to walk into, so it isn't listed; these are, edited
    // as JSON, whole. (Not every such list: keybinds and hooks have their own screens.)
    if (WHOLE_LISTS.includes(key)) return [child]
    return walk(key, target, category, prop.type, depth + 1)
  })
}

const WHOLE_LISTS = ["sandbox.mounts"]

let cached: Entry[] | undefined

/** Every setting, in category order then schema order. */
export function entries(): Entry[] {
  if (cached) return cached
  const config = Object.entries(ConfigV1.Info.fields).flatMap(([key, schema]) => {
    const category = CATEGORY[key as keyof typeof CATEGORY] ?? "Advanced / experimental"
    const top = entry(key, "config", category, schema.ast, true)
    return [top, ...walk(key, "config", category, schema.ast, 1)]
  })
  const tui = Object.entries(TuiConfig.Info.fields)
    .filter(([key]) => key !== "$schema")
    .flatMap(([key, schema]) => {
      const top = entry(`tui.${key}`, "tui", "Appearance", schema.ast, true)
      if (key === "theme") top.kind = "string"
      return [top, ...walk(`tui.${key}`, "tui", "Appearance", schema.ast, 1)]
    })
  // Within a category, top-level keys follow CATEGORY's order (model first, not schema order).
  const order = Object.keys(CATEGORY)
  const rank = (item: Entry) => (item.target === "tui" ? order.length : order.indexOf(item.key.split(".")[0]))
  const all = [...config, ...tui]
  cached = CATEGORIES.flatMap((category) =>
    all.filter((item) => item.category === category).toSorted((a, b) => rank(a) - rank(b)),
  )
  return cached
}

const ALIASES: Record<string, string> = { theme: "tui.theme" }

/**
 * XCOD-215: the fields of one agent that /settings → Agents edits one at a time, as
 * `agent.<name>.<field>`. `agent` is a record, so the schema walk has no entries for them; they
 * are made on demand from the agent schema, and saved with the same checks as any other key.
 * `tools` and `maxSteps` are deprecated and only ever removed (by migration), never written.
 */
export const AGENT_FIELDS = [
  "model",
  "variant",
  "disable",
  "mode",
  "hidden",
  "steps",
  "temperature",
  "top_p",
  "description",
  "prompt",
  "color",
  "permission",
  "options",
] as const
export type AgentField = (typeof AGENT_FIELDS)[number]

/** Sensible ranges, checked on save; the schema only says "a number". */
const AGENT_RANGES: Partial<Record<AgentField, [number, number]>> = { temperature: [0, 2], top_p: [0, 1] }

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function agentEntry(key: string): Entry | undefined {
  const parts = key.split(".")
  if (parts[0] !== "agent" || parts.length < 2 || parts.length > 3 || !AGENT_NAME.test(parts[1])) return
  if (parts.length === 2)
    return { ...entry(key, "config", "Models & agents", ConfigV1.Info.fields.agent.ast, false), kind: "object" }
  const field = parts[2] as AgentField
  if (!AGENT_FIELDS.includes(field)) return
  const result = entry(key, "config", "Models & agents", ConfigAgentV1.Fields[field].ast, false)
  if (field === "model") result.dialog = "models"
  if (field === "steps") result.kind = "number"
  return result
}

export function find(key: string) {
  const name = ALIASES[key] ?? key
  return entries().find((item) => item.key === name) ?? agentEntry(name)
}

// ---------------------------------------------------------------------------------------------
// Files

export type Context = { directory: string; worktree?: string }

function firstExisting(candidates: string[]) {
  return candidates.find((file) => existsSync(file))
}

/** The file a write in `scope` lands in: an existing .jsonc wins, otherwise the .json. */
export function targetFile(target: Target, scope: Scope, ctx: Context) {
  const name = target === "config" ? "opencode" : "tui"
  if (scope === "user") {
    const candidates =
      target === "config"
        ? ["opencode.jsonc", "opencode.json", "config.json"].map((f) => path.join(Global.Path.config, f))
        : [`${name}.jsonc`, `${name}.json`].map((f) => path.join(Global.Path.config, f))
    return firstExisting(candidates) ?? path.join(Global.Path.config, `${name}.json`)
  }
  const dir = path.join(projectRoot(ctx), ".opencode")
  return (
    firstExisting([path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)]) ?? path.join(dir, `${name}.json`)
  )
}

function projectRoot(ctx: Context) {
  return ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
}

async function readText(file: string) {
  return fs.readFile(file, "utf8").catch(() => undefined)
}

function rawDoc(text: string | undefined) {
  if (!text) return undefined
  return parseJsonc(text, [], { allowTrailingComma: true }) as unknown
}

export type Layer = { layer: Source | "cli"; path: string; loaded: boolean }

/** The config files Lunos reads, lowest precedence first, and whether each exists. */
export async function layers(ctx: Context): Promise<Layer[]> {
  const result: Layer[] = []
  const add = (layer: Layer["layer"], file: string) => {
    if (!result.some((item) => item.path === file)) result.push({ layer, path: file, loaded: existsSync(file) })
  }
  for (const file of ["config.json", "opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"])
    add("user", path.join(Global.Path.config, file))
  if (Flag.OPENCODE_CONFIG) add("env", Flag.OPENCODE_CONFIG)
  if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
    const root = projectRoot(ctx)
    for (const file of ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"])
      add("project", path.join(root, file))
    for (const file of ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc"])
      add("project", path.join(root, ".opencode", file))
  }
  if (Flag.OPENCODE_CONFIG_DIR)
    for (const file of ["opencode.json", "opencode.jsonc"]) add("env", path.join(Flag.OPENCODE_CONFIG_DIR, file))
  if (process.env.OPENCODE_CONFIG_CONTENT) result.push({ layer: "env", path: "OPENCODE_CONFIG_CONTENT", loaded: true })
  const managed = ConfigManaged.managedConfigLocation().dir
  for (const file of ["managed.json", "opencode.json", "opencode.jsonc"]) add("managed", path.join(managed, file))
  return result
}

/** The organisation's `$locked` list, straight from managed config. */
export async function lockedKeys() {
  const docs = await ConfigManaged.readManagedDocs().catch(() => [] as unknown[])
  return ConfigPolicy.union(...docs.map((doc) => ConfigPolicy.lockList(doc)))
}

/** Locked itself, under a locked parent, or a parent whose subtree holds a locked key. */
export function isLocked(locked: ReadonlyArray<string>, key: string) {
  return ConfigPolicy.isLocked(locked, key) || locked.some((item) => item.startsWith(`${key}.`))
}

// ---------------------------------------------------------------------------------------------
// Listing

export type Origin = { layer: "managed" | "global" | "project" | "env" | "remote"; source: string }

export type Row = {
  key: string
  target: Target
  label: string
  category: Category
  description: string
  kind: Kind
  values?: (string | boolean)[]
  dialog?: Dialog
  restart: boolean
  deprecated: boolean
  top: boolean
  readonly: boolean
  /** JSON-safe current value, secrets masked, `{env:}`/`{file:}` references shown as written. */
  value: unknown
  /** One line for the list. */
  display: string
  source: Source
  /** The file (or variable) the value came from, when known. */
  from?: string
  locked: boolean
  /** Set when an environment variable or flag overrides the files. */
  override?: string
  secret: boolean
}

const SECRET = /(?:api.?key|secret|password|token$|authorization$|cookie$|credential|private.?key)/i

function redact(value: unknown, headers = false): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, headers))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item === "string" && (headers || SECRET.test(key)) && !isReference(item)) return [key, "***"]
      return [key, redact(item, headers || key.toLowerCase() === "headers")]
    }),
  )
}

export function isReference(value: unknown) {
  return typeof value === "string" && /\{(env|file):[^}]+\}/.test(value)
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

export function display(value: unknown, kind: Kind): string {
  if (value === undefined) return "not set"
  if (kind === "object") {
    if (Array.isArray(value))
      return value.length === 0 ? "none" : `${value.length} item${value.length === 1 ? "" : "s"}`
    if (value && typeof value === "object") {
      const keys = Object.keys(value)
      return keys.length === 0 ? "empty" : keys.length <= 3 ? keys.join(", ") : `${keys.length} entries`
    }
  }
  if (Array.isArray(value)) return value.length === 0 ? "none" : value.join(", ")
  if (typeof value === "string") return value
  return JSON.stringify(value)
}

function sourceOf(origin: Origin | undefined): Source {
  if (!origin) return "default"
  if (origin.layer === "global") return "user"
  return origin.layer
}

/**
 * The value as written in the file the winning layer came from, so `{env:X}` shows as the
 * reference rather than the resolved secret.
 */
async function rawValue(key: string, entry: Entry, origin: Origin | undefined, ctx: Context) {
  const path_ = key.split(".").slice(entry.target === "tui" ? 1 : 0)
  const files: string[] = []
  if (entry.target === "tui") {
    files.push(targetFile("tui", "project", ctx), targetFile("tui", "user", ctx))
  } else if (origin?.layer === "global") {
    files.push(targetFile("config", "user", ctx))
  } else if (origin && origin.source !== "OPENCODE_CONFIG_CONTENT" && origin.source.includes(path.sep)) {
    files.push(origin.source)
  }
  for (const file of files) {
    const doc = rawDoc(await readText(file))
    const value = ConfigPolicy.get(doc, path_.join("."))
    if (value !== undefined) return { value, file }
  }
  return undefined
}

function containsReference(value: unknown): boolean {
  if (isReference(value)) return true
  if (Array.isArray(value)) return value.some(containsReference)
  if (value && typeof value === "object") return Object.values(value).some(containsReference)
  return false
}

export async function list(input: {
  config: unknown
  origins: Record<string, Origin>
  locked: ReadonlyArray<string>
  ctx: Context
  env?: Record<string, string | undefined>
}): Promise<Row[]> {
  const env = input.env ?? process.env
  return Promise.all(
    entries().map(async (item): Promise<Row> => {
      const top = item.key.split(".")[0]
      const origin = item.target === "config" ? input.origins[top] : undefined
      const raw = await rawValue(item.key, item, origin, input.ctx)
      // tui.json is loaded by the TUI process; here the files are the resolved value.
      const resolved = item.target === "tui" ? raw?.value : ConfigPolicy.get(input.config, item.key)
      let source: Source
      if (item.target === "tui")
        source = raw ? (raw.file.includes(`${path.sep}.opencode${path.sep}`) ? "project" : "user") : "default"
      else source = resolved === undefined || (!item.top && !origin) ? "default" : sourceOf(origin)
      if (item.target === "config" && resolved === undefined && origin?.layer !== "managed") source = "default"
      const envName = ENV_OVERRIDES.find((o) => o.key === item.key)?.active(env)
      const locked = item.target === "config" && isLocked(input.locked, item.key)
      if (locked || (item.key === ConfigPolicy.FIELD && input.locked.length)) source = "managed"
      else if (envName) source = "env"
      const secret = SECRET.test(item.key.split(".").at(-1) ?? "") || item.key === "provider"
      let value: unknown = raw && containsReference(raw.value) ? raw.value : resolved
      value = jsonSafe(value)
      if (value === undefined && source === "default") value = DEFAULTS[item.key]
      value = secret || item.kind === "object" ? redact(value, false) : value
      if (secret && typeof value === "string" && !isReference(value)) value = "***"
      return {
        ...item,
        value,
        display: display(value, item.kind),
        source,
        from: locked ? origin?.source : (envName ?? raw?.file ?? origin?.source),
        locked,
        override: envName
          ? `${envName} is set, so it wins over the config files until it's removed from the environment`
          : undefined,
        secret,
      }
    }),
  )
}

// ---------------------------------------------------------------------------------------------
// Writing

export class SettingError extends Error {
  constructor(
    message: string,
    readonly code: "unknown" | "locked" | "invalid" | "object",
  ) {
    super(message)
    this.name = "SettingError"
  }
}

function allowed(item: Entry) {
  return (item.values ?? []).map(String).join(", ")
}

/** Turns what a user typed into the value to store, or explains why it can't be. */
export function coerce(item: Entry, input: unknown): unknown {
  if (typeof input !== "string") return input
  const text = input.trim()
  const json = () => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown }
    } catch {
      return { ok: false as const }
    }
  }
  switch (item.kind) {
    case "boolean": {
      const v = text.toLowerCase()
      if (["true", "on", "yes", "1"].includes(v)) return true
      if (["false", "off", "no", "0"].includes(v)) return false
      throw new SettingError(`Invalid value "${text}" for ${item.key}. Allowed values: true, false`, "invalid")
    }
    case "enum": {
      const match = item.values!.find((value) => String(value) === text)
      if (match === undefined)
        throw new SettingError(`Invalid value "${text}" for ${item.key}. Allowed values: ${allowed(item)}`, "invalid")
      return match
    }
    case "number": {
      const n = Number(text)
      if (text === "" || !Number.isFinite(n))
        throw new SettingError(`Invalid value "${text}" for ${item.key}. Expected a number`, "invalid")
      return n
    }
    case "list": {
      const parsed = text.startsWith("[") ? json() : undefined
      if (parsed?.ok) return parsed.value
      const list =
        text === ""
          ? []
          : text
              .split(",")
              .map((part) => part.trim())
              .filter(Boolean)
      if (item.values) {
        const bad = list.filter((value) => !item.values!.includes(value))
        if (bad.length)
          throw new SettingError(
            `Invalid value "${bad.join(", ")}" for ${item.key}. Allowed values: ${allowed(item)}`,
            "invalid",
          )
      }
      return list
    }
    case "object": {
      const parsed = json()
      if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object")
        throw new SettingError(
          `${item.key} holds structured settings: pass JSON, or edit it in the config file`,
          "object",
        )
      return parsed.value
    }
    default:
      return text
  }
}

function issues(error: unknown) {
  if (error instanceof InvalidError)
    return error.data.issues
      ?.map((issue: { path: string[]; message: string }) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
  return error instanceof Error ? error.message : String(error)
}

/** Decodes a whole file's text the way the live config loader does. */
export async function decode(target: Target, text: string, file: string) {
  const expanded = await ConfigVariable.substitute({ text, type: "path", path: file, missing: "empty" })
  const parsed = ConfigParse.jsoncSubstituted(text, expanded, file)
  if (target === "tui") return ConfigParse.schema(TuiConfig.Info, parsed, file) as unknown
  return ConfigParse.schema(
    ConfigV1.Info,
    ConfigV2Compat.lower(normalizeLoadedConfig(parsed), file).value,
    file,
  ) as unknown
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
      .join(",")}}`
  return JSON.stringify(value)
}

/**
 * XCOD-214: settings whose value names a model, checked against the models available here when
 * the caller knows them. `subagent.model` also takes "inherit" and "small"; `subagent.dynamic.allow`
 * is a list.
 */
const MODEL_KEYS: Record<string, "one" | "subagent" | "list"> = {
  model: "one",
  small_model: "one",
  "subagent.model": "subagent",
  "subagent.dynamic.allow": "list",
}

/**
 * Why `value` isn't a usable model for `key`, with the closest matches; undefined when it is.
 * `blocked` (XCOD-212) maps models the residency policy refuses to the policy's reason.
 */
export function modelProblem(
  key: string,
  value: unknown,
  models: ReadonlySet<string>,
  blocked?: ReadonlyMap<string, string>,
): string | undefined {
  // XCOD-215: an agent's model takes the same values as subagent.model (XCOD-82).
  const kind = MODEL_KEYS[key] ?? (/^agent\.[^.]+\.model$/.test(key) ? "subagent" : undefined)
  if (!kind) return
  const ids = kind === "list" ? (Array.isArray(value) ? value : [value]) : [value]
  for (const id of ids) {
    if (typeof id !== "string") return `${key} takes "provider/model" names`
    if (kind === "subagent" && (id === "inherit" || id === "small")) continue
    const reason = blocked?.get(id)
    if (reason) return `"${id}" is blocked by the data-residency policy. ${reason.replace(/\.$/, "")}`
    if (models.has(id)) continue
    const close = fuzzysort.go(id, [...models], { limit: 3, threshold: 0.3 }).map((match) => match.target)
    const extra = kind === "subagent" ? ', or "inherit" or "small"' : ""
    return (
      `"${id}" isn't a model available here (see \`lunos models\`)` +
      (close.length
        ? `. Did you mean ${close.map((name) => `"${name}"`).join(", ")}${extra}?`
        : extra
          ? `. Use provider/model${extra}.`
          : "")
    )
  }
}

export type SetResult = { key: string; value: unknown; file: string; scope: Scope; restart: boolean; changed: boolean }

/**
 * XCOD-158: sandbox settings a repository's config can't choose (they'd weaken the sandbox), so a
 * write to project config would be ignored when it loads. Refused up front instead, with why. Each
 * returns the reason for a value, or undefined when a project may set it.
 */
const USER_ONLY: Record<string, (value: unknown) => string | undefined> = {
  "sandbox.allow": () => "extra hosts for the sandbox's network are yours to allow, not a repository's",
  "sandbox.workspace": (value) =>
    value === "copy" ? undefined : "mounting your working tree weakens the sandbox, so it's yours to choose",
  "sandbox.mounts": () => "mounting directories from this machine is yours to choose, not a repository's",
  "sandbox.devcontainer": (value) =>
    value === "off"
      ? undefined
      : "a repository can only turn its devcontainer off; building one runs its steps on this machine",
  "sandbox.network": (value) =>
    value === "open" ? "a repository can make the sandbox's network stricter, never open it" : undefined,
}

/** Why `key` = `value` can't go in project config, or undefined when it can. */
export function projectRefusal(key: string, value: unknown) {
  const rule = Object.entries(USER_ONLY).find(([entry]) => key === entry || key.startsWith(`${entry}.`))?.[1]
  const reason = rule?.(value)
  return reason
    ? `${key} can't be set in project config (${reason}): a repository's config is ignored for it. ` +
        "Save it to your user config instead."
    : undefined
}

/**
 * Validates and writes one setting. Refuses locked keys with the policy message, rejects values
 * the live schema wouldn't load (listing the allowed values), and edits the file in place with
 * jsonc-parser so comments and formatting survive. Nothing is written unless every check passes.
 */
/** The entry for `key`, if it exists and this caller may change it; otherwise why not. */
async function writable(input: { key: string; locked?: ReadonlyArray<string>; via?: string }) {
  const item = find(input.key)
  if (!item)
    throw new SettingError(`Unknown setting "${input.key}". Run \`lunos settings list\` to see them all.`, "unknown")
  if (item.readonly)
    throw new SettingError(
      item.key === "$locked"
        ? "$locked is organisation policy and is only read from managed config"
        : `${item.key} can't be changed from settings`,
      "invalid",
    )
  const locked = input.locked ?? (await lockedKeys())
  if (item.target === "config" && isLocked(locked, item.key)) {
    const lockedKey = locked.find(
      (entry) => item.key === entry || item.key.startsWith(`${entry}.`) || entry.startsWith(`${item.key}.`),
    )!
    ConfigPolicy.notifyRefused(lockedKey, input.via ?? "settings")
    throw new SettingError(ConfigPolicy.message(lockedKey), "locked")
  }
  return item
}

export async function set(input: {
  key: string
  value: unknown
  scope: Scope
  ctx: Context
  locked?: ReadonlyArray<string>
  via?: string
  /** The models available here, as "provider/model", to check model-valued settings against. */
  models?: ReadonlySet<string>
  /** Models the residency policy blocks, with the reason (XCOD-212). */
  blocked?: ReadonlyMap<string, string>
}): Promise<SetResult> {
  const item = await writable(input)
  const value = coerce(item, input.value)
  const problem = input.models ? modelProblem(item.key, value, input.models, input.blocked) : undefined
  if (problem) throw new SettingError(`${item.key}: ${problem.replace(/\.$/, "")}. Nothing was written.`, "invalid")
  const range = AGENT_RANGES[item.key.split(".")[2] as AgentField]
  if (range && item.key.startsWith("agent.") && typeof value === "number" && (value < range[0] || value > range[1]))
    throw new SettingError(`${item.key} must be between ${range[0]} and ${range[1]}. Nothing was written.`, "invalid")
  const refusal = input.scope === "project" ? projectRefusal(item.key, value) : undefined
  if (refusal) throw new SettingError(refusal, "invalid")
  const file = targetFile(item.target, input.scope, input.ctx)
  const before = await readText(file)
  const schema = item.target === "config" ? "https://lunos.tech/config.json" : "https://lunos.tech/tui.json"
  const base = before && before.trim() ? before : `{\n  "$schema": "${schema}"\n}\n`
  const jsonPath = item.key.split(".").slice(item.target === "tui" ? 1 : 0)
  // A leaf under a key that holds a non-object (`"formatter": false`) can't be set by path.
  const doc = rawDoc(base)
  for (let i = 1; i < jsonPath.length; i++) {
    const parent = ConfigPolicy.get(doc, jsonPath.slice(0, i).join("."))
    if (parent !== undefined && (parent === null || typeof parent !== "object" || Array.isArray(parent)))
      throw new SettingError(
        `${jsonPath.slice(0, i).join(".")} in ${file} isn't an object, so ${item.key} can't be set inside it`,
        "invalid",
      )
  }
  const updated = applyEdits(
    base,
    modify(base, jsonPath, value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }),
  )
  let decoded: unknown
  try {
    decoded = await decode(item.target, updated, file)
  } catch (error) {
    const hint = item.values ? ` Allowed values: ${allowed(item)}` : ""
    throw new SettingError(`Invalid value for ${item.key}: ${issues(error)}.${hint}`, "invalid")
  }
  // A struct decode drops keys it doesn't know; make sure what we meant to write survives it.
  const landed = ConfigPolicy.get(decoded, jsonPath.join("."))
  if (stable(jsonSafe(landed)) !== stable(value))
    throw new SettingError(
      `${item.key} didn't survive the config schema (it would load as ${JSON.stringify(jsonSafe(landed))}), so nothing was written`,
      "invalid",
    )
  const changed = updated !== before
  if (changed) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, updated)
  }
  return { key: item.key, value, file, scope: input.scope, restart: item.restart, changed }
}

/**
 * XCOD-215: removes `key` from one scope's file, so the value falls back to the next layer or the
 * default ("Reset to default", and migrating deprecated keys). An object left empty by the removal
 * goes too, so resetting an agent's last override leaves no `"build": {}` behind.
 */
export async function unset(input: {
  key: string
  scope: Scope
  ctx: Context
  locked?: ReadonlyArray<string>
  via?: string
}): Promise<SetResult> {
  const item = await writable(input)
  const file = targetFile(item.target, input.scope, input.ctx)
  const before = await readText(file)
  const jsonPath = item.key.split(".").slice(item.target === "tui" ? 1 : 0)
  if (!before || ConfigPolicy.get(rawDoc(before), jsonPath.join(".")) === undefined)
    return { key: item.key, value: undefined, file, scope: input.scope, restart: item.restart, changed: false }
  let updated = applyEdits(before, modify(before, jsonPath, undefined, {}))
  for (let depth = jsonPath.length - 1; depth >= 1; depth--) {
    const parent = ConfigPolicy.get(rawDoc(updated), jsonPath.slice(0, depth).join("."))
    if (!parent || typeof parent !== "object" || Object.keys(parent).length > 0) break
    updated = applyEdits(updated, modify(updated, jsonPath.slice(0, depth), undefined, {}))
  }
  try {
    await decode(item.target, updated, file)
  } catch (error) {
    throw new SettingError(`Removing ${item.key} would leave ${file} invalid: ${issues(error)}`, "invalid")
  }
  await fs.writeFile(file, updated)
  return { key: item.key, value: undefined, file, scope: input.scope, restart: item.restart, changed: true }
}

/** XCOD-215: the deprecated agent keys in one scope's file, as dotted paths. */
export function deprecatedAgentKeys(doc: unknown): string[] {
  if (!doc || typeof doc !== "object") return []
  const record = doc as Record<string, unknown>
  const found: string[] = []
  if (record.mode && typeof record.mode === "object") found.push("mode")
  for (const [name, agent] of Object.entries((record.agent as Record<string, unknown>) ?? {})) {
    if (!agent || typeof agent !== "object") continue
    for (const key of ["tools", "maxSteps"]) if (key in agent) found.push(`agent.${name}.${key}`)
  }
  return found
}

/** `tools: { bash: false }` as permission rules, the way the agent schema reads it. */
function toolsToPermission(tools: Record<string, unknown>) {
  const permission: Record<string, string> = {}
  for (const [tool, enabled] of Object.entries(tools)) {
    const action = enabled ? "allow" : "deny"
    permission[tool === "write" || tool === "edit" || tool === "patch" ? "edit" : tool] = action
  }
  return permission
}

/**
 * XCOD-215: rewrites one scope's deprecated agent keys without losing values. Top-level `mode.<name>`
 * moves under `agent.<name>`, `tools` becomes `permission` and `maxSteps` becomes `steps`. A value
 * already set on the new key wins, as it does when the config loads, so nothing changes meaning.
 */
export async function migrateAgents(input: {
  scope: Scope
  ctx: Context
  locked?: ReadonlyArray<string>
  via?: string
}) {
  await writable({ key: "agent", locked: input.locked, via: input.via })
  // Every file of the scope that can hold agents, not only the one /settings writes to: a project's
  // root opencode.json is as much project config as .opencode/opencode.json.
  const root = projectRoot(input.ctx)
  const files =
    input.scope === "user"
      ? ["opencode.jsonc", "opencode.json", "config.json"].map((f) => path.join(Global.Path.config, f))
      : [
          ...["opencode.jsonc", "opencode.json"].map((f) => path.join(root, f)),
          ...["opencode.jsonc", "opencode.json"].map((f) => path.join(root, ".opencode", f)),
        ]
  const migrated: string[] = []
  const touched: string[] = []
  for (const file of files.filter((f) => existsSync(f))) {
    const found = await migrateFile(file)
    if (found.length) {
      migrated.push(...found)
      touched.push(file)
    }
  }
  return { file: touched.join(", ") || targetFile("config", input.scope, input.ctx), migrated }
}

async function migrateFile(file: string) {
  const before = await readText(file)
  const doc = rawDoc(before) as Record<string, any> | undefined
  const found = deprecatedAgentKeys(doc)
  if (!before || !doc || found.length === 0) return []
  const agent: Record<string, any> = structuredClone(doc.agent ?? {})
  if (doc.mode && typeof doc.mode === "object")
    for (const [name, value] of Object.entries(doc.mode as Record<string, any>))
      agent[name] = { ...(value ?? {}), ...(agent[name] ?? {}) }
  for (const value of Object.values(agent)) {
    if (!value || typeof value !== "object") continue
    if (value.tools && typeof value.tools === "object") {
      value.permission = { ...toolsToPermission(value.tools), ...(value.permission ?? {}) }
      delete value.tools
    }
    if ("maxSteps" in value) {
      value.steps ??= value.maxSteps
      delete value.maxSteps
    }
  }
  const format = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
  let updated = applyEdits(before, modify(before, ["agent"], agent, format))
  if ("mode" in doc) updated = applyEdits(updated, modify(updated, ["mode"], undefined, format))
  try {
    await decode("config", updated, file)
  } catch (error) {
    throw new SettingError(`Migrating would leave ${file} invalid: ${issues(error)}. Nothing was written.`, "invalid")
  }
  await fs.writeFile(file, updated)
  return found
}

/** XCOD-215: each scope's own `agent` block (not merged), and the deprecated keys in it. */
export async function agentOverrides(ctx: Context) {
  const read = async (scope: Scope) => {
    const doc = rawDoc(await readText(targetFile("config", scope, ctx))) as Record<string, any> | undefined
    return {
      agent: (doc?.agent ?? {}) as Record<string, Record<string, Schema.Json>>,
      deprecated: deprecatedAgentKeys(doc),
    }
  }
  const [user, project] = await Promise.all([read("user"), read("project")])
  return { user, project }
}

// ---------------------------------------------------------------------------------------------
// HTTP shapes (GET/PATCH /config/settings, SDK: config.settings / config.settingsSet)

export const RowSchema = Schema.Struct({
  key: Schema.String,
  target: Schema.Literals(["config", "tui"]),
  label: Schema.String,
  category: Schema.String,
  description: Schema.String,
  kind: Schema.Literals(["boolean", "enum", "string", "number", "list", "object"]),
  values: Schema.optional(Schema.Array(Schema.Union([Schema.String, Schema.Boolean]))),
  dialog: Schema.optional(Schema.Literals(["models", "themes", "mcps", "providers", "modes"])),
  restart: Schema.Boolean,
  deprecated: Schema.Boolean,
  top: Schema.Boolean,
  readonly: Schema.Boolean,
  value: Schema.optional(Schema.Json),
  display: Schema.String,
  source: Schema.Literals(["default", "user", "project", "env", "managed", "remote"]),
  from: Schema.optional(Schema.String),
  locked: Schema.Boolean,
  override: Schema.optional(Schema.String),
  secret: Schema.Boolean,
}).annotate({ identifier: "SettingRow" })

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache_read: Schema.Finite,
  cache_write: Schema.Finite,
})

export const Usage = Schema.Struct({
  days: Schema.Finite,
  sessions: Schema.Finite,
  cost: Schema.Finite,
  tokens: Tokens,
}).annotate({ identifier: "SettingsUsage" })
export type Usage = Schema.Schema.Type<typeof Usage>

export const SnapshotSchema = Schema.Struct({
  rows: Schema.Array(RowSchema),
  layers: Schema.Array(
    Schema.Struct({
      layer: Schema.Literals(["default", "user", "project", "env", "managed", "remote", "cli"]),
      path: Schema.String,
      loaded: Schema.Boolean,
    }),
  ),
  locked: Schema.Array(Schema.String),
  files: Schema.Struct({
    user: Schema.Struct({ config: Schema.String, tui: Schema.String }),
    project: Schema.Struct({ config: Schema.String, tui: Schema.String }),
  }),
  usage: Usage,
  // XCOD-158: sandboxes, for the Status tab. Optional, so older servers still decode.
  sandbox: Schema.optional(
    Schema.Struct({
      inside: Schema.optional(
        Schema.Struct({
          id: Schema.String,
          image: Schema.optional(Schema.String),
          digest: Schema.optional(Schema.String),
          network: Schema.optional(Schema.String),
          results: Schema.optional(Schema.String),
          workspace: Schema.optional(Schema.String),
          devcontainer: Schema.optional(Schema.String),
          runtime: Schema.optional(Schema.String),
          created: Schema.optional(Schema.String),
        }),
      ),
      known: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          created: Schema.String,
          branch: Schema.String,
          network: Schema.String,
          results: Schema.optional(Schema.String),
          workspace: Schema.optional(Schema.String),
          expires: Schema.optional(Schema.String),
          handedOff: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
}).annotate({ identifier: "SettingsSnapshot" })

export const SetInput = Schema.Struct({
  key: Schema.String,
  /** As typed: `true`, `notify`, `eu,us`, or JSON for objects. Ignored when `unset`. */
  value: Schema.String,
  scope: Schema.Literals(["user", "project"]),
  /** XCOD-215: remove the key from this scope instead ("Reset to default"). */
  unset: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "SettingsSetInput" })

export const MigrateInput = Schema.Struct({ scope: Schema.Literals(["user", "project"]) }).annotate({
  identifier: "AgentsMigrateInput",
})

export const MigrateOutput = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), file: Schema.String, migrated: Schema.Array(Schema.String) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]).annotate({ identifier: "AgentsMigrateOutput" })

export const SetOutput = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    key: Schema.String,
    value: Schema.optional(Schema.Json),
    file: Schema.String,
    scope: Schema.Literals(["user", "project"]),
    restart: Schema.Boolean,
    changed: Schema.Boolean,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
    code: Schema.String,
  }),
]).annotate({ identifier: "SettingsSetResult" })

/** Totals over session rows, the same columns `lunos stats` sums. */
export function usage(
  sessions: ReadonlyArray<{
    cost: number
    tokens_input: number
    tokens_output: number
    tokens_reasoning: number
    tokens_cache_read: number
    tokens_cache_write: number
  }>,
  days: number,
): Usage {
  const tokens = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 }
  let cost = 0
  for (const row of sessions) {
    cost += row.cost
    tokens.input += row.tokens_input
    tokens.output += row.tokens_output
    tokens.reasoning += row.tokens_reasoning
    tokens.cache_read += row.tokens_cache_read
    tokens.cache_write += row.tokens_cache_write
  }
  return { days, sessions: sessions.length, cost, tokens }
}
