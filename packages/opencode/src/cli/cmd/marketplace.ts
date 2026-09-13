import { intro, log, outro, spinner } from "@clack/prompts"
import { Effect } from "effect"

import { cmd } from "./cmd"
import { ConfigPaths } from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import { patchPluginConfig, type PatchDeps } from "../../plugin/install"
import {
  resolveMarketplaceManifest,
  resolveAddedMarketplaces,
  normalizeSource,
  defaultMarketplaceListDeps,
  FIELD,
  type MarketplaceCtx,
  type MarketplaceListDeps,
} from "../../marketplace/shared"
import { errorMessage } from "../../util/error"
import { Filesystem } from "@/util/filesystem"
import { UI } from "../ui"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"

const identity = (spec: string) => spec

type Spin = {
  start: (msg: string) => void
  stop: (msg: string, code?: number) => void
}

export type MarketplaceDeps = {
  spinner: () => Spin
  log: {
    error: (msg: string) => void
    info: (msg: string) => void
    success: (msg: string) => void
  }
  resolve: (spec: string) => ReturnType<typeof resolveMarketplaceManifest>
  readText: (file: string) => Promise<string>
  write: (file: string, text: string) => Promise<void>
  exists: (file: string) => Promise<boolean>
  files: (dir: string, name: "opencode" | "tui") => string[]
  global: string
}

export type MarketplaceAddInput = {
  source: string
  global?: boolean
}

const defaultMarketplaceDeps: MarketplaceDeps = {
  spinner: () => spinner(),
  log: {
    error: (msg) => log.error(msg),
    info: (msg) => log.info(msg),
    success: (msg) => log.success(msg),
  },
  resolve: (spec) => resolveMarketplaceManifest(spec),
  readText: (file) => Filesystem.readText(file),
  write: async (file, text) => {
    await Filesystem.write(file, text)
  },
  exists: (file) => Filesystem.exists(file),
  files: (dir, name) => ConfigPaths.fileInDirectory(dir, name),
  global: Global.Path.config,
}

export function createMarketplaceAddTask(input: MarketplaceAddInput, dep: MarketplaceDeps = defaultMarketplaceDeps) {
  const source = normalizeSource(input.source)
  const global = Boolean(input.global)

  return async (ctx: MarketplaceCtx) => {
    const resolve = dep.spinner()
    resolve.start("Fetching and validating marketplace manifest...")
    const manifest = await dep.resolve(source).then(
      (item) => ({ ok: true as const, item }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    if (!manifest.ok) {
      resolve.stop("Manifest fetch failed", 1)
      dep.log.error(`Could not add "${source}"`)
      dep.log.error(errorMessage(manifest.error))
      return false
    }
    resolve.stop(`Validated "${manifest.item.name}" (${manifest.item.plugins.length} plugin(s))`)

    const patchDeps: PatchDeps = {
      readText: dep.readText,
      write: dep.write,
      exists: dep.exists,
      files: dep.files,
    }

    const patch = dep.spinner()
    patch.start("Updating marketplace config...")
    const out = await patchPluginConfig(
      {
        spec: source,
        targets: [{ kind: "server" }],
        global,
        vcs: ctx.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
        config: dep.global,
        field: FIELD,
        identity,
      },
      patchDeps,
    )
    if (!out.ok) {
      if (out.code === "invalid_json") {
        patch.stop("Failed updating config", 1)
        dep.log.error(`Invalid JSON in ${out.file} (${out.parse} at line ${out.line}, column ${out.col})`)
        dep.log.info("Fix the config file and run the command again.")
        return false
      }

      patch.stop("Failed updating marketplace config", 1)
      dep.log.error(errorMessage(out.error))
      return false
    }
    patch.stop("Marketplace config updated")

    const item = out.items[0]
    if (item.mode === "noop") {
      dep.log.info(`Already added in ${item.file}`)
    } else {
      dep.log.info(`Added to ${item.file}`)
    }

    dep.log.success(`Added marketplace "${manifest.item.name}"`)
    dep.log.info(global ? `Scope: global (${out.dir})` : `Scope: local (${out.dir})`)
    return true
  }
}

export type MarketplaceListEntry = {
  scope: "local" | "global"
  source: string
  name?: string
  plugins?: number
  error?: string
}

export async function listMarketplaces(
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<MarketplaceListEntry[]> {
  const resolved = await resolveAddedMarketplaces(ctx, dep)
  return resolved.map((entry) =>
    entry.ok
      ? { scope: entry.scope, source: entry.source, name: entry.manifest.name, plugins: entry.manifest.plugins.length }
      : { scope: entry.scope, source: entry.source, error: entry.error },
  )
}

export const MarketplaceAddCommand = effectCmd({
  command: "add <source>",
  describe: "add a marketplace source and update config",
  builder: (yargs) =>
    yargs
      .positional("source", {
        type: "string",
        describe: "owner/repo, manifest URL, or local path",
      })
      .option("global", {
        alias: ["g"],
        type: "boolean",
        default: false,
        describe: "add in global config",
      }),
  handler: Effect.fn("Cli.marketplace.add")(function* (args) {
    const source = String(args.source ?? "").trim()
    if (!source) {
      UI.error("source is required")
      process.exitCode = 1
      return
    }

    UI.empty()
    intro(`Add marketplace ${source}`)

    const run = createMarketplaceAddTask({
      source,
      global: Boolean(args.global),
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

export const MarketplaceListCommand = effectCmd({
  command: "list",
  aliases: ["ls"],
  describe: "list added marketplace sources",
  handler: Effect.fn("Cli.marketplace.list")(function* () {
    UI.empty()
    intro("Marketplaces")

    const ctx = yield* InstanceRef
    if (!ctx) return
    const entries = yield* Effect.promise(() =>
      listMarketplaces({
        vcs: ctx.project.vcs,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }),
    )

    if (!entries.length) {
      log.warn("No marketplaces added")
      outro("Add one with: lunos marketplace add <owner/repo | url | path>")
      return
    }

    for (const entry of entries) {
      const label = entry.name ? `${entry.name} (${entry.source})` : entry.source
      const detail = entry.error ? `unreachable: ${entry.error}` : `${entry.plugins} plugin(s)`
      log.info(`[${entry.scope}] ${label} ${UI.Style.TEXT_DIM}${detail}`)
    }

    outro(`${entries.length} marketplace(s)`)
  }),
})

export const MarketplaceCommand = cmd({
  command: "marketplace",
  describe: "manage plugin marketplace sources",
  builder: (yargs) => yargs.command(MarketplaceAddCommand).command(MarketplaceListCommand).demandCommand(),
  async handler() {},
})
