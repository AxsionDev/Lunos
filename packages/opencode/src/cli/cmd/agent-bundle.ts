import fs from "node:fs/promises"
import path from "node:path"
import * as prompts from "@clack/prompts"
import { Effect } from "effect"
import type { Argv } from "yargs"
import { parse as parseJsonc } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { ConfigPolicy } from "@/config/policy"
import { InstanceRef } from "@/effect/instance-ref"
import { sanitize } from "@/mcp/catalog"
import { resolveConfigPath } from "@/marketplace/install"
import { AgentBundle } from "@/agent/bundle"
import { AgentImport } from "@/agent/import"

// XCOD-209: `lunos agent export` and `lunos agent import`. The format, its checks and the import
// plan live in src/agent/bundle.ts and src/agent/import.ts; this file only reads config and files,
// shows the plan and asks.

const MAX_DOWNLOAD = AgentBundle.LIMITS.bytes

/** Every file under a skill's folder, as paths relative to it. */
async function skillFiles(dir: string) {
  const files: Record<string, Uint8Array> = {}
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) {
      if (entry.isSymbolicLink()) throw new AgentBundle.Refusal(`Skill folder ${dir} contains a symbolic link`)
      continue
    }
    const full = path.join(entry.parentPath, entry.name)
    files[path.relative(dir, full).split(path.sep).join("/")] = new Uint8Array(await fs.readFile(full))
    if (Object.keys(files).length > AgentBundle.LIMITS.files)
      throw new AgentBundle.Refusal(`Skill folder ${dir} has more than ${AgentBundle.LIMITS.files} files`)
  }
  return files
}

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

export const AgentExportCommand = effectCmd({
  command: "export <name>",
  describe: "export an agent, with the MCP servers and skills it uses, as a bundle to share",
  builder: (yargs: Argv) =>
    yargs
      .positional("name", { type: "string", demandOption: true, describe: "agent to export" })
      .option("output", {
        alias: ["o"],
        type: "string",
        describe: `file to write (default: <name>${AgentBundle.EXTENSION})`,
      })
      .option("mcp", {
        type: "string",
        describe: "comma-separated MCP servers to include, besides those the agent's permissions name",
      })
      .option("skill", {
        type: "string",
        describe: "comma-separated skills to include, besides those the agent's permissions name",
      })
      .option("force", { type: "boolean", default: false, describe: "overwrite the output file" }),
  handler: Effect.fn("Cli.agent.export")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { Skill } = yield* Effect.promise(() => import("@/skill"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const name = String(args.name)
    const agent = config.agent?.[name]
    if (!agent) return yield* fail(`No agent named "${name}" in this project's config. See \`lunos agent list\`.`)

    // MCP servers: the ones named on the command line, and any whose tools the agent's
    // permissions name (`<server>_<tool>`).
    const keys = Object.keys((agent.permission as Record<string, unknown>) ?? {})
    const servers = new Set(list(args.mcp))
    for (const server of Object.keys(config.mcp ?? {}))
      if (keys.some((key) => key.startsWith(`${sanitize(server)}_`))) servers.add(server)
    const mcp: Record<string, any> = {}
    for (const server of servers) {
      const entry = config.mcp?.[server]
      if (!entry || !("type" in entry)) return yield* fail(`No MCP server named "${server}" is configured`)
      mcp[server] = entry
    }

    // Skills: the ones named on the command line, and any the agent's `skill` permission allows by
    // name. Built-in skills ship with Lunos, so they're left out (named explicitly, it's an error).
    const skillRule = (agent.permission as Record<string, unknown> | undefined)?.skill
    const explicit = new Set(list(args.skill))
    const wanted = new Set(explicit)
    if (skillRule && typeof skillRule === "object")
      for (const [skill, action] of Object.entries(skillRule))
        if (action === "allow" && !skill.includes("*")) wanted.add(skill)
    const skills: Record<string, Record<string, Uint8Array>> = {}
    const skipped: string[] = []
    for (const skill of wanted) {
      const info = yield* Skill.Service.use((svc) => svc.get(skill))
      if (!info || info.location === "<built-in>") {
        if (explicit.has(skill))
          return yield* fail(`Skill "${skill}" isn't a local skill folder, so it can't be bundled`)
        skipped.push(skill)
        continue
      }
      skills[skill] = yield* Effect.promise(() => skillFiles(path.dirname(info.location)))
    }

    const output = path.resolve(args.output ?? `${name}${AgentBundle.EXTENSION}`)
    const result = yield* Effect.promise(async () => {
      if (
        !args.force &&
        (await fs.stat(output).then(
          () => true,
          () => false,
        ))
      )
        throw new AgentBundle.Refusal(`${output} already exists (use --force to overwrite)`)
      const bytes = await AgentBundle.write({ name, agent, mcp, skills, lunos: InstallationVersion })
      await fs.writeFile(output, bytes)
      return bytes.byteLength
    }).pipe(
      Effect.catchDefect((error) => (error instanceof AgentBundle.Refusal ? fail(error.message) : Effect.die(error))),
    )
    UI.println(`Exported ${name} to ${output} (${result} bytes)`)
    if (servers.size)
      UI.println(`  MCP servers: ${[...servers].join(", ")} (environment and header names only, never values)`)
    if (Object.keys(skills).length) UI.println(`  skills: ${Object.keys(skills).join(", ")}`)
    if (skipped.length) UI.println(`  not bundled (built in, or not found): ${skipped.join(", ")}`)
  }),
})

/** Downloads a bundle over https only (every redirect too), stopping past the size limit. */
async function download(source: string) {
  let url = source
  for (let hop = 0; hop < 5; hop++) {
    if (!url.startsWith("https://")) throw new AgentBundle.Refusal("Bundles are only downloaded over https")
    const response = await fetch(url, { redirect: "manual" })
    const location = response.headers.get("location")
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url).href
      continue
    }
    if (!response.ok || !response.body)
      throw new AgentBundle.Refusal(`Couldn't download ${source}: HTTP ${response.status}`)
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_DOWNLOAD) {
        await reader.cancel()
        throw new AgentBundle.Refusal(`${source} is larger than ${MAX_DOWNLOAD} bytes`)
      }
      chunks.push(value)
    }
    return new Uint8Array(Buffer.concat(chunks))
  }
  throw new AgentBundle.Refusal(`${source} redirects too many times`)
}

async function load(source: string) {
  if (/^https?:\/\//i.test(source)) return { bundle: await AgentBundle.read(await download(source)) }
  if (source.endsWith(".md")) return AgentImport.fromClaudeFile(path.resolve(source))
  return { bundle: await AgentBundle.read(new Uint8Array(await fs.readFile(path.resolve(source)))) }
}

export const AgentImportCommand = effectCmd({
  command: "import <source>",
  describe: "import an agent from a bundle (file or https URL) or a Claude Code subagent file (.md)",
  builder: (yargs: Argv) =>
    yargs
      .positional("source", {
        type: "string",
        demandOption: true,
        describe: "bundle file, https URL, or .claude/agents/*.md",
      })
      .option("name", { type: "string", describe: "import under this name" })
      .option("project", {
        type: "boolean",
        default: false,
        describe: "add to this project (.opencode/) instead of your global config",
      })
      .option("trust", {
        type: "boolean",
        default: false,
        describe: "keep the bundle's allow on bash, edit and task (otherwise they become ask)",
      })
      .option("dry-run", { type: "boolean", default: false, describe: "show what would be imported, write nothing" })
      .option("yes", { alias: ["y"], type: "boolean", default: false, describe: "import without asking" }),
  handler: Effect.fn("Cli.agent.import")(function* (args) {
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const ctx = yield* InstanceRef
    if (!ctx) return yield* Effect.die("InstanceRef not provided")
    const { Agent } = yield* Effect.promise(() => import("../../agent/agent"))
    const { Skill } = yield* Effect.promise(() => import("@/skill"))
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const existing = {
      agents: (yield* Agent.Service.use((svc) => svc.list())).map((agent) => agent.name),
      skills: (yield* Skill.Service.use((svc) => svc.all())).map((skill) => skill.name),
    }

    // Organisation policy: `agent_import: false`, refused (and audited when it's locked).
    if (config.agent_import === false) {
      if (ConfigPolicy.isLocked(config.$locked, "agent_import"))
        yield* ConfigPolicy.refused("agent_import", `agent import ${args.source}`)
      return yield* fail(
        "Importing agents is turned off (agent_import is false in your config or your organisation's policy)",
      )
    }

    const base = args.project ? path.join(ctx.worktree, ".opencode") : Global.Path.config
    const target = {
      agents: path.join(base, "agents"),
      skills: path.join(base, "skills"),
      config: yield* Effect.promise(() =>
        resolveConfigPath(args.project ? ctx.worktree : Global.Path.config, !args.project),
      ),
    }

    const outcome = yield* Effect.promise(async () => {
      const loaded = await load(String(args.source))
      const text = await fs.readFile(target.config, "utf8").catch(() => "{}")
      const plan = await AgentImport.plan(loaded.bundle, {
        config: config as AgentImport.Context["config"],
        target,
        configMcp: ((parseJsonc(text) ?? {}) as { mcp?: Record<string, unknown> }).mcp ?? {},
        env: process.env,
        existing,
        trust: Boolean(args.trust),
        rename: args.name,
      })
      return { plan, report: "mapped" in loaded ? loaded : undefined }
    }).pipe(
      Effect.catchDefect((error) => (error instanceof AgentBundle.Refusal ? fail(error.message) : Effect.die(error))),
    )

    UI.println("Import preview:")
    for (const line of outcome.plan.preview) UI.println(`  ${line}`)
    if (outcome.report) {
      UI.println(`  Claude Code fields mapped: ${outcome.report.mapped.join(", ") || "none"}`)
      if (outcome.report.unmapped.length)
        UI.println(`  Claude Code fields not mapped: ${outcome.report.unmapped.join("; ")}`)
    }
    UI.println("  Nothing in the agent runs at import time.")
    if (args["dry-run"]) return

    if (!args.yes) {
      if (!process.stdin.isTTY)
        return yield* fail("Run with --yes to import without a prompt, or --dry-run to only preview")
      const ok = yield* Effect.promise(() => prompts.confirm({ message: `Import ${outcome.plan.name}?` }))
      if (ok !== true) {
        UI.println("Cancelled; nothing was written.")
        return
      }
    }
    const written = yield* Effect.promise(() => outcome.plan.apply())
    UI.println(`Imported ${outcome.plan.name}:`)
    for (const file of written) UI.println(`  ${file}`)
  }),
})
