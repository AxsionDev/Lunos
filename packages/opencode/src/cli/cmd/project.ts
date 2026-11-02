import { EOL } from "os"
import path from "path"
import type { Argv, CommandModule } from "yargs"
import { Effect } from "effect"
import { ProjectGroup } from "@/project/group"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// XCOD-298: `lunos project`: named projects, each grouping several repositories or directories, kept
// on this computer only (`project/group.ts`). A repository is a project of its own without any of
// this. A project is named by its id or its name. `--json` prints the project (`ProjectGroup.Info`),
// or the list of them, as stored.

const out = (line = "") => process.stdout.write(line + EOL)
const dim = (text: string) => UI.Style.TEXT_DIM + text + UI.Style.TEXT_NORMAL
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Common = { json: boolean }

const output = <T>(yargs: Argv<T>) => yargs.option("json", { type: "boolean", default: false, describe: "print JSON" })

/** Folders as typed, relative to the working directory; none means the working directory. */
const folders = (list: readonly (string | number)[] | undefined, fallback = true) => {
  const given = (list ?? []).map(String).filter(Boolean)
  return (given.length || !fallback ? given : [process.cwd()]).map((folder) => path.resolve(folder))
}

/** The project `name` names (id or name), or a failure that says so. */
async function named(name: string) {
  const found = await ProjectGroup.get(name)
  if (!found) throw new ProjectGroup.NotFoundError(`"${name}". See lunos project list`)
  return found
}

export function describe(group: ProjectGroup.Info) {
  return [
    `${group.name} ${dim(`(${group.id})`)}${group.archived ? " (archived)" : ""}`,
    ...(group.folders.length ? group.folders.map((folder) => `  ${folder}`) : [dim("  no folders yet")]),
  ]
}

/**
 * Runs a subcommand: its result as JSON with `--json`, else its lines. A refusal is printed as
 * `{ "error": { message } }` with `--json`, and the exit code is 1. Exported for `project …`
 * subcommands added elsewhere (XCOD-300's `project resource`).
 */
export const run = <A extends Common>(name: string, body: (args: A) => Promise<{ json: unknown; lines: string[] }>) =>
  Effect.fn(`Cli.project.${name}`)(function* (args: A) {
    const result = yield* Effect.tryPromise({ try: () => body(args), catch: (error) => error })
      .pipe(Effect.map((value) => ({ value, error: undefined })))
      .pipe(Effect.catch((error) => Effect.succeed({ value: undefined, error })))
    if (result.value) {
      if (args.json) out(JSON.stringify(result.value.json, null, 2))
      else for (const line of result.value.lines) out(line)
      return
    }
    const text = message(result.error)
    if (!args.json) return yield* fail(text)
    out(JSON.stringify({ error: { message: text } }, null, 2))
    return yield* fail("")
  })

export const ProjectListCommand = effectCmd({
  command: "list",
  describe: "your named projects and their folders",
  instance: false,
  builder: (yargs) =>
    output(yargs).option("archived", { type: "boolean", default: false, describe: "include archived projects" }),
  handler: run("list", async (args: Common & { archived: boolean }) => {
    const all = await ProjectGroup.list()
    const shown = args.archived ? all : all.filter((group) => !group.archived)
    const here = await ProjectGroup.resolve(process.cwd())
    return {
      json: shown,
      lines: shown.length
        ? [
            ...shown.flatMap((group) => [...describe(group), ""]),
            here ? `This folder is in ${here.name}.` : "This folder counts in its repository's project.",
          ]
        : [
            "No named projects. Each repository is a project of its own.",
            dim('Group several folders into one with lunos project create "Axsion web" ../web ../api'),
          ],
    }
  }),
})

export const ProjectCreateCommand = effectCmd({
  command: "create <name> [folders..]",
  describe: "create a named project from folders (default: this folder)",
  instance: false,
  builder: (yargs) =>
    output(yargs)
      .positional("name", { type: "string", demandOption: true, describe: "the project's name" })
      .positional("folders", { type: "string", array: true, describe: "repositories or directories in it" })
      .option("empty", { type: "boolean", default: false, describe: "create it without any folder" }),
  handler: run("create", async (args: Common & { name: string; folders?: string[]; empty: boolean }) => {
    const group = await ProjectGroup.create({ name: args.name, folders: folders(args.folders, !args.empty) })
    return { json: group, lines: ["Created", ...describe(group)] }
  }),
})

export const ProjectRenameCommand = effectCmd({
  command: "rename <project> <name>",
  describe: "rename a named project",
  instance: false,
  builder: (yargs) =>
    output(yargs)
      .positional("project", { type: "string", demandOption: true, describe: "its id or current name" })
      .positional("name", { type: "string", demandOption: true, describe: "the new name" }),
  handler: run("rename", async (args: Common & { project: string; name: string }) => {
    const group = await ProjectGroup.rename((await named(args.project)).id, args.name)
    return { json: group, lines: [`Renamed to ${group.name}`] }
  }),
})

export const ProjectAddCommand = effectCmd({
  command: "add <project> [folders..]",
  describe: "add folders to a named project (default: this folder)",
  instance: false,
  builder: (yargs) =>
    output(yargs)
      .positional("project", { type: "string", demandOption: true, describe: "its id or name" })
      .positional("folders", { type: "string", array: true, describe: "repositories or directories to add" }),
  handler: run("add", async (args: Common & { project: string; folders?: string[] }) => {
    const group = await ProjectGroup.add((await named(args.project)).id, folders(args.folders))
    return { json: group, lines: describe(group) }
  }),
})

export const ProjectRemoveCommand = effectCmd({
  command: "remove <project> [folders..]",
  describe: "remove folders from a named project (default: this folder)",
  instance: false,
  builder: (yargs) =>
    output(yargs)
      .positional("project", { type: "string", demandOption: true, describe: "its id or name" })
      .positional("folders", { type: "string", array: true, describe: "folders to remove" }),
  handler: run("remove", async (args: Common & { project: string; folders?: string[] }) => {
    const group = await ProjectGroup.remove((await named(args.project)).id, folders(args.folders))
    return { json: group, lines: describe(group) }
  }),
})

export const ProjectArchiveCommand = effectCmd({
  command: "archive <project>",
  describe: "archive a named project: its folders count in their repositories' projects again",
  instance: false,
  builder: (yargs) =>
    output(yargs)
      .positional("project", { type: "string", demandOption: true, describe: "its id or name" })
      .option("undo", { type: "boolean", default: false, describe: "bring an archived project back" }),
  handler: run("archive", async (args: Common & { project: string; undo: boolean }) => {
    const group = await ProjectGroup.archive((await named(args.project)).id, !args.undo)
    return { json: group, lines: [`${group.archived ? "Archived" : "Restored"} ${group.name}`] }
  }),
})

/** `lunos project`'s subcommands. Add one here (XCOD-300's `project resource …`) and it's registered. */
export const SUBCOMMANDS: CommandModule<{}, any>[] = [
  ProjectListCommand,
  ProjectCreateCommand,
  ProjectRenameCommand,
  ProjectAddCommand,
  ProjectRemoveCommand,
  ProjectArchiveCommand,
]

export const ProjectCommand = cmd({
  command: "project",
  describe: "named projects: several repositories or directories counted as one",
  builder: (yargs) => SUBCOMMANDS.reduce((acc, command) => acc.command(command), yargs).demandCommand(),
  async handler() {},
})
