import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect } from "effect"

import { ConfigPaths } from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import type { Marketplace } from "@opencode-ai/core/marketplace"
import { installPlugin, patchPluginConfig, readPluginManifest } from "../../plugin/install"
import { resolvePluginTarget } from "../../plugin/shared"
import { errorMessage } from "../../util/error"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import {
  resolveAddedMarketplaces,
  defaultMarketplaceListDeps,
  type MarketplaceCtx,
  type MarketplaceListDeps,
} from "./marketplace"

type Spin = {
  start: (msg: string) => void
  stop: (msg: string, code?: number) => void
}

export type PlugDeps = {
  spinner: () => Spin
  log: {
    error: (msg: string) => void
    info: (msg: string) => void
    success: (msg: string) => void
  }
  resolve: (spec: string) => Promise<string>
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "opencode" | "tui") => string[]
  global: string
}

export type PlugInput = {
  mod: string
  global?: boolean
  force?: boolean
}

export type PlugCtx = {
  vcs?: string
  worktree: string
  directory: string
}

const defaultPlugDeps: PlugDeps = {
  spinner: () => spinner(),
  log: {
    error: (msg) => log.error(msg),
    info: (msg) => log.info(msg),
    success: (msg) => log.success(msg),
  },
  resolve: (spec) => resolvePluginTarget(spec),
  readText: (file) => Filesystem.readText(file),
  write: async (file, text) => {
    await Filesystem.write(file, text)
  },
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
  global: Global.Path.config,
}

function cause(err: unknown) {
  if (!err || typeof err !== "object") return
  if (!("cause" in err)) return
  return (err as { cause?: unknown }).cause
}

export function createPlugTask(input: PlugInput, dep: PlugDeps = defaultPlugDeps) {
  const mod = input.mod
  const force = Boolean(input.force)
  const global = Boolean(input.global)

  return async (ctx: PlugCtx) => {
    const install = dep.spinner()
    install.start("Installing plugin package...")
    const target = await installPlugin(mod, dep)
    if (!target.ok) {
      install.stop("Install failed", 1)
      dep.log.error(`Could not install "${mod}"`)
      const hit = cause(target.error) ?? target.error
      if (hit instanceof Process.RunFailedError) {
        const lines = hit.stderr
          .toString()
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        const errs = lines.filter((line) => line.startsWith("error:")).map((line) => line.replace(/^error:\s*/, ""))
        const detail = errs[0] ?? lines.at(-1)
        if (detail) dep.log.error(detail)
        if (lines.some((line) => line.includes("No version matching"))) {
          dep.log.info("This package depends on a version that is not available in your npm registry.")
          dep.log.info("Check npm registry/auth settings and try again.")
        }
      }
      if (!(hit instanceof Process.RunFailedError)) {
        dep.log.error(errorMessage(hit))
      }
      return false
    }
    install.stop("Plugin package ready")

    const inspect = dep.spinner()
    inspect.start("Reading plugin manifest...")
    const manifest = await readPluginManifest(target.target)
    if (!manifest.ok) {
      if (manifest.code === "manifest_read_failed") {
        inspect.stop("Manifest read failed", 1)
        dep.log.error(`Installed "${mod}" but failed to read ${manifest.file}`)
        dep.log.error(errorMessage(cause(manifest.error) ?? manifest.error))
        return false
      }

      if (manifest.code === "manifest_no_targets") {
        inspect.stop("No plugin targets found", 1)
        dep.log.error(`"${mod}" does not expose plugin entrypoints in package.json`)
        dep.log.info(
          'Expected one of: exports["./tui"], exports["./server"], package.json main for server, or package.json["oc-themes"] for tui themes.',
        )
        return false
      }

      inspect.stop("Manifest read failed", 1)
      return false
    }

    inspect.stop(
      `Detected ${manifest.targets.map((item) => item.kind).join(" + ")} target${manifest.targets.length === 1 ? "" : "s"}`,
    )

    const patch = dep.spinner()
    patch.start("Updating plugin config...")
    const out = await patchPluginConfig(
      {
        spec: mod,
        targets: manifest.targets,
        force,
        global,
        vcs: ctx.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
        config: dep.global,
      },
      dep,
    )
    if (!out.ok) {
      if (out.code === "invalid_json") {
        patch.stop(`Failed updating ${out.kind} config`, 1)
        dep.log.error(`Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`)
        dep.log.info("Fix the config file and run the command again.")
        return false
      }

      patch.stop("Failed updating plugin config", 1)
      dep.log.error(errorMessage(out.error))
      return false
    }
    patch.stop("Plugin config updated")
    for (const item of out.items) {
      if (item.mode === "noop") {
        dep.log.info(`Already configured in ${item.file}`)
        continue
      }
      if (item.mode === "replace") {
        dep.log.info(`Replaced in ${item.file}`)
        continue
      }
      dep.log.info(`Added to ${item.file}`)
    }

    dep.log.success(`Installed ${mod}`)
    dep.log.info(global ? `Scope: global (${out.dir})` : `Scope: local (${out.dir})`)
    return true
  }
}

// The concrete spec accepted by the existing `opencode plugin <module>` install command (via
// npm-package-arg / `Npm.add`), so `plugin list`/`plugin search` output is a direct copy-paste
// away from installing, per XCOD-11's two-command flow requirement.
export function pluginInstallSpec(source: Marketplace.Source): string {
  if (source.type === "npm") return source.version ? `${source.package}@${source.version}` : source.package
  return source.ref ? `${source.repo}#${source.ref}` : source.repo
}

export type PluginListEntry = {
  name: string
  marketplace: string
  description?: string
  category?: string
  tags?: readonly string[]
  spec: string
}

export type PluginListResult = {
  marketplaceCount: number
  plugins: PluginListEntry[]
}

export async function listPlugins(
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<PluginListResult> {
  const resolved = await resolveAddedMarketplaces(ctx, dep)
  const plugins: PluginListEntry[] = []
  for (const entry of resolved) {
    if (!entry.ok) continue
    for (const plugin of entry.manifest.plugins) {
      plugins.push({
        name: plugin.name,
        marketplace: entry.manifest.name,
        description: plugin.description,
        category: plugin.category,
        tags: plugin.tags,
        spec: pluginInstallSpec(plugin.source),
      })
    }
  }
  return { marketplaceCount: resolved.length, plugins }
}

export async function searchPlugins(
  query: string,
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<PluginListResult> {
  const { marketplaceCount, plugins } = await listPlugins(ctx, dep)
  const needle = query.trim().toLowerCase()
  const matches = plugins.filter((item) => {
    const haystack = [item.name, item.description ?? "", item.category ?? "", ...(item.tags ?? [])]
    return haystack.some((value) => value.toLowerCase().includes(needle))
  })
  return { marketplaceCount, plugins: matches }
}

function printPlugins(plugins: PluginListEntry[]) {
  for (const plugin of plugins) {
    log.info(`${plugin.name} ${UI.Style.TEXT_DIM}(${plugin.marketplace})`)
    if (plugin.description) log.info(`  ${plugin.description}`)
    log.info(`  ${UI.Style.TEXT_DIM}opencode plugin ${plugin.spec}`)
  }
}

export const PluginInstallCommand = effectCmd({
  command: "$0 <module>",
  describe: "install plugin and update config",
  builder: (yargs) =>
    yargs
      .positional("module", {
        type: "string",
        describe: "npm module name",
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: "install in global config",
      })
      .option("force", {
        alias: ["f"],
        type: "boolean",
        default: false,
        describe: "replace existing plugin version",
      }),
  handler: Effect.fn("Cli.plug")(function* (args) {
    const mod = String(args.module ?? "").trim()
    if (!mod) {
      UI.error("module is required")
      process.exitCode = 1
      return
    }

    UI.empty()
    intro(`Install plugin ${mod}`)

    const run = createPlugTask({
      mod,
      global: Boolean(args.global),
      force: Boolean(args.force),
    })

    const ctx = yield* InstanceRef
    if (!ctx) return
    const ok = yield* Effect.promise(() =>
      run({
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    outro("Done")
    if (!ok) process.exitCode = 1
  }),
})

export const PluginListCommand = effectCmd({
  command: "list",
  describe: "list plugins available across added marketplaces",
  handler: Effect.fn("Cli.plugin.list")(function* () {
    UI.empty()
    intro("Plugins")

    const ctx = yield* InstanceRef
    if (!ctx) return
    const { marketplaceCount, plugins } = yield* Effect.promise(() =>
      listPlugins({ vcs: ctx.project.vcs, worktree: ctx.worktree, directory: ctx.directory }),
    )

    if (!marketplaceCount) {
      log.warn("No marketplaces added")
      outro("Add one with: lunos marketplace add <owner/repo | url | path>")
      return
    }

    if (!plugins.length) {
      log.warn("No plugins found in added marketplaces")
      outro("Done")
      return
    }

    printPlugins(plugins)
    outro(`${plugins.length} plugin(s)`)
  }),
})

export const PluginSearchCommand = effectCmd({
  command: "search <query>",
  describe: "search plugins across added marketplaces",
  builder: (yargs) =>
    yargs.positional("query", {
      type: "string",
      describe: "case-insensitive substring match on name/description/tags/category",
    }),
  handler: Effect.fn("Cli.plugin.search")(function* (args) {
    const query = String(args.query ?? "").trim()

    UI.empty()
    intro(`Search plugins: ${query}`)

    const ctx = yield* InstanceRef
    if (!ctx) return
    const { marketplaceCount, plugins } = yield* Effect.promise(() =>
      searchPlugins(query, { vcs: ctx.project.vcs, worktree: ctx.worktree, directory: ctx.directory }),
    )

    if (!marketplaceCount) {
      log.warn("No marketplaces added")
      outro("Add one with: lunos marketplace add <owner/repo | url | path>")
      return
    }

    if (!plugins.length) {
      log.warn(`No plugins matched "${query}"`)
      outro("Done")
      return
    }

    printPlugins(plugins)
    outro(`${plugins.length} plugin(s) matched`)
  }),
})

export const PluginCommand = effectCmd({
  command: "plugin",
  aliases: ["plug"],
  describe: "manage plugins",
  instance: false,
  builder: (yargs) =>
    yargs.command(PluginInstallCommand).command(PluginListCommand).command(PluginSearchCommand).demandCommand(),
  handler: Effect.fn("Cli.plugin")(function* () {}),
})
