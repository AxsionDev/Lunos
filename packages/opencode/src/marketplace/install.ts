import path from "path"
import { isDeepStrictEqual } from "util"
import { modify, applyEdits, parse as parseJsonc } from "jsonc-parser"
import type { Marketplace } from "@opencode-ai/core/marketplace"
import { ConfigHooks } from "@opencode-ai/core/config/hooks"
import { Filesystem } from "@/util/filesystem"
import { mcpConfigFromEntry } from "../mcp/discover"
import {
  MarketplaceRefusal,
  envReferences,
  headerEnvName,
  rejectSubstitution,
  requireHttpUrl,
  MarketplaceAlreadyInstalled,
} from "./guard"
import type { ContentItem } from "./content"
import { defaultFetchDeps, type FetchDeps } from "./shared"

// Installs marketplace content that lands in config (MCP servers, skill sources, hooks). Plugins
// are NOT handled here: they already have an install path (`lunos plugin <spec>` / the TUI's
// api.plugins.install) that fetches, reads the plugin's manifest and patches config itself.
//
// Split into plan + apply so every surface shows the user exactly what will change -- and refuses
// the same things -- before anything is written. The CLI and the TUI both call planInstall; neither
// may write marketplace content to config any other way, or the guards stop covering it.

export type ConfigKind = Exclude<Marketplace.Kind, "plugin">
export type ConfigItem = Extract<ContentItem, { kind: ConfigKind }>

export type InstallPlan = {
  kind: ConfigKind
  name: string
  marketplace: string
  configPath: string
  // What will run / connect / be fetched, shown before the user confirms.
  details: string[]
  warnings: string[]
  apply: () => Promise<void>
}

export async function resolveConfigPath(baseDir: string, global = false) {
  // Check for existing config files (prefer .jsonc over .json, check .opencode/ subdirectory too)
  const candidates = [path.join(baseDir, "opencode.json"), path.join(baseDir, "opencode.jsonc")]

  if (!global) {
    candidates.push(path.join(baseDir, ".opencode", "opencode.json"), path.join(baseDir, ".opencode", "opencode.jsonc"))
  }

  for (const candidate of candidates) {
    if (await Filesystem.exists(candidate)) {
      return candidate
    }
  }

  // Default to opencode.json if none exist
  return candidates[0]
}

async function readConfig(configPath: string) {
  if (!(await Filesystem.exists(configPath))) return { text: "{}", parsed: {} as Record<string, any> }
  const text = await Filesystem.readText(configPath)
  return { text, parsed: (parseJsonc(text) ?? {}) as Record<string, any> }
}

// jsonc-parser `modify` preserves the file's comments and formatting around the edit.
async function writeAt(configPath: string, jsonPath: (string | number)[], value: unknown, arrayInsert = false) {
  const { text } = await readConfig(configPath)
  const edits = modify(text, jsonPath, value, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
    isArrayInsertion: arrayInsert,
  })
  await Filesystem.write(configPath, applyEdits(text, edits))
}

// Appends to an array at `key`, creating it if absent, without rewriting the array's existing
// items (and any comments between them).
async function appendAt(configPath: string, key: string[], value: unknown) {
  const { parsed } = await readConfig(configPath)
  const existing = key.reduce<any>((node, part) => node?.[part], parsed)
  if (Array.isArray(existing)) return writeAt(configPath, [...key, existing.length], value, true)
  return writeAt(configPath, key, [value])
}

export async function addMcpToConfig(name: string, mcpConfig: unknown, configPath: string) {
  await writeAt(configPath, ["mcp", name], mcpConfig)
  return configPath
}

async function planMcp(item: Extract<ConfigItem, { kind: "mcp" }>, configPath: string): Promise<InstallPlan> {
  const config = mcpConfigFromEntry(item.entry)
  // Refuse rather than clobber: the write keys on the bare name, so a second marketplace (or a
  // hand-written entry) using the same name would otherwise be silently overwritten. Keyed on the
  // key's PRESENCE, not on it looking like a full server: `{enabled: false}` alone is a valid,
  // deliberately disabled entry, and overwriting it would silently re-enable it.
  const { parsed } = await readConfig(configPath)
  if (parsed.mcp && item.name in parsed.mcp) {
    const existing = parsed.mcp[item.name]
    if (isDeepStrictEqual(existing, config))
      throw new MarketplaceAlreadyInstalled(`MCP server "${item.name}" is already installed in ${configPath}.`)
    const hint = existing?.type === "remote" ? existing.url : existing?.command?.join?.(" ")
    throw new MarketplaceRefusal(
      `MCP server "${item.name}" already exists in ${configPath}${hint ? ` (${hint})` : ""}. Remove or rename it there first.`,
    )
  }
  const headers = config.type === "remote" ? Object.keys(config.headers ?? {}) : []
  const required = config.type === "local" ? Object.keys(config.environment ?? {}) : headers.map(headerEnvName)
  return {
    kind: "mcp",
    name: item.name,
    marketplace: item.marketplace,
    configPath,
    details: [
      config.type === "local" ? `runs: ${config.command.join(" ")}` : `connects to: ${config.url}`,
      ...headers.map((header) => `header ${header} <- $${headerEnvName(header)}`),
    ],
    warnings: unsetVariables(required),
    apply: () => addMcpToConfig(item.name, config, configPath).then(() => {}),
  }
}

// The origin can change what a skill source serves after the user confirms, so the list shown
// here is what it serves NOW -- best effort, and said so when the index can't be read.
async function previewSkills(url: string, dep: FetchDeps) {
  const base = url.endsWith("/") ? url : `${url}/`
  try {
    const index = JSON.parse(await dep.fetchText(new URL("index.json", base).href)) as {
      skills?: { name?: unknown }[]
    }
    const names = (index.skills ?? [])
      .map((skill) => skill.name)
      .filter((name): name is string => typeof name === "string")
    return { names }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function sameUrl(a: string, b: string) {
  const trim = (value: string) => value.replace(/\/+$/, "")
  return trim(a) === trim(b)
}

async function planSkill(
  item: Extract<ConfigItem, { kind: "skill" }>,
  configPath: string,
  dep: FetchDeps,
): Promise<InstallPlan> {
  rejectSubstitution(item.name, [item.entry.url])
  requireHttpUrl(item.name, item.entry.url)
  const { parsed } = await readConfig(configPath)
  const urls: unknown = parsed.skills?.urls
  if (
    Array.isArray(urls) &&
    urls.some((existing) => typeof existing === "string" && sameUrl(existing, item.entry.url))
  ) {
    throw new MarketplaceAlreadyInstalled(`Skill source "${item.entry.url}" is already installed in ${configPath}.`)
  }
  const preview = await previewSkills(item.entry.url, dep)
  const details = [`skill source: ${item.entry.url}`]
  const warnings: string[] = []
  if ("names" in preview) {
    details.push(
      preview.names?.length
        ? `currently serves ${preview.names.length} skill(s): ${preview.names.join(", ")}`
        : "currently serves no skills",
    )
  } else {
    warnings.push(`could not read ${item.entry.url} index.json right now (${preview.error})`)
  }
  details.push("adds every skill the source lists, now and as it changes")
  return {
    kind: "skill",
    name: item.name,
    marketplace: item.marketplace,
    configPath,
    details,
    warnings,
    apply: () => appendAt(configPath, ["skills", "urls"], item.entry.url),
  }
}

const EVENTS: readonly string[] = ConfigHooks.Event.literals

export function hookConfigFromEntry(entry: Marketplace.HookEntry): ConfigHooks.Entry {
  rejectSubstitution(entry.name, [...entry.command, entry.matcher?.tool, entry.matcher?.file])
  // Config silently ignores hooks under an event it doesn't know (XCOD-68), so an unchecked entry
  // would install cleanly and never fire.
  if (!EVENTS.includes(entry.event)) {
    throw new MarketplaceRefusal(
      `Hook "${entry.name}" targets event "${entry.event}", which this version of Lunos does not dispatch. Supported: ${EVENTS.join(", ")}`,
    )
  }
  if (!entry.command.length) throw new MarketplaceRefusal(`Hook "${entry.name}" has an empty command`)
  const environment = envReferences(entry.name, entry.environment)
  const matcher =
    entry.matcher && (entry.matcher.tool || entry.matcher.file)
      ? {
          ...(entry.matcher.tool ? { tool: entry.matcher.tool } : {}),
          ...(entry.matcher.file ? { file: entry.matcher.file } : {}),
        }
      : undefined
  return {
    command: [...entry.command],
    ...(matcher ? { matcher } : {}),
    ...(environment ? { environment } : {}),
    ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
  } as ConfigHooks.Entry
}

async function planHook(item: Extract<ConfigItem, { kind: "hook" }>, configPath: string): Promise<InstallPlan> {
  const config = hookConfigFromEntry(item.entry)
  // Config hooks carry no name, so the duplicate check is on what the hook does: same event,
  // command and matcher would just fire twice.
  const { parsed } = await readConfig(configPath)
  const existing: unknown = parsed.hooks?.[item.entry.event]
  if (
    Array.isArray(existing) &&
    existing.some(
      (hook) => isDeepStrictEqual(hook?.command, config.command) && isDeepStrictEqual(hook?.matcher, config.matcher),
    )
  ) {
    throw new MarketplaceAlreadyInstalled(`This ${item.entry.event} hook is already installed in ${configPath}.`)
  }
  const on = [
    config.matcher?.tool && `tool ${config.matcher.tool}`,
    config.matcher?.file && `file ${config.matcher.file}`,
  ]
    .filter(Boolean)
    .join(", ")
  return {
    kind: "hook",
    name: item.name,
    marketplace: item.marketplace,
    configPath,
    // A hook runs automatically, with no per-run consent, so show everything that decides when
    // and what it runs.
    details: [`on: ${item.entry.event}${on ? ` (${on})` : " (every occurrence)"}`, `runs: ${config.command.join(" ")}`],
    warnings: unsetVariables(Object.keys(config.environment ?? {})),
    apply: () => appendAt(configPath, ["hooks", item.entry.event], config),
  }
}

function unsetVariables(names: string[]) {
  return names
    .filter((name) => !process.env[name])
    .map((name) => `${name} is not set in your environment; the reference is written anyway`)
}

export async function planInstall(
  item: ConfigItem,
  configPath: string,
  dep: FetchDeps = defaultFetchDeps,
): Promise<InstallPlan> {
  switch (item.kind) {
    case "mcp":
      return planMcp(item, configPath)
    case "skill":
      return planSkill(item, configPath, dep)
    case "hook":
      return planHook(item, configPath)
  }
}
