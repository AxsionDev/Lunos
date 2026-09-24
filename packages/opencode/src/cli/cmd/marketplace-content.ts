import * as prompts from "@clack/prompts"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { listContent, searchContent, type ContentItem } from "../../marketplace/content"
import { planInstall, resolveConfigPath, type ConfigItem } from "../../marketplace/install"
import { resolveByName } from "../../marketplace/resolve"
import { MarketplaceRefusal } from "../../marketplace/guard"
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
// `mcp add <name>` and `marketplace install`. Marketplace installs always write global config.
export async function confirmAndInstall(item: ConfigItem, yes: boolean) {
  const configPath = await resolveConfigPath(Global.Path.config, true)
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
  describe: "install a plugin, skill source, hook or MCP server from an added marketplace",
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "entry name, or <marketplace>/<name> when it appears in more than one",
      })
      .option("kind", kindOption)
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

    // Refusals from pickOne/planInstall (ambiguous name, unsupported hook event, duplicate entry)
    // are expected outcomes, so they surface as a CliError: plain message, exit 1, no "Unexpected
    // error" banner. Anything else -- an I/O fault, a cancelled prompt -- is rethrown to keep its
    // existing path.
    const refusal = (error: unknown) => {
      if (error instanceof MarketplaceRefusal) return error.message
      throw error
    }

    const picked = yield* Effect.promise(() =>
      listContent(marketplaceCtx, kind)
        .then(({ items }) => ({ item: pickOne(items, name) }))
        .catch((error: unknown) => ({ error: refusal(error) })),
    )
    if ("error" in picked) return yield* fail(picked.error)
    const item = picked.item
    if (!item) {
      UI.error(`No marketplace entry named "${name}"${kind ? ` of kind ${kind}` : ""}. Try: lunos marketplace search`)
      process.exitCode = 1
      return
    }

    if (item.kind === "plugin") {
      // Plugins keep their own install path, which fetches the package and reads its manifest.
      const ok = yield* Effect.promise(() =>
        createPlugTask({ mod: item.spec, global: true, force: false })(marketplaceCtx),
      )
      if (!ok) process.exitCode = 1
      return
    }

    const failure = yield* Effect.promise(() =>
      confirmAndInstall(item, Boolean(args.yes)).then(() => undefined, refusal),
    )
    if (failure !== undefined) return yield* fail(failure)
  }),
})
