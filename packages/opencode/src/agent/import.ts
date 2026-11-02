export * as AgentImport from "./import"

import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { ConfigMarkdown } from "@opencode-ai/core/config/markdown"
import { fromClaudeCode } from "../config/agent"
import { mcpConfigFromEntry } from "../mcp/discover"
import { addMcpToConfig } from "../marketplace/install"
import { headerEnvName } from "../marketplace/guard"
import { AgentBundle } from "./bundle"
import { AgentFile } from "./file"

/**
 * Importing an agent (XCOD-209): a bundle, or a Claude Code subagent file, becomes a plan the
 * user sees in full before anything is written. Nothing runs at import time, and writing is
 * all-or-nothing. The CLI is the only caller; tests drive `plan` and `apply` directly.
 */

export interface Context {
  /** The resolved config: residency, providers and the MCP servers already configured. */
  config: {
    residency?: { allow?: readonly string[]; endpoints?: Readonly<Record<string, Jurisdiction.Declaration>> }
    provider?: Record<string, { options?: Record<string, unknown> }>
    mcp?: Record<string, unknown>
    agent?: Record<string, unknown>
  }
  /** Where the agent file and skills go, and the config file MCP servers are added to. */
  target: { agents: string; skills: string; config: string }
  /** The config file's MCP servers, read from that file (not the merged config). */
  configMcp: Record<string, unknown>
  /**
   * Every agent and skill name in use here, built-ins included. A configured agent with a built-in
   * name (`build`, `plan`, `compaction`, `title`, …) is merged over that built-in, so a bundle named
   * `build` would replace the default agent's prompt and one named `title` would run on every session.
   */
  existing: { agents: readonly string[]; skills: readonly string[] }
  env: Record<string, string | undefined>
  trust: boolean
  rename?: string
}

export interface Plan {
  name: string
  /** What the user is shown, line by line. */
  preview: string[]
  /** Variables the agent's MCP servers need that aren't set here. */
  unset: string[]
  apply: () => Promise<string[]>
}

const MAPPED_CLAUDE = new Set(["name", "description", "tools", "model", "color"])

/** A Claude Code subagent file as a bundle, with a report of what mapped and what didn't. */
export async function fromClaudeFile(
  file: string,
): Promise<{ bundle: AgentBundle.Bundle; mapped: string[]; unmapped: string[] }> {
  // YAML front matter only (XCOD-208): never another front-matter language.
  const md = ConfigMarkdown.parse(await fs.readFile(file, "utf8"))
  const data = md.data as Record<string, unknown>
  if (typeof data.name !== "string" || typeof data.description !== "string")
    throw new AgentBundle.Refusal(
      `${file} isn't a Claude Code subagent file (no name and description in its front matter)`,
    )
  const converted = fromClaudeCode(data)
  const mapped: string[] = []
  const unmapped: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (!MAPPED_CLAUDE.has(key)) unmapped.push(key)
    else if ((key === "model" || key === "color") && converted[key] === undefined)
      unmapped.push(`${key} (${JSON.stringify(value)}: no Lunos equivalent, left unset)`)
    else mapped.push(key)
  }
  const raw: Record<string, unknown> = { description: data.description, prompt: md.content.trim() }
  if (typeof converted.model === "string") raw.model = converted.model
  if (typeof converted.color === "string") raw.color = converted.color
  if (converted.tools) {
    // `tools` is deprecated in Lunos; carry it as the permission it means. Claude Code's MCP tool
    // names (`mcp__server__tool`) don't exist in Lunos, so they're reported instead of kept.
    const permission: Record<string, string> = {}
    for (const [tool, enabled] of Object.entries(converted.tools as Record<string, boolean>)) {
      if (tool.startsWith("mcp__")) {
        unmapped.push(`tools: ${tool} (Claude Code MCP tool name; Lunos names MCP tools <server>_<tool>)`)
        continue
      }
      permission[tool === "write" || tool === "patch" ? "edit" : tool] = enabled ? "allow" : "deny"
    }
    raw.permission = permission
  }
  const agent = AgentBundle.parseAgent(new TextEncoder().encode(JSON.stringify(raw)))
  const name = AgentBundle.checkName(data.name)
  return {
    bundle: { manifest: { format: AgentBundle.FORMAT, name, mcp: [], skills: [], files: {} }, agent, skills: {} },
    mapped,
    unmapped,
  }
}

/** Where the agent's model runs, and whether the residency policy allows it. */
export function residency(model: unknown, config: Context["config"]) {
  if (typeof model !== "string" || !model.includes("/")) return { ok: true, line: "model: inherits the default model" }
  const provider = model.split("/")[0]
  const baseURL = config.provider?.[provider]?.options?.baseURL
  const { claim } = Jurisdiction.resolve(
    provider,
    typeof baseURL === "string" ? baseURL : undefined,
    config.residency?.endpoints,
  )
  const allow = config.residency?.allow
  const ok = !allow || allow.includes(claim.region)
  const line = `model: ${model} (provider ${provider}, region ${claim.region}${claim.basis ? `, ${claim.basis}` : ""})`
  return { ok, line, region: claim.region, provider }
}

export async function plan(bundle: AgentBundle.Bundle, ctx: Context): Promise<Plan> {
  const name = AgentBundle.checkName(ctx.rename ?? bundle.manifest.name)
  const agent = { ...bundle.agent }
  const preview: string[] = [`agent: ${name}${ctx.rename ? ` (bundled as ${bundle.manifest.name})` : ""}`]
  if (typeof agent.description === "string") preview.push(`  ${agent.description}`)
  preview.push(
    `mode: ${typeof agent.mode === "string" ? agent.mode : "all"}${agent.hidden === true ? ", hidden from the @ menu (other agents can still start it)" : ""}`,
  )

  // Residency: refused, not warned. An EU-only policy is a hard rule.
  const where = residency(agent.model, ctx.config)
  if (!where.ok)
    throw new AgentBundle.Refusal(
      `${name} uses ${String(agent.model)}, which runs in region "${where.region}". Your residency policy allows only ${ctx.config.residency!.allow!.join(", ")}. Change the agent's model (or declare the endpoint in residency.endpoints), then import it.`,
    )
  preview.push(where.line)

  // Trust: an imported agent asks before bash, edits and subagents, unless the user trusts it.
  if (ctx.trust) {
    preview.push("permissions: as bundled (--trust)")
  } else {
    const { permission, changed } = AgentBundle.untrusted(agent.permission)
    agent.permission = permission
    if (changed.length)
      preview.push(`permissions: ${changed.join(", ")} changed from allow to ask (use --trust to keep allow)`)
  }
  preview.push(`  ${JSON.stringify(agent.permission ?? {})}`)
  if (agent.options && Object.keys(agent.options as object).length)
    preview.push(`options passed to the model: ${JSON.stringify(agent.options)}`)
  if (typeof agent.steps === "number") preview.push(`step limit: ${agent.steps}`)

  // Conflicts are refused rather than overwritten.
  const agentFile = path.join(ctx.target.agents, `${name}.md`)
  if (ctx.existing.agents.includes(name) || ctx.config.agent?.[name] !== undefined || (await exists(agentFile)))
    throw new AgentBundle.Refusal(`An agent named "${name}" already exists. Import it under another name with --name.`)

  // MCP servers: global, so the preview says they run for every agent.
  const mcp: { name: string; config: ReturnType<typeof mcpConfigFromEntry> }[] = []
  const required: string[] = []
  for (const entry of bundle.manifest.mcp) {
    const config = mcpConfigFromEntry(entry)
    const existing = ctx.configMcp[entry.name] ?? ctx.config.mcp?.[entry.name]
    // The same server (type and command or URL) is kept as configured here, credentials included.
    // A different server under the same name is refused rather than overwritten.
    if (existing !== undefined && !sameServer(existing, config))
      throw new AgentBundle.Refusal(
        `An MCP server named "${entry.name}" is already configured as a different server. Rename or remove it first.`,
      )
    const needs =
      config.type === "local"
        ? Object.keys(config.environment ?? {})
        : Object.keys(config.headers ?? {}).map(headerEnvName)
    if (!existing) required.push(...needs)
    preview.push(
      `MCP server ${entry.name}${existing ? " (already configured here, kept as is)" : ""}: ${config.type === "local" ? `runs ${config.command.join(" ")}` : `connects to ${config.url}`}${needs.length ? `; needs ${needs.map((v) => `$${v}`).join(", ")}` : ""}`,
    )
    if (!existing) mcp.push({ name: entry.name, config })
  }
  if (bundle.manifest.mcp.length)
    preview.push("  MCP servers are added to your config and start for every agent and session, not only this one.")

  // Skills: new folders only.
  const skillWrites: { target: string; bytes: Uint8Array }[] = []
  for (const [skill, files] of Object.entries(bundle.skills)) {
    if (ctx.existing.skills.includes(skill) || (await exists(path.join(ctx.target.skills, skill))))
      throw new AgentBundle.Refusal(`A skill named "${skill}" already exists here. Remove or rename it first.`)
    // The skill's own name is what Lunos loads it by; it must be the name the preview shows.
    const declared = ConfigMarkdown.parseOption(new TextDecoder().decode(files["SKILL.md"]))?.data?.name
    if (declared !== skill)
      throw new AgentBundle.Refusal(`Skill "${skill}" in the bundle calls itself "${String(declared)}" in its SKILL.md`)

    const targets = AgentBundle.skillTargets(ctx.target.skills, skill, files)
    Object.values(files).forEach((bytes, index) => skillWrites.push({ target: targets[index], bytes }))
    preview.push(`skill ${skill}: ${Object.keys(files).length} file(s)`)
  }

  const unset = [...new Set(required)].filter((variable) => !ctx.env[variable])
  preview.push(`writes: ${agentFile}`)
  if (mcp.length) preview.push(`writes: ${ctx.target.config} (mcp: ${mcp.map((item) => item.name).join(", ")})`)
  if (skillWrites.length) preview.push(`writes: ${ctx.target.skills}/${Object.keys(bundle.skills).join(", ")}`)
  if (unset.length)
    preview.push(`not set here: ${unset.map((v) => `$${v}`).join(", ")} (set them before using the agent)`)

  const content = AgentFile.render(agent)

  return {
    name,
    preview,
    unset,
    apply: async () => {
      // All or nothing: create every file, then the config edit; undo what was created on failure.
      const created: string[] = []
      // Folders this import created (mkdir returns the first one it made), removed on failure.
      const dirs: string[] = []
      const mkdir = async (dir: string) => {
        const first = await fs.mkdir(dir, { recursive: true })
        if (first) dirs.push(first)
      }
      const configBefore = await fs.readFile(ctx.target.config, "utf8").catch(() => undefined)
      try {
        for (const item of skillWrites) {
          await mkdir(path.dirname(item.target))
          await fs.writeFile(item.target, item.bytes, { flag: "wx" })
          created.push(item.target)
        }
        await mkdir(ctx.target.agents)
        await fs.writeFile(agentFile, content, { flag: "wx" })
        created.push(agentFile)
        for (const item of mcp) await addMcpToConfig(item.name, item.config, ctx.target.config)
        return created
      } catch (error) {
        for (const file of created.reverse()) await fs.rm(file, { force: true })
        for (const skill of Object.keys(bundle.skills))
          await fs.rm(path.join(ctx.target.skills, skill), { recursive: true, force: true })
        for (const dir of dirs.reverse()) await fs.rm(dir, { recursive: true, force: true })
        if (configBefore === undefined) await fs.rm(ctx.target.config, { force: true })
        else await fs.writeFile(ctx.target.config, configBefore)
        throw error
      }
    },
  }
}

function sameServer(existing: unknown, incoming: ReturnType<typeof mcpConfigFromEntry>) {
  if (!existing || typeof existing !== "object") return false
  const server = existing as { type?: string; command?: unknown; url?: unknown }
  if (server.type !== incoming.type) return false
  return incoming.type === "local" ? isDeepStrictEqual(server.command, incoming.command) : server.url === incoming.url
}

async function exists(file: string) {
  return fs.stat(file).then(
    () => true,
    () => false,
  )
}
