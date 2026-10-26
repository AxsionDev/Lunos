import { EOL } from "os"
import { Effect } from "effect"
import type { ConfigResource } from "@opencode-ai/core/config/resource"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import { Resource } from "@/resource"

// XCOD-300: project resources on the command line. XCOD-298: once its `lunos project` command
// exists, mount these as `lunos project resource …` too (this one can stay as an alias).

const MODES = ["always", "search", "on_demand"] as const

function row(item: Resource.Entry) {
  const tokens = item.status && !item.status.error ? ` · ~${item.status.tokens} tokens` : ""
  const flags = [item.scope, item.readOnly ? "read-only" : "", item.trusted ? "" : "untrusted"].filter(Boolean)
  return [
    `${item.name}  ${item.kind} · ${item.mode} · ${flags.join(", ")}${tokens}`,
    `  ${item.target}`,
    ...(item.description ? [`  ${item.description}`] : []),
    `  ${item.state}`,
    ...(item.status?.truncated ? [`  ${item.status.truncated}`] : []),
    ...(item.status?.skipped.length
      ? [
          `  skipped ${item.status.skipped.length}: ${item.status.skipped
            .slice(0, 5)
            .map((skip) => `${skip.source} (${skip.reason})`)
            .join(", ")}`,
        ]
      : []),
  ]
}

function json(item: Resource.Entry) {
  return {
    name: item.name,
    kind: item.kind,
    mode: item.mode,
    scope: item.scope,
    description: item.description ?? null,
    target: item.target,
    read_only: item.readOnly,
    trusted: item.trusted,
    excluded: item.excluded,
    problem: item.problem ?? null,
    state: item.state,
    status: item.status ?? null,
  }
}

/** The kind of resource a target names: a URL, a git repository, an MCP resource or a path. */
export function entryOf(
  target: string,
  args: {
    description?: string
    mode?: ConfigResource.Mode
    include?: string[]
    exclude?: string[]
    depth?: number
    branch?: string
    git?: boolean
    server?: string
  },
): ConfigResource.Entry {
  const common = {
    ...(args.description ? { description: args.description } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
  }
  const globs = {
    ...(args.include?.length ? { include: args.include } : {}),
    ...(args.exclude?.length ? { exclude: args.exclude } : {}),
  }
  if (args.server) return { server: args.server, uri: target, ...common }
  if (args.git || /^git@|\.git$|^ssh:\/\//.test(target))
    return { repository: target, ...(args.branch ? { branch: args.branch } : {}), ...globs, ...common }
  if (/^https?:\/\//i.test(target)) {
    const depth = args.depth === 1 || args.depth === 2 ? args.depth : undefined
    return { url: target, ...(depth ? { depth } : {}), ...common }
  }
  return { path: target, ...globs, ...common }
}

const ListCommand = effectCmd({
  command: "list",
  describe: "the project's resources, with mode, scope, size and when each was indexed",
  builder: (yargs) => yargs.option("json", { type: "boolean", describe: "print as JSON" }),
  handler: Effect.fn("Cli.resource.list")(function* (args: { json?: boolean }) {
    const list = yield* Resource.Service.use((service) => service.list())
    if (args.json) return yield* writeStdoutEffect(JSON.stringify(list.map(json), null, 2) + EOL)
    if (!list.length)
      return yield* writeStdoutEffect(
        "No project resources. Add one with `lunos resource add <name> <path|url|repository>`." + EOL,
      )
    yield* writeStdoutEffect(list.flatMap(row).join(EOL) + EOL)
  }),
})

const AddCommand = effectCmd({
  command: "add <name> <target>",
  describe: "add a file, folder, git repository, web page or MCP resource (with --server) to the project",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true, describe: "its name, also its @alias in prompts" })
      .positional("target", {
        type: "string",
        demandOption: true,
        describe: "a path, an http(s) URL, a git repository, or an MCP resource URI with --server",
      })
      .option("description", { type: "string", describe: "what it's for, shown to the agent" })
      .option("mode", { choices: MODES, describe: "always, search (default) or on_demand" })
      .option("personal", {
        type: "boolean",
        describe: "keep it on this computer only, instead of in the project's config",
      })
      .option("include", { type: "string", array: true, describe: "globs of files to include (folders)" })
      .option("exclude", { type: "string", array: true, describe: "globs of files to leave out (folders)" })
      .option("depth", { type: "number", describe: "links to follow on the same site: 0 (default), 1 or 2" })
      .option("branch", { type: "string", describe: "branch or tag (git)" })
      .option("git", { type: "boolean", describe: "the target is a git repository" })
      .option("server", { type: "string", describe: "the connected MCP server the URI is on" })
      .option("json", { type: "boolean", describe: "print the result as JSON" }),
  handler: Effect.fn("Cli.resource.add")(function* (args: {
    name: string
    target: string
    description?: string
    mode?: ConfigResource.Mode
    personal?: boolean
    include?: string[]
    exclude?: string[]
    depth?: number
    branch?: string
    git?: boolean
    server?: string
    json?: boolean
  }) {
    const entry = entryOf(args.target, args)
    const added = yield* Resource.Service.use((service) =>
      service.add({ name: args.name, entry, scope: args.personal ? "personal" : "shared" }),
    ).pipe(Effect.catch((error) => fail(`Can't add ${args.name}: ${error.message}`)))
    if (args.json) return yield* writeStdoutEffect(JSON.stringify(json(added), null, 2) + EOL)
    yield* writeStdoutEffect(
      [
        `Added ${added.name} (${added.scope === "personal" ? "personal, on this computer only" : "shared, in the project's config"})`,
        ...row(added),
        "Its content stays on this computer; it is sent only inside a prompt to the model you use.",
      ].join(EOL) + EOL,
    )
  }),
})

const RemoveCommand = effectCmd({
  command: "remove <name>",
  aliases: ["rm"],
  describe: "remove a resource from the project",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("json", { type: "boolean", describe: "print the result as JSON" }),
  handler: Effect.fn("Cli.resource.remove")(function* (args: { name: string; json?: boolean }) {
    const scope = yield* Resource.Service.use((service) => service.remove(args.name)).pipe(
      Effect.catch((error) => fail(`Can't remove ${args.name}: ${error.message}`)),
    )
    yield* writeStdoutEffect(
      (args.json ? JSON.stringify({ removed: args.name, scope }) : `Removed ${args.name} (${scope})`) + EOL,
    )
  }),
})

const RefreshCommand = effectCmd({
  command: "refresh [name]",
  describe: "index a resource again now (all of them without a name)",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string" })
      .option("json", { type: "boolean", describe: "print the result as JSON" }),
  handler: Effect.fn("Cli.resource.refresh")(function* (args: { name?: string; json?: boolean }) {
    const list = yield* Resource.Service.use((service) => service.refresh(args.name))
    if (args.name && !list.length) return yield* fail(`There is no resource named ${args.name}`)
    if (args.json) return yield* writeStdoutEffect(JSON.stringify(list.map(json), null, 2) + EOL)
    yield* writeStdoutEffect(list.map((item) => `${item.name}: ${item.state}`).join(EOL) + EOL)
    if (list.some((item) => item.status?.error)) process.exitCode = 1
  }),
})

export const ResourceCommand = cmd({
  command: "resource",
  describe: "files, folders, repositories, web pages and MCP resources the agent gets as context in this project",
  builder: (yargs) =>
    yargs.command(ListCommand).command(AddCommand).command(RemoveCommand).command(RefreshCommand).demandCommand(),
  handler: () => {},
})
