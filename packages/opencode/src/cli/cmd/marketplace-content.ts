import * as prompts from "@clack/prompts"
import { AuditLog } from "@/audit/log"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { listContent, searchContent, type ContentItem } from "../../marketplace/content"
import { planInstall, resolveConfigPath, type ConfigItem } from "../../marketplace/install"
import { resolveByName } from "../../marketplace/resolve"
import { MarketplaceAlreadyInstalled, MarketplaceRefusal } from "../../marketplace/guard"
import { normalizeSource } from "../../marketplace/shared"
import { createMarketplaceAddTask } from "./marketplace"
import { createPlugTask } from "./plug"
import { printStaleMarketplaces } from "./plug"
import { UI } from "../ui"
import { effectCmd, fail } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"

const LABEL: Record<Marketplace.Kind, string> = {
  plugin: "plugin",
  skill: "skill source",
  hook: "hook",
  mcp: "MCP server",
}

// Resolves a bare or `<marketplace>/<name>` reference to exactly one item, or explains why not.
// `undefined` means nothing matched, so the caller decides what an unknown name means for it.
export function pickOne<T extends ContentItem>(items: readonly T[], name: string): T | undefined {
  const matches = resolveByName(items, name)
  if (matches.length > 1) {
    const qualified = matches.map((m) => `${m.marketplace}/${m.name} (${m.kind})`).join(", ")
    throw new MarketplaceRefusal(`"${name}" exists in more than one place. Use one of: ${qualified}, or pass --kind`)
  }
  return matches[0]
}

// Shows exactly what a marketplace entry will run, connect to or fetch, and where it will be
// written, then asks before writing. Every config-kind install from the CLI goes through here so
// the preview, the refusals (planInstall throws) and the confirmation can't differ between
// `mcp add <name>` and `marketplace install`. Marketplace installs write global config unless the
// caller passes a project directory (`marketplace install --local`).
export async function confirmAndInstall(item: ConfigItem, yes: boolean, localDir?: string) {
  const configPath = localDir
    ? await resolveConfigPath(localDir, false)
    : await resolveConfigPath(Global.Path.config, true)
  const plan = await planInstall(item, configPath)
  UI.println(`${plan.marketplace}/${plan.name}  (${LABEL[plan.kind]})`)
  if (item.description) UI.println(`  ${item.description}`)
  for (const line of plan.details) UI.println(`  ${line}`)
  UI.println(`  writes to: ${plan.configPath}`)
  for (const warning of plan.warnings) UI.println(`  warning: ${warning}`)

  if (!yes) {
    const ok = await prompts.confirm({ message: `Add this ${LABEL[plan.kind]}?` })
    if (prompts.isCancel(ok) || !ok) throw new UI.CancelledError()
  }

  await plan.apply()
  AuditLog.emit("marketplace.install", {
    kind: plan.kind,
    name: plan.name,
    marketplace: plan.marketplace,
    path: plan.configPath,
  })
  prompts.log.success(`${LABEL[plan.kind]} "${plan.name}" added to ${plan.configPath}`)
}

const kindOption = {
  describe: "only this content kind",
  type: "string" as const,
  choices: Marketplace.KINDS,
}

function printItems(items: readonly ContentItem[]) {
  for (const item of items) {
    prompts.log.info(
      `${item.marketplace}/${item.name}  [${item.kind}]${item.description ? `  ${item.description}` : ""}`,
    )
  }
}

export const MarketplaceSearchCommand = effectCmd({
  command: "search <query>",
  describe: "search plugins, skills, hooks and MCP servers across added marketplaces",
  builder: (yargs) =>
    yargs
      .positional("query", {
        type: "string",
        describe: "case-insensitive substring match on name/description/tags/category",
      })
      .option("kind", kindOption),
  handler: Effect.fn("Cli.marketplace.search")(function* (args) {
    const query = String(args.query ?? "").trim()
    const kind = args.kind as Marketplace.Kind | undefined

    UI.empty()
    prompts.intro(`Search marketplaces: ${query}${kind ? ` (${kind})` : ""}`)

    const ctx = yield* InstanceRef
    if (!ctx) return
    const { marketplaceCount, marketplaces, items } = yield* Effect.promise(() =>
      searchContent(query, { vcs: ctx.project.vcs, worktree: ctx.worktree, directory: ctx.directory }, kind),
    )
    printStaleMarketplaces(marketplaces)

    if (!marketplaceCount) {
      prompts.log.warn("No marketplaces added")
      prompts.outro("Add one with: lunos marketplace add <owner/repo | url | path>")
      return
    }
    if (!items.length) {
      prompts.log.warn(`Nothing matched "${query}"`)
      prompts.outro("Done")
      return
    }
    printItems(items)
    prompts.outro(`${items.length} match(es)`)
  }),
})

export const MarketplaceInstallCommand = effectCmd({
  command: "install <name>",
  describe: "install a plugin, skill source, hook or MCP server from a marketplace",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "entry name, or <marketplace>/<name> when it appears in more than one",
      })
      .option("kind", kindOption)
      .option("from", {
        type: "string",
        describe: "marketplace source (manifest URL, owner/repo or path); added first if it isn't already",
      })
      .option("local", {
        type: "boolean",
        default: false,
        describe: "write to this project's config instead of the global config",
      })
      .option("yes", {
        describe: "skip the confirmation prompt",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.marketplace.install")(function* (args) {
    const ctx = yield* InstanceRef
    if (!ctx) return
    const marketplaceCtx = { vcs: ctx.project.vcs, worktree: ctx.worktree, directory: ctx.directory }
    const name = String(args.name ?? "").trim()
    const kind = args.kind as Marketplace.Kind | undefined
    const local = Boolean(args.local)
    const yes = Boolean(args.yes)

    // Refusals from pickOne/planInstall (ambiguous name, unsupported hook event, duplicate entry)
    // are expected outcomes, so they surface as a CliError: plain message, exit 1, no "Unexpected
    // error" banner. "Already installed" is a success. Anything else -- an I/O fault, a cancelled
    // prompt -- is rethrown to keep its existing path.
    const refusal = (error: unknown) => {
      if (error instanceof MarketplaceAlreadyInstalled) {
        prompts.log.success(error.message)
        return undefined
      }
      if (error instanceof MarketplaceRefusal) {
        AuditLog.emit("marketplace.refused", { name, kind, reason: error.message })
        return error.message
      }
      throw error
    }

    // --from: a command copied from a third-party marketplace's page works without a separate
    // `marketplace add`. The source is added to the same scope the entry is installed into.
    const from = typeof args.from === "string" && args.from.trim() ? normalizeSource(args.from.trim()) : undefined
    if (from) {
      const added = yield* Effect.promise(() => listContent(marketplaceCtx))
      const known = added.marketplaces.some((marketplace) => normalizeSource(marketplace.source) === from)
      if (!known) {
        const ok = yield* Effect.promise(() =>
          createMarketplaceAddTask({ source: from, global: !local })(marketplaceCtx),
        )
        if (!ok) {
          process.exitCode = 1
          return
        }
      }
    }

    const picked = yield* Effect.promise(() =>
      listContent(marketplaceCtx, kind)
        .then((listed) => ({ listed, item: pickOne(listed.items, name) }))
        .catch((error: unknown) => ({ error: refusal(error) })),
    )
    if ("error" in picked) return picked.error === undefined ? undefined : yield* fail(picked.error)
    const item = picked.item
    if (!item) {
      const searched = picked.listed.marketplaces.map((marketplace) => marketplace.name)
      const where = searched.length
        ? `in ${searched.map((marketplace) => `"${marketplace}"`).join(", ")}`
        : "because no marketplace could be reached"
      return yield* fail(
        `No entry named "${name}"${kind ? ` of kind ${kind}` : ""} was found ${where}. Try: lunos marketplace search ${name.split("/").pop()}`,
      )
    }

    if (item.kind === "plugin") {
      // Plugins keep their own install path, which fetches the package and reads its manifest.
      // Preview and confirm first, like every other kind: a command pasted from a web page must
      // never install without the user seeing what it is.
      UI.println(`${item.marketplace}/${item.name}  (plugin)`)
      if (item.description) UI.println(`  ${item.description}`)
      UI.println(`  npm package: ${item.spec}`)
      UI.println(`  writes to: ${local ? "this project's config" : "global config"}`)
      if (!yes) {
        const ok = yield* Effect.promise(() => prompts.confirm({ message: "Install this plugin?" }))
        if (prompts.isCancel(ok) || !ok) throw new UI.CancelledError()
      }
      const ok = yield* Effect.promise(() =>
        createPlugTask({ mod: item.spec, global: !local, force: false })(marketplaceCtx),
      )
      AuditLog.emit(ok ? "marketplace.install" : "marketplace.refused", {
        kind: "plugin",
        name: item.name,
        marketplace: item.marketplace,
        package: item.spec,
      })
      if (!ok) process.exitCode = 1
      return
    }

    const failure = yield* Effect.promise(() =>
      confirmAndInstall(item, yes, local ? ctx.directory : undefined).then(() => undefined, refusal),
    )
    if (failure !== undefined) return yield* fail(failure)
  }),
})
