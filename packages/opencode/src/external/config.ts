export * as ExternalConfig from "./config"

import { spawn } from "child_process"
import { existsSync, readdirSync, readFileSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { createInterface } from "readline"
import { ExternalClaude } from "./claude"
import { ExternalCodex } from "./codex"
import { ExternalDetect } from "./detect"

/**
 * XCOD-285 §4: Settings › External sessions › Claude Code / Codex. Each tool's own configuration as
 * the installed tool reports it, never read from its files by Lunos and never kept from memory:
 *
 *   Claude Code (2.1.304, test/fixtures/external/claude-2.1.304/config-view.json): its answers to the
 *   host's `initialize` and the `get_settings` (effective settings and each settings layer),
 *   `get_memory_dialog` (CLAUDE.md files), `mcp_status` (MCP servers with their scope) and
 *   `get_hooks_listing` (hooks with their source) control requests. It's started with
 *   `--settings {"disableAllHooks":true}` and `--no-session-persistence`, so reading runs none of the
 *   user's hooks and saves no session; no prompt is sent, so no model is called.
 *   Codex (0.160.1, test/fixtures/external/codex-0.160.1/config-view.json): `codex app-server`'s
 *   `config/read` with its layers and the layer each value comes from, and an ephemeral `thread/start`
 *   (no turn) for the AGENTS.md files it loads.
 *
 * Where the tool names a layer but not a file (Claude Code's `userSettings`, an MCP server's `user`
 * scope), the file is the one Claude Code documents for it, shown only when it exists. What can't be
 * attributed has no `source`, which the TUI shows as "source unknown". A request an older release
 * doesn't answer hides its section. Secrets are never returned: no settings `env`, MCP arguments,
 * environment or headers, URL queries, or model providers.
 *
 * Changes go only through the tool's own commands (`claude mcp add -s …`, `codex mcp remove …`):
 * `plan` builds the command from checked fields (never from text the client sends as a command line)
 * and names the file the tool says it changes; `run` runs it. Lunos never writes ~/.claude or ~/.codex.
 */

export type Tool = ExternalDetect.Tool

export interface Source {
  /** user, project, local, plugin, managed, …: the tool's own word for the layer, where it has one. */
  scope?: string
  /** The file it lives in, when the tool reports it or documents it for that layer (and it exists). */
  file?: string
  /** How to say where it comes from, e.g. "User settings (~/.claude/settings.json)". */
  label: string
}

export interface Item {
  id: string
  name: string
  value?: string
  detail?: string
  status?: string
  /** Undefined: "source unknown". */
  source?: Source
  /** An existing file to offer to open in the user's editor. */
  open?: string
  /** The tool's own remove command applies, for this scope. */
  remove?: { scope?: string }
}

export interface Section {
  id: string
  title: string
  items: Item[]
  note?: string
  /** The tool's own add command, with the scopes its `--help` lists. */
  add?: { scopes: string[]; url: boolean }
}

export interface View {
  tool: Tool
  label: string
  version?: string
  /** Why nothing could be read (not installed, refused by policy, no answer). */
  error?: string
  sections: Section[]
  /** What reading did that Lunos can't prevent, said once. */
  notes: string[]
}

export interface Change {
  action: "mcp.add" | "mcp.remove"
  name: string
  scope?: string
  /** For mcp.add: a URL, or the command that starts the server (words separated by spaces). */
  target?: string
}

export interface Plan {
  argv: string[]
  /** The command as shown to the user before it runs. */
  command: string
  /** The file the tool says the command changes. */
  file?: string
}

/** A server name the tools take as one plain word. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const SAFE_SCOPE = /^[a-z]+$/
/** A word that's safe on a command line even through a Windows shell. */
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./~-]+$/

/** The home directory the tool itself sees: it runs with Lunos's environment, so its HOME. */
function home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

/** `~/…` for paths under the home directory. */
export function short(file: string, dir = home()) {
  return dir && (file === dir || file.startsWith(dir + path.sep)) ? "~" + file.slice(dir.length) : file
}

const exists = (file: string | undefined) => (file && existsSync(file) ? file : undefined)

/** "https://mcp.example.com/mcp" from a URL that may carry a key in its query. */
export function bareURL(value: string) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}${url.pathname}`
  } catch {
    return "(URL)"
  }
}

/** The executable's own name, never its arguments, which may carry a key. */
function program(command: unknown) {
  return typeof command === "string" ? path.basename(command) : undefined
}

function quote(word: string) {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

// ── Claude Code ────────────────────────────────────────────────────────────────────────────────

/** The settings layers Claude Code names in `get_settings` and `get_hooks_listing`, with their documented files. */
export function claudeLayer(layer: string, cwd: string, dir = home()): Source | undefined {
  const files: Record<string, { scope: string; label: string; file: string }> = {
    userSettings: { scope: "user", label: "User settings", file: path.join(dir, ".claude", "settings.json") },
    projectSettings: {
      scope: "project",
      label: "Project settings",
      file: path.join(cwd, ".claude", "settings.json"),
    },
    localSettings: {
      scope: "local",
      label: "Local project settings",
      file: path.join(cwd, ".claude", "settings.local.json"),
    },
  }
  const known = files[layer]
  if (known) {
    const file = exists(known.file)
    return {
      scope: known.scope,
      label: file ? `${known.label} (${short(file, dir)})` : known.label,
      ...(file ? { file } : {}),
    }
  }
  if (layer === "policySettings") return { scope: "managed", label: "Managed settings (your organisation)" }
  if (layer === "flagSettings") return { scope: "command line", label: "Command-line settings" }
  return undefined
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The layer a setting's effective value comes from: the last of Claude Code's reported layers (it
 * lists them lowest first) holding that same value. Undefined when none does, e.g. one set by an
 * environment variable.
 */
export function claudeSourceOf(
  settings: { effective?: any; sources?: { source: string; settings: any }[] } | undefined,
  pick: (value: any) => unknown,
) {
  const value = pick(settings?.effective ?? {})
  if (value === undefined) return undefined
  const layers = (settings?.sources ?? []).filter((layer) => same(pick(layer.settings ?? {}), value))
  const managed = layers.find((layer) => layer.source === "policySettings")
  return (managed ?? layers.at(-1))?.source
}

/** `name:` from an agent file's frontmatter, or its file name. */
function agentName(file: string) {
  try {
    const text = readFileSync(file, "utf8")
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]
    const name = front && /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(front)?.[1]
    return name || path.basename(file, ".md")
  } catch {
    return path.basename(file, ".md")
  }
}

/** Agent files in the directories Claude Code documents (project first, as it prefers them), read-only. */
export function agentFiles(cwd: string, dir = home()) {
  const found = new Map<string, { file: string; scope: string }>()
  for (const [scope, root] of [
    ["project", path.join(cwd, ".claude", "agents")],
    ["user", path.join(dir, ".claude", "agents")],
  ] as const) {
    let entries: string[] = []
    try {
      entries = readdirSync(root).filter((entry) => entry.endsWith(".md"))
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = path.join(root, entry)
      const name = agentName(file)
      if (!found.has(name)) found.set(name, { file, scope })
    }
  }
  return found
}

/** `(local, user, or project)` after `--scope`, and `(stdio, sse, http)` after `--transport`, in `claude mcp add --help`. */
export function claudeAddHelp(help: string) {
  const list = (text: string | undefined) =>
    (text ?? "")
      .split(/,|\bor\b/)
      .map((word) => word.trim())
      .filter((word) => SAFE_SCOPE.test(word))
  const scopes = list(/--scope <scope>[\s\S]*?\(([^)]*)\)/.exec(help)?.[1])
  const transports = list(/--transport <transport>[\s\S]*?\(([^)]*)\)/.exec(help)?.[1])
  return { scopes, transports }
}

export type ClaudeReplies = Partial<
  Record<"initialize" | "get_settings" | "get_memory_dialog" | "mcp_status" | "get_hooks_listing", any>
>

/** The control requests a configuration read sends, after `initialize`. */
export const CLAUDE_REQUESTS = ["get_settings", "get_memory_dialog", "mcp_status", "get_hooks_listing"] as const

/** Ask Claude Code for its configuration: one process, no prompt, no hooks, no saved session. */
export async function askClaude(options: { executable: string; cwd: string; timeoutMs?: number }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-claude-read-"))
  const settings = path.join(dir, "settings.json")
  await fs.writeFile(settings, JSON.stringify({ disableAllHooks: true }))
  const cmd = ExternalDetect.command(options.executable, [
    ...ExternalClaude.args({}),
    "--no-session-persistence",
    "--settings",
    settings,
  ])
  const child = spawn(cmd.file, cmd.args, {
    cwd: options.cwd,
    shell: cmd.shell,
    env: ExternalDetect.environment(),
    stdio: ["pipe", "pipe", "ignore"],
  })
  const replies: ClaudeReplies = {}
  const wanted = ["initialize", ...CLAUDE_REQUESTS] as const
  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, options.timeoutMs ?? 20_000)
      const finish = () => {
        clearTimeout(timer)
        resolve()
      }
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let raw: any
        try {
          raw = JSON.parse(line)
        } catch {
          return
        }
        if (raw.type !== "control_response") return
        const id = String(raw.response?.request_id ?? "").replace(/^lunos-config-/, "")
        if (!(wanted as readonly string[]).includes(id)) return
        // An error reply (an older release) leaves it out, which hides its section.
        replies[id as keyof ClaudeReplies] = raw.response.subtype === "success" ? (raw.response.response ?? {}) : null
        if (wanted.every((key) => key in replies)) finish()
      })
      child.on("error", finish)
      child.on("close", finish)
      child.stdin?.on("error", () => undefined)
      for (const subtype of wanted)
        child.stdin?.write(
          JSON.stringify({ type: "control_request", request_id: `lunos-config-${subtype}`, request: { subtype } }) +
            "\n",
        )
    })
  } finally {
    child.kill()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
  for (const key of wanted) if (replies[key] === null) delete replies[key]
  return replies
}

/** The view from Claude Code's replies. Pure, so it's tested against the recorded replies. */
export function claudeView(input: {
  replies: ClaudeReplies
  cwd: string
  home?: string
  version?: string
  add?: { scopes: string[]; transports: string[] }
  remove?: boolean
  /** external.claude.permission_mode: the mode Lunos starts Claude Code sessions in. */
  lunosMode?: string
}): Omit<View, "notes"> {
  const dir = input.home ?? home()
  const { replies, cwd } = input
  const sections: Section[] = []
  const init = replies.initialize
  const settings = replies.get_settings
  // Lunos's own `disableAllHooks` for this read isn't the user's setting.
  if (settings?.sources)
    settings.sources = settings.sources
      .map((layer: any) => {
        if (layer.source !== "flagSettings" || !layer.settings) return layer
        const { disableAllHooks: _, ...rest } = layer.settings
        return { ...layer, settings: rest }
      })
      .filter((layer: any) => layer.source !== "flagSettings" || Object.keys(layer.settings ?? {}).length)
  const sourceOf = (pick: (value: any) => unknown) => {
    const layer = claudeSourceOf(settings, pick)
    return layer ? claudeLayer(layer, cwd, dir) : undefined
  }

  if (init || settings) {
    const items: Item[] = []
    const models: any[] = Array.isArray(init?.models) ? init.models : []
    const model = settings?.effective?.model as string | undefined
    const listed = models.find((item) => item?.value === (model ?? "default"))
    if (settings || models.length)
      items.push({
        id: "model",
        name: "Model",
        value: model ?? "default",
        ...(listed?.resolvedModel && listed.resolvedModel !== model ? { detail: `runs ${listed.resolvedModel}` } : {}),
        ...(model
          ? withSource(sourceOf((value) => value.model))
          : { source: { label: "not set: Claude Code's default" } }),
      })
    if (settings) {
      const mode = settings.effective?.permissions?.defaultMode as string | undefined
      items.push({
        id: "permission-mode",
        name: "Permission mode",
        value: mode ?? "default",
        detail: `Lunos starts its Claude Code sessions in ${input.lunosMode || "default"} (external.claude.permission_mode), whatever this says`,
        ...(mode
          ? withSource(sourceOf((value) => value.permissions?.defaultMode))
          : { source: { label: "not set: Claude Code's default" } }),
      })
    }
    if (typeof init?.output_style === "string") {
      const styles = Array.isArray(init.available_output_styles) ? init.available_output_styles : []
      items.push({
        id: "output-style",
        name: "Output style",
        value: init.output_style,
        ...(styles.length ? { detail: `available: ${styles.join(", ")}` } : {}),
        ...(settings?.effective?.outputStyle !== undefined
          ? withSource(sourceOf((value) => value.outputStyle))
          : { source: { label: "not set: Claude Code's default" } }),
      })
    }
    if (items.length) sections.push({ id: "general", title: "Model and permissions", items })
  }

  const files: any[] = Array.isArray(replies.get_memory_dialog?.files) ? replies.get_memory_dialog.files : []
  if (replies.get_memory_dialog)
    sections.push({
      id: "instructions",
      title: "CLAUDE.md files",
      items: files
        .filter((file) => file?.exists === true && typeof file.path === "string")
        .map((file) => ({
          id: `instructions:${file.path}`,
          name: String(file.label ?? "Instructions"),
          value: short(file.path, dir),
          source: {
            ...(typeof file.kind === "string" ? { scope: file.kind } : {}),
            file: file.path,
            label: String(file.description ?? short(file.path, dir)),
          },
          ...(exists(file.path) ? { open: file.path } : {}),
        })),
      ...(files.some((file) => file?.exists === true) ? {} : { note: "Claude Code loads no CLAUDE.md file here" }),
    })

  const servers: any[] = Array.isArray(replies.mcp_status?.mcpServers) ? replies.mcp_status.mcpServers : []
  if (replies.mcp_status) {
    const scopes = input.add?.scopes ?? []
    sections.push({
      id: "mcp",
      title: "MCP servers",
      items: servers
        .filter((server) => typeof server?.name === "string")
        .map((server) => {
          const config = server.config ?? {}
          const source = claudeServerSource(server.scope, server.source, cwd, dir)
          const removable = input.remove && typeof server.scope === "string" && scopes.includes(server.scope)
          return {
            id: `mcp:${server.scope}:${server.name}`,
            name: server.name,
            value:
              typeof config.url === "string"
                ? `${config.type ?? "http"} ${bareURL(config.url)}`
                : [config.type ?? "stdio", program(config.command)].filter(Boolean).join(" "),
            ...(typeof server.status === "string" ? { status: server.status } : {}),
            ...withSource(source),
            ...(removable ? { remove: { scope: server.scope } } : {}),
          }
        }),
      ...(input.add?.scopes.length
        ? { add: { scopes: input.add.scopes, url: input.add.transports.includes("http") } }
        : {}),
    })
  }

  const hooks: any[] = Array.isArray(replies.get_hooks_listing?.hooks) ? replies.get_hooks_listing.hooks : []
  if (replies.get_hooks_listing)
    sections.push({
      id: "hooks",
      title: "Hooks",
      items: hooks.map((hook, index) => {
        const layer = typeof hook.source === "string" ? claudeLayer(hook.source, cwd, dir) : undefined
        const label = typeof hook.sourceLabel === "string" ? hook.sourceLabel : layer?.label
        const source: Source | undefined =
          layer || label
            ? {
                ...(layer?.scope ? { scope: layer.scope } : hook.source === "pluginHook" ? { scope: "plugin" } : {}),
                ...(layer?.file ? { file: layer.file } : {}),
                label: [label, hook.pluginName].filter(Boolean).join(" · "),
              }
            : undefined
        return {
          id: `hook:${index}`,
          name: `${hook.event ?? "hook"}${hook.matcher ? ` (${hook.matcher})` : ""}`,
          // A URL in a hook's command may carry a token: shown without its query.
          value: String(hook.displayText ?? hook.commandText ?? hook.type ?? "").replace(
            /https?:\/\/[^\s"'`]+/g,
            bareURL,
          ),
          ...withSource(source),
        }
      }),
      note: "Claude Code has no command to change hooks: open the settings file it names",
    })

  const agents: any[] = Array.isArray(init?.agents) ? init.agents : []
  if (init && Array.isArray(init.agents)) {
    const found = agentFiles(cwd, dir)
    sections.push({
      id: "agents",
      title: "Agents",
      items: agents
        .filter((agent) => typeof agent?.name === "string")
        .map((agent) => {
          const file = found.get(agent.name)
          return {
            id: `agent:${agent.name}`,
            name: agent.name,
            ...(typeof agent.description === "string" ? { value: agent.description.split("\n")[0] } : {}),
            ...(file
              ? { source: { scope: file.scope, file: file.file, label: short(file.file, dir) }, open: file.file }
              : {}),
          }
        }),
      note: "Claude Code doesn't say where an agent comes from: the file is found in .claude/agents (project) or ~/.claude/agents (user)",
    })
  }

  if (settings?.sources) {
    const items = (settings.sources as any[]).flatMap((layer): Item[] => {
      const source = claudeLayer(layer.source, cwd, dir)
      if (!source?.file) return []
      return [
        {
          id: `file:${layer.source}`,
          name: source.label.replace(/ \(.*\)$/, ""),
          value: short(source.file, dir),
          source,
          open: source.file,
        },
      ]
    })
    if (items.length) sections.push({ id: "files", title: "Settings files", items })
  }

  return {
    tool: "claude",
    label: ExternalDetect.TOOLS.claude.label,
    ...((input.version ?? init?.claude_code_version) ? { version: input.version ?? init.claude_code_version } : {}),
    sections,
  }
}

/** The source, without its file when that file doesn't exist here. */
function existing(source: Source | undefined): Source | undefined {
  if (!source?.file || exists(source.file)) return source
  const { file: _, ...rest } = source
  return rest
}

function withSource(source: Source | undefined) {
  return source ? { source, ...(source.file ? { open: source.file } : {}) } : {}
}

/** Where `claude mcp add -s <scope>` keeps a server, as the command itself reports ("File modified: …"). */
export function claudeScopeFile(scope: string, cwd: string, dir = home()) {
  if (scope === "user" || scope === "local") return path.join(dir, ".claude.json")
  if (scope === "project") return path.join(cwd, ".mcp.json")
  return undefined
}

function claudeServerSource(scope: unknown, source: unknown, cwd: string, dir: string): Source | undefined {
  if (scope === "user" || scope === "local" || scope === "project") {
    const file = exists(claudeScopeFile(scope, cwd, dir))
    const label =
      scope === "local"
        ? "local: this project only"
        : scope === "project"
          ? "project: shared with the repository"
          : "user"
    return { scope, label: file ? `${label} (${short(file, dir)})` : label, ...(file ? { file } : {}) }
  }
  if (source === "plugin") return { scope: "plugin", label: "from a plugin" }
  if (scope === "claudeai") return { scope: "claude.ai", label: "claude.ai connector" }
  if (scope === "enterprise" || scope === "managed") return { scope: "managed", label: "managed by your organisation" }
  return undefined
}

// ── Codex ──────────────────────────────────────────────────────────────────────────────────────

/** A config layer as `config/read` names it (`ConfigLayerSource`). */
export function codexLayer(name: any): Source | undefined {
  if (!name || typeof name.type !== "string") return undefined
  if (name.type === "user")
    return {
      scope: "user",
      file: name.file,
      label: `user${name.profile ? `, profile ${name.profile}` : ""} (${short(name.file)})`,
    }
  if (name.type === "project") {
    const file = path.join(name.dotCodexFolder, "config.toml")
    return { scope: "project", file, label: `project (${short(file)})` }
  }
  if (name.type === "system") return { scope: "system", file: name.file, label: `system (${name.file})` }
  if (name.type === "mdm") return { scope: "managed", label: `managed (MDM ${name.domain})` }
  if (name.type === "enterpriseManaged") return { scope: "managed", label: `managed (${name.name})` }
  if (name.type === "sessionFlags") return { scope: "command line", label: "command-line flags" }
  if (name.type === "packagedDefaults") return { scope: "default", file: name.file, label: "Codex's packaged defaults" }
  return undefined
}

/** The layer a key (or anything under `prefix.`) comes from, by `config/read`'s `origins`. Keys hold dots, so never split. */
export function codexOrigin(origins: Record<string, any> | undefined, key: string) {
  if (!origins) return undefined
  const exact = origins[key]
  if (exact) return codexLayer(exact.name)
  const under = Object.entries(origins).find(([name]) => name.startsWith(key + "."))
  return under ? codexLayer(under[1]?.name) : undefined
}

export type CodexReplies = Partial<Record<"initialize" | "config/read" | "thread/start", any>>

/** Ask Codex's app server for its configuration and the instruction files a thread here loads. No turn. */
export async function askCodex(options: { executable: string; cwd: string; timeoutMs?: number }) {
  const server = ExternalCodex.appServer(options)
  const replies: CodexReplies = {}
  const ask = async () => {
    replies.initialize = await server.initialize()
    const [config, thread] = await Promise.allSettled([
      server.request("config/read", { includeLayers: true, cwd: options.cwd }),
      server.request("thread/start", {
        cwd: options.cwd,
        ephemeral: true,
        sandbox: ExternalCodex.SAFE_SANDBOX,
        approvalPolicy: ExternalCodex.SAFE_APPROVAL,
      }),
    ])
    if (config.status === "fulfilled") replies["config/read"] = config.value
    if (thread.status === "fulfilled") replies["thread/start"] = thread.value
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    ask().catch(() => undefined),
    new Promise((resolve) => (timer = setTimeout(resolve, options.timeoutMs ?? 20_000))),
    server.exited,
  ]).finally(() => {
    clearTimeout(timer)
    server.close()
  })
  return replies
}

const CODEX_SETTINGS = [
  ["model", "Model"],
  ["model_reasoning_effort", "Reasoning effort"],
  ["approval_policy", "Approval policy"],
  ["sandbox_mode", "Sandbox"],
] as const

/** The view from Codex's replies. Pure, so it's tested against the recorded replies. */
export function codexView(input: {
  replies: CodexReplies
  version?: string
  add?: boolean
  remove?: boolean
  /** The sandbox and approval policy Lunos starts Codex threads with. */
  lunos?: { sandbox?: string; approvalPolicy?: string }
}): Omit<View, "notes"> {
  const { replies } = input
  const sections: Section[] = []
  const read = replies["config/read"]
  const config = read?.config ?? {}
  const origins = read?.origins as Record<string, any> | undefined
  const layers: any[] = Array.isArray(read?.layers) ? read.layers : []
  const userLayer = codexLayer(layers.find((layer) => layer?.name?.type === "user")?.name)
  // Codex's home, as initialize reports it, or as the folder of the user config it reads.
  const codexHome =
    typeof replies.initialize?.codexHome === "string"
      ? replies.initialize.codexHome
      : userLayer?.file
        ? path.dirname(userLayer.file)
        : undefined
  const userFile = userLayer?.file ?? (codexHome ? path.join(codexHome, "config.toml") : undefined)

  if (read) {
    const items: Item[] = CODEX_SETTINGS.flatMap(([key, name]): Item[] => {
      const value = config[key]
      const lunos =
        key === "sandbox_mode"
          ? `Lunos starts its Codex threads with sandbox ${input.lunos?.sandbox || ExternalCodex.SAFE_SANDBOX} (external.codex.sandbox), whatever this says`
          : key === "approval_policy"
            ? `Lunos starts its Codex threads with approval policy ${input.lunos?.approvalPolicy || ExternalCodex.SAFE_APPROVAL} (external.codex.approval_policy), whatever this says`
            : undefined
      if (value === null || value === undefined) {
        if (key === "model_reasoning_effort") return []
        return [
          {
            id: key,
            name,
            value: "not set",
            ...(lunos ? { detail: lunos } : {}),
            source: { label: "not set: Codex's default" },
          },
        ]
      }
      const source = codexOrigin(origins, key)
      return [
        {
          id: key,
          name,
          value: typeof value === "string" ? value : JSON.stringify(value),
          ...(lunos ? { detail: lunos } : {}),
          ...withSource(existing(source)),
        },
      ]
    })
    sections.push({ id: "general", title: "Model and permissions", items })
  }

  const thread = replies["thread/start"]
  if (thread && Array.isArray(thread.instructionSources))
    sections.push({
      id: "instructions",
      title: "AGENTS.md files",
      items: (thread.instructionSources as unknown[])
        .filter((file): file is string => typeof file === "string")
        .map((file) => {
          const user = codexHome && (file === codexHome || file.startsWith(codexHome + path.sep))
          return {
            id: `instructions:${file}`,
            name: path.basename(file),
            value: short(file),
            source: { scope: user ? "user" : "project", file, label: user ? "user (Codex home)" : "project" },
            ...(exists(file) ? { open: file } : {}),
          }
        }),
      ...(thread.instructionSources.length ? {} : { note: "Codex loads no AGENTS.md file here" }),
    })

  if (read && config.mcp_servers && typeof config.mcp_servers === "object") {
    const servers = Object.entries(config.mcp_servers as Record<string, any>)
    sections.push({
      id: "mcp",
      title: "MCP servers",
      items: servers.map(([name, server]) => {
        const source = codexOrigin(origins, `mcp_servers.${name}`)
        return {
          id: `mcp:${name}`,
          name,
          value:
            typeof server?.url === "string"
              ? `http ${bareURL(server.url)}`
              : ["stdio", program(server?.command)].filter(Boolean).join(" "),
          ...(server?.enabled === false ? { status: "disabled" } : {}),
          ...withSource(existing(source)),
          // `codex mcp remove` changes the user config only.
          ...(input.remove && source?.scope === "user" && SAFE_NAME.test(name) ? { remove: {} } : {}),
        }
      }),
      ...(input.add && userFile ? { add: { scopes: ["user"], url: true } } : {}),
    })
  }

  if (read && config.profiles && typeof config.profiles === "object") {
    const selected = typeof config.profile === "string" ? config.profile : undefined
    const profileV2 = layers.find((layer) => layer?.name?.type === "user" && layer.name.profile)?.name?.profile
    const items = Object.entries(config.profiles as Record<string, any>).map(([name, profile]) => {
      const set = Object.entries(profile ?? {}).filter(([, value]) => value !== null && value !== undefined)
      const shown = set
        .filter(([key]) => CODEX_SETTINGS.some(([known]) => known === key))
        .map(([key, value]) => `${key} ${value}`)
      const others = set.length - shown.length
      const source = codexOrigin(origins, `profiles.${name}`)
      return {
        id: `profile:${name}`,
        name,
        value: [...shown, others ? `${others} more` : ""].filter(Boolean).join(" · ") || "empty",
        ...(name === selected || name === profileV2 ? { status: "selected" } : {}),
        ...withSource(existing(source)),
      }
    })
    if (profileV2 && !(profileV2 in config.profiles))
      items.unshift({
        id: `profile:${profileV2}`,
        name: profileV2,
        value: "",
        status: "selected",
        ...withSource(existing(userLayer)),
      })
    // Codex reports its [profiles.*] tables and the profile file a --profile run layers on; it doesn't
    // list the other <name>.config.toml files in its home, so the section is hidden when it has none.
    if (items.length)
      sections.push({
        id: "profiles",
        title: "Profiles",
        items,
        note: "As Codex reports them: [profiles.*] in its config, and the profile in use. Codex doesn't list its other profile files (<name>.config.toml)",
      })
  }

  if (layers.length) {
    sections.push({
      id: "files",
      title: "Config files",
      items: layers.flatMap((layer): Item[] => {
        const source = codexLayer(layer.name)
        if (!source) return []
        return [
          {
            id: `file:${JSON.stringify(layer.name)}`,
            name: source.label.replace(/ \(.*\)$/, ""),
            value: source.file ? short(source.file) : source.label,
            ...(layer.disabledReason ? { status: `not in effect: ${layer.disabledReason}` } : {}),
            source,
            ...(exists(source.file) ? { open: source.file } : {}),
          },
        ]
      }),
    })
  }

  return {
    tool: "codex",
    label: ExternalDetect.TOOLS.codex.label,
    ...(input.version ? { version: input.version } : {}),
    sections,
  }
}

// ── Reading and changing ───────────────────────────────────────────────────────────────────────

export const NOTES: Record<Tool, string[]> = {
  claude: [
    "Read by starting Claude Code without a prompt, with hooks off and no saved session. Claude Code itself still updates ~/.claude.json and connects to your MCP servers when it starts.",
  ],
  codex: [
    "Read through codex app-server without a turn. Codex itself still refreshes its caches under its home when it starts.",
  ],
}

/** The view, read from the installed tool at `executable`. */
export async function read(input: {
  tool: Tool
  executable: string
  cwd: string
  version?: string
  lunos?: { permissionMode?: string; sandbox?: string; approvalPolicy?: string }
}): Promise<View> {
  if (input.tool === "claude") {
    const help = await ExternalDetect.run(input.executable, ["--help"])
    const missing = ["--settings", "--no-session-persistence"].filter((flag) => !help.stdout.includes(flag))
    if (missing.length)
      return {
        tool: "claude",
        label: ExternalDetect.TOOLS.claude.label,
        error: `This Claude Code can't be read without running your hooks: its --help doesn't list ${missing.join(", ")}`,
        sections: [],
        notes: [],
      }
    const [replies, addHelp, removeHelp] = await Promise.all([
      askClaude({ executable: input.executable, cwd: input.cwd }),
      ExternalDetect.run(input.executable, ["mcp", "add", "--help"]),
      ExternalDetect.run(input.executable, ["mcp", "remove", "--help"]),
    ])
    if (!Object.keys(replies).length)
      return {
        tool: "claude",
        label: ExternalDetect.TOOLS.claude.label,
        error: "Claude Code didn't answer",
        sections: [],
        notes: [],
      }
    return {
      ...claudeView({
        replies,
        cwd: input.cwd,
        version: input.version,
        add: addHelp.code === 0 ? claudeAddHelp(addHelp.stdout) : undefined,
        remove: removeHelp.code === 0 && /--scope/.test(removeHelp.stdout),
        lunosMode: input.lunos?.permissionMode,
      }),
      notes: NOTES.claude,
    }
  }
  const [replies, help] = await Promise.all([
    askCodex({ executable: input.executable, cwd: input.cwd }),
    ExternalDetect.run(input.executable, ["mcp", "--help"]),
  ])
  if (!replies["config/read"] && !replies["thread/start"])
    return {
      tool: "codex",
      label: ExternalDetect.TOOLS.codex.label,
      error: "Codex didn't answer",
      sections: [],
      notes: [],
    }
  const commands = help.code === 0 ? help.stdout : ""
  return {
    ...codexView({
      replies,
      version: input.version,
      add: /^\s+add\b/m.test(commands),
      remove: /^\s+remove\b/m.test(commands),
      lunos: input.lunos,
    }),
    notes: NOTES.codex,
  }
}

export class InvalidChangeError extends Error {
  override name = "ExternalConfigInvalidChange"
}

/**
 * The tool's own command for a change, and the file it changes. Throws InvalidChangeError for
 * anything that isn't a plain name, a scope the tool lists, or a URL / command of plain words.
 */
export function plan(
  tool: Tool,
  change: Change,
  context: { cwd: string; home?: string; scopes?: string[]; userFile?: string; shell?: boolean },
): Plan {
  const dir = context.home ?? home()
  const name = change.name.trim()
  if (!SAFE_NAME.test(name)) throw new InvalidChangeError(`"${change.name}" isn't a server name the tool accepts here`)
  const target = change.target?.trim() ?? ""
  const url = /^https?:\/\//i.test(target)
  const words = target.split(/\s+/).filter(Boolean)
  if (change.action === "mcp.add") {
    if (!words.length) throw new InvalidChangeError("Give the server's URL, or the command that starts it")
    if (url && words.length > 1) throw new InvalidChangeError("A URL is one word")
    if (url && !URL.canParse(target)) throw new InvalidChangeError(`"${target}" isn't a URL`)
    // Quotes and shell syntax aren't passed on: the words go to the tool as they are.
    const unsafe = words.find((word) => !SAFE_WORD.test(word) && (context.shell || /["'`$\\;|&<>(){}]/.test(word)))
    if (!url && unsafe)
      throw new InvalidChangeError(`"${unsafe}" can't be passed on safely; add this one in a terminal`)
    if (url && context.shell && !SAFE_WORD.test(target))
      throw new InvalidChangeError("This URL can't be passed on safely; add it in a terminal")
  }
  if (tool === "claude") {
    const scope = change.scope ?? ""
    if (!SAFE_SCOPE.test(scope) || !(context.scopes ?? []).includes(scope))
      throw new InvalidChangeError(`"${scope}" isn't a scope this Claude Code lists`)
    const argv =
      change.action === "mcp.remove"
        ? ["mcp", "remove", name, "-s", scope]
        : url
          ? ["mcp", "add", "-s", scope, "--transport", "http", name, target]
          : ["mcp", "add", "-s", scope, name, "--", ...words]
    const file = claudeScopeFile(scope, context.cwd, dir)
    return { argv, command: ["claude", ...argv].map(quote).join(" "), ...(file ? { file } : {}) }
  }
  const argv =
    change.action === "mcp.remove"
      ? ["mcp", "remove", name]
      : url
        ? ["mcp", "add", name, "--url", target]
        : ["mcp", "add", name, "--", ...words]
  return {
    argv,
    command: ["codex", ...argv].map(quote).join(" "),
    ...(context.userFile ? { file: context.userFile } : {}),
  }
}

/** The user config file Codex reports (`config/read`'s user layer), which `codex mcp add` / `remove` change. */
export async function codexUserFile(options: { executable: string; cwd: string }) {
  const server = ExternalCodex.appServer(options)
  let timer: ReturnType<typeof setTimeout> | undefined
  const ask = async () => {
    const init = await server.initialize()
    const read = await server.request("config/read", { includeLayers: true, cwd: options.cwd }).catch(() => undefined)
    const user = (read?.layers ?? []).find((layer: any) => layer?.name?.type === "user")?.name?.file
    if (typeof user === "string") return user
    return typeof init?.codexHome === "string" ? path.join(init.codexHome, "config.toml") : undefined
  }
  return Promise.race([
    ask().catch(() => undefined),
    new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), 15_000))),
    server.exited.then(() => undefined),
  ]).finally(() => {
    clearTimeout(timer)
    server.close()
  })
}

/** Run a planned command with the user's own tool. Its own output says what it did. */
export async function run(executable: string, planned: Plan, cwd: string) {
  const result = await ExternalDetect.run(executable, planned.argv, 60_000, cwd)
  const output = [result.stdout, result.stderr]
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n")
  return { ok: result.code === 0, output: output.slice(0, 2000) }
}
