import { intro, log, outro, spinner } from "@clack/prompts"
import { AuditLog } from "@/audit/log"
import { Effect } from "effect"

import { cmd } from "./cmd"
import { MarketplaceInstallCommand, MarketplaceSearchCommand } from "./marketplace-content"
import { ConfigPaths } from "@/config/paths"
import { Global } from "@opencode-ai/core/global"
import { patchPluginConfig, type PatchDeps } from "../../plugin/install"
import {
  resolveMarketplaceManifest,
  resolveAddedMarketplaces,
  refreshMarketplaceCache,
  cacheMarketplaceManifest,
  normalizeSource,
  sourceKind,
  defaultMarketplaceListDeps,
  defaultMarketplaceCacheDeps,
  FIELD,
  type MarketplaceCacheDeps,
  type MarketplaceCtx,
  type MarketplaceListDeps,
  type MarketplacePolicy,
  allowedSource,
} from "../../marketplace/shared"
import { ConfigPolicy } from "@/config/policy"
import { errorMessage } from "../../util/error"
import { describeContents } from "../../marketplace/content"
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
  cache: MarketplaceCacheDeps
  /** Organisation policy from managed config (XCOD-102). Unset means no policy. */
  policy?: () => Promise<MarketplacePolicy>
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
  cache: defaultMarketplaceCacheDeps,
  policy: defaultMarketplaceListDeps.policy,
}

export function createMarketplaceAddTask(input: MarketplaceAddInput, dep: MarketplaceDeps = defaultMarketplaceDeps) {
  const source = normalizeSource(input.source)
  const global = Boolean(input.global)

  return async (ctx: MarketplaceCtx) => {
    // XCOD-102: refused before anything is fetched or written.
    const policy = await dep.policy?.()
    const lockedKey = ConfigPolicy.isLocked(policy?.locked, FIELD)
      ? FIELD
      : allowedSource(policy, source)
        ? undefined
        : "marketplace_allow"
    if (lockedKey) {
      await Effect.runPromise(ConfigPolicy.refused(lockedKey, `marketplace add ${source}`))
      AuditLog.emit("marketplace.refused", { source, key: lockedKey, reason: ConfigPolicy.message(lockedKey) })
      dep.log.error(`Not added: ${ConfigPolicy.message(lockedKey)}.`)
      if (lockedKey !== FIELD) dep.log.info(`${source} is not on the allowed marketplace list.`)
      return false
    }
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
    resolve.stop(`Validated "${manifest.item.name}" (${describeContents(manifest.item)})`)
    // Seed the cache with the manifest already fetched above so the next `list`/`search`/Discover
    // read is a cache hit rather than fetching this same source again immediately after adding it.
    // Local path sources bypass the cache entirely (see resolveWithCache), so seeding one would
    // just be a dead file nothing ever reads.
    if (sourceKind(source) !== "path") await cacheMarketplaceManifest(source, manifest.item, dep.cache)

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
  scope: "local" | "global" | "builtin"
  source: string
  name?: string
  contents?: string
  error?: string
  fetchedAt?: number
  stale?: string
}

export async function listMarketplaces(
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
): Promise<MarketplaceListEntry[]> {
  const resolved = await resolveAddedMarketplaces(ctx, dep)
  return resolved.map((entry) =>
    entry.ok
      ? {
          scope: entry.scope,
          source: entry.source,
          name: entry.manifest.name,
          contents: describeContents(entry.manifest),
          fetchedAt: entry.fetchedAt,
          stale: entry.stale,
        }
      : { scope: entry.scope, source: entry.source, error: entry.error },
  )
}

// Matches the `<name>` argument of `lunos marketplace update <name>` against either the
// as-configured source string (same identity `add <source>` uses) or the manifest's declared
// name (what `list`/Discover display), so users can target either the value they typed or the
// value they see.
export async function findAddedMarketplace(
  name: string,
  ctx: MarketplaceCtx,
  dep: MarketplaceListDeps = defaultMarketplaceListDeps,
) {
  const resolved = await resolveAddedMarketplaces(ctx, dep)
  const needle = name.trim().toLowerCase()
  return resolved.find(
    (entry) => entry.source.toLowerCase() === needle || (entry.ok && entry.manifest.name.toLowerCase() === needle),
  )
}

export type MarketplaceUpdateInput = { name: string }

export function createMarketplaceUpdateTask(
  input: MarketplaceUpdateInput,
  dep: MarketplaceDeps = defaultMarketplaceDeps,
  listDep: MarketplaceListDeps = defaultMarketplaceListDeps,
) {
  return async (ctx: MarketplaceCtx) => {
    const match = await findAddedMarketplace(input.name, ctx, listDep)
    if (!match) {
      dep.log.error(`No added marketplace matches "${input.name}"`)
      return false
    }

    const spin = dep.spinner()
    spin.start(`Refreshing "${match.source}"...`)
    const result = await refreshMarketplaceCache(match.source, listDep)
    if (result.ok) {
      spin.stop(`Refreshed "${result.manifest.name}" (${describeContents(result.manifest)})`)
      dep.log.success(`Marketplace "${result.manifest.name}" is up to date`)
      return true
    }

    if (result.fetchedAt !== undefined) {
      spin.stop("Refresh failed", 1)
      dep.log.error(result.error)
      dep.log.info(`Still serving the cached copy from ${new Date(result.fetchedAt).toLocaleString()}`)
      return false
    }

    spin.stop("Refresh failed", 1)
    dep.log.error(result.error)
    return false
  }
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
      const updated = entry.fetchedAt ? `updated ${new Date(entry.fetchedAt).toLocaleString()}` : undefined
      const detail = entry.error
        ? `unreachable: ${entry.error}`
        : entry.stale
          ? `${entry.contents}, refresh failed (${entry.stale}) — showing cache from ${updated}`
          : `${entry.contents}, ${updated}`
      log.info(`[${entry.scope}] ${label} ${UI.Style.TEXT_DIM}${detail}`)
    }

    outro(`${entries.length} marketplace(s)`)
  }),
})

export const MarketplaceUpdateCommand = effectCmd({
  command: "update <name>",
  describe: "force re-fetch a marketplace source, refreshing its cache",
  builder: (yargs) =>
    yargs.positional("name", {
      type: "string",
      describe: "added source (as configured) or marketplace name",
    }),
  handler: Effect.fn("Cli.marketplace.update")(function* (args) {
    const name = String(args.name ?? "").trim()
    if (!name) {
      UI.error("name is required")
      process.exitCode = 1
      return
    }

    UI.empty()
    intro(`Update marketplace ${name}`)

    const run = createMarketplaceUpdateTask({ name })

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

export const MarketplaceCommand = cmd({
  command: "marketplace",
  describe: "manage marketplace sources and install plugins, skills, hooks and MCP servers",
  builder: (yargs) =>
    yargs
      .command(MarketplaceAddCommand)
      .command(MarketplaceListCommand)
      .command(MarketplaceUpdateCommand)
      .command(MarketplaceSearchCommand)
      .command(MarketplaceInstallCommand)
      .demandCommand(),
  async handler() {},
})
