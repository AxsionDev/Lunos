// XCOD-278: keeps the TUI tips true. A tip that names a /command, a `lunos` subcommand or flag, a config
// key, a {key:…} binding or an environment variable that doesn't exist fails here, so a rename in code
// can't leave a tip pointing at nothing.
import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { TIPS, parts, type Tip } from "@opencode-ai/tui/util/tips"
import { TuiKeybind } from "@opencode-ai/tui/config/keybind"

const ROOT = path.resolve(import.meta.dir, "../../../..")
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8")

function sources(dir: string): string[] {
  return fs
    .readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .flatMap((file) => (/\.(ts|tsx)$/.test(file) ? [read(path.join(dir, file))] : []))
}

/** Every /command: the TUI's slash names and aliases, and the server's built-in commands. */
function slashCommands() {
  const names = new Set<string>()
  const add = (list: string) => {
    for (const match of list.matchAll(/"([\w-]+)"/g)) names.add(match[1]!)
  }
  for (const text of sources("packages/tui/src")) {
    for (const match of text.matchAll(/slashName:\s*"([\w-]+)"/g)) names.add(match[1]!)
    for (const match of text.matchAll(/slashAliases:\s*\[([^\]]*)\]/g)) add(match[1]!)
    for (const match of text.matchAll(/slash:\s*\{\s*name:\s*"([\w-]+)"(?:,\s*aliases:\s*\[([^\]]*)\])?/g)) {
      names.add(match[1]!)
      if (match[2]) add(match[2])
    }
    // /claude and /codex are registered from one array (`slashName: tool`).
    const tools = /\.\.\.\(\[([^\]]*)\] as const\)\.map\(\(tool\)/.exec(text)
    if (tools && text.includes("slashName: tool")) add(tools[1]!)
  }
  const defaults = /export const Default = \{([^}]*)\}/.exec(read("packages/opencode/src/command/index.ts"))
  if (defaults) add(defaults[1]!)
  return names
}

type CliNode = { children: Map<string, CliNode>; options: Set<string> }

/** The `lunos` command tree, from the modules src/index.ts registers, with each command's options. */
async function cliTree() {
  const index = read("packages/opencode/src/index.ts")
  const imports = new Map<string, string>()
  for (const match of index.matchAll(/import \{([^}]+)\} from "\.\/(cli\/cmd\/[^"]+)"/g))
    for (const name of match[1]!.split(",").map((item) => item.trim())) imports.set(name, match[2]!)
  const node = (): CliNode => ({ children: new Map(), options: new Set(["help", "h"]) })
  const root = node()
  // Global options on the root yargs instance.
  for (const match of index.matchAll(/\.option\("([\w-]+)"(?:,\s*\{[^}]*?alias:\s*"(\w+)")?/g)) {
    root.options.add(match[1]!)
    if (match[2]) root.options.add(match[2])
  }
  root.options.add("version").add("v")
  const names = (module: any): string[] =>
    [...(Array.isArray(module.command) ? module.command : [module.command]), ...[module.aliases ?? []].flat()]
      .map((item: string) => String(item).split(" ")[0]!)
      .filter(Boolean)
  const walk = (module: any, target: CliNode) => {
    const record = (name: string, config?: { alias?: string | string[] }) => {
      target.options.add(name)
      for (const alias of [config?.alias ?? []].flat()) target.options.add(alias)
    }
    const children: any[] = []
    const fake: any = new Proxy(() => {}, {
      get: (_, key) => {
        if (key === "command")
          return (child: unknown) => {
            if (child && typeof child === "object") children.push(child)
            return fake
          }
        if (key === "option" || key === "positional")
          return (name: string, config?: { alias?: string | string[] }) => (record(name, config), fake)
        if (key === "options")
          return (all: Record<string, { alias?: string | string[] }>) => {
            for (const [name, config] of Object.entries(all)) record(name, config)
            return fake
          }
        return () => fake
      },
    })
    if (typeof module.builder === "function") module.builder(fake)
    for (const child of children) {
      const item = node()
      walk(child, item)
      for (const name of names(child)) target.children.set(name, item)
    }
  }
  for (const name of index.matchAll(/\.command\((\w+)\)/g)) {
    const file = imports.get(name[1]!)
    if (!file) continue
    const module = (await import(path.join(ROOT, "packages/opencode/src", file)))[name[1]!]
    const item = node()
    walk(module, item)
    for (const command of names(module)) {
      // The default command (`lunos` itself, the TUI): its options are the root's.
      if (command === "$0") for (const option of item.options) root.options.add(option)
      else root.children.set(command, item)
    }
  }
  return root
}

type JsonSchema = Record<string, any>

/** Whether a dotted config path exists in one of the published JSON Schemas. */
function configHas(schema: JsonSchema, key: string) {
  const resolve = (node: JsonSchema): JsonSchema[] => {
    // A reference to another document (models.dev's model id) is a leaf here.
    if (node.$ref) return node.$ref.startsWith("#/$defs/") ? resolve(schema.$defs[node.$ref.slice(8)]) : [{}]
    const nested = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])] as JsonSchema[]
    return [node, ...nested.flatMap(resolve)]
  }
  let current = resolve(schema)
  for (const segment of key.split(".")) {
    const next = current.flatMap((node) => {
      if (node.properties?.[segment]) return resolve(node.properties[segment])
      if (node.additionalProperties && typeof node.additionalProperties === "object")
        return resolve(node.additionalProperties)
      if (node.patternProperties)
        return Object.values(node.patternProperties as Record<string, JsonSchema>).flatMap(resolve)
      return []
    })
    if (!next.length) return false
    current = next
  }
  return true
}

type Registry = {
  slash: Set<string>
  cli: CliNode
  config: JsonSchema[]
  keybinds: Set<string>
  env: string
}

/** GitHub comment triggers: a `/word` that isn't a TUI command, checked against the workflow handler. */
const GITHUB_TRIGGERS = new Set(["lunos"])

export function validate(tips: readonly Tip[], registry: Registry) {
  const errors: string[] = []
  const fail = (tip: Tip, message: string) => errors.push(`${tip.id}: ${message}`)
  for (const tip of tips) {
    for (const name of tip.text.matchAll(/\{key:([^}]+)\}/g))
      if (!registry.keybinds.has(name[1]!)) fail(tip, `no keybind "${name[1]}"`)
    for (const key of tip.config ?? [])
      if (!registry.config.some((schema) => configHas(schema, key))) fail(tip, `no config key "${key}"`)
    for (const part of parts(tip.text).filter((item) => item.highlight)) {
      const text = part.text
      for (const match of text.matchAll(/(?:^|\s)\/([a-z][\w-]*)/g)) {
        const name = match[1]!
        if (GITHUB_TRIGGERS.has(name)) continue
        if (!registry.slash.has(name)) fail(tip, `no /${name} command`)
      }
      // `{env:VAR_NAME}` is config syntax, its name a placeholder.
      for (const match of text.matchAll(/(?<!\{env:)\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g))
        if (!registry.env.includes(`"${match[1]}"`)) fail(tip, `no environment variable ${match[1]}`)
      const cli = /(?:^|\|\s*)lunos((?:\s+[^|]+)?)$/.exec(text)
      const flagsOnly = /^--?[\w-]/.test(text)
      if (!cli && !flagsOnly) continue
      const tokens = (cli ? cli[1]! : text).match(/"[^"]*"|\S+/g) ?? []
      let node = registry.cli
      let positional = false
      for (const token of tokens) {
        if (token.startsWith("-")) {
          const flag = token.replace(/^--?/, "").split("=")[0]!
          if (!node.options.has(flag) && !registry.cli.options.has(flag)) fail(tip, `"${text}": no --${flag} option`)
          continue
        }
        const child = positional ? undefined : node.children.get(token)
        if (child) {
          node = child
          continue
        }
        if (node === registry.cli) {
          fail(tip, `"${text}": no lunos ${token} command`)
          break
        }
        if (node.children.size && !/^[<"]/.test(token)) fail(tip, `"${text}": no subcommand "${token}"`)
        positional = true
      }
    }
  }
  return errors
}

describe("tips", async () => {
  const registry: Registry = {
    slash: slashCommands(),
    cli: await cliTree(),
    config: [JSON.parse(read("schemas/config.json")), JSON.parse(read("schemas/tui.json"))],
    keybinds: new Set(Object.keys(TuiKeybind.Definitions)),
    env: [...sources("packages/core/src"), ...sources("packages/opencode/src")].join("\n"),
  }

  test("XCOD-278: every tip names commands, subcommands, options, config keys and keybinds that exist", () => {
    expect(validate(TIPS, registry)).toEqual([])
  })

  test("XCOD-278: the validator catches what doesn't exist", () => {
    const tip = (text: string, config?: string[]): Tip => ({ id: "fake", category: "Test", text, config })
    expect(validate([tip("Run {highlight}/nonexistent{/highlight} to do nothing")], registry)).toEqual([
      "fake: no /nonexistent command",
    ])
    expect(validate([tip("Run {highlight}lunos frobnicate{/highlight}")], registry)).toEqual([
      'fake: "lunos frobnicate": no lunos frobnicate command',
    ])
    expect(validate([tip("Run {highlight}lunos memory frob{/highlight}")], registry)).toEqual([
      'fake: "lunos memory frob": no subcommand "frob"',
    ])
    expect(validate([tip("Run {highlight}lunos session stop --everything{/highlight}")], registry)).toEqual([
      'fake: "lunos session stop --everything": no --everything option',
    ])
    expect(validate([tip("Set it", ["memory.nope"])], registry)).toEqual(['fake: no config key "memory.nope"'])
    expect(validate([tip("Press {key:agent_cycle}")], registry)).toEqual(['fake: no keybind "agent_cycle"'])
    expect(validate([tip("Set {highlight}LUNOS_NOPE_NOPE=1{/highlight}")], registry)).toEqual([
      "fake: no environment variable LUNOS_NOPE_NOPE",
    ])
    // The positive controls: these exist.
    expect(
      validate(
        [
          tip("Run {highlight}/memory{/highlight} or {highlight}/discover{/highlight}"),
          tip("Run {highlight}lunos auth list{/highlight} and {highlight}lunos run --cloud{/highlight}"),
          tip("Run {highlight}lunos --continue{/highlight} with {highlight}--print-logs{/highlight}", ["tips"]),
        ],
        registry,
      ),
    ).toEqual([])
  })

  test("XCOD-278: /lunos in a tip is the GitHub comment trigger the workflow listens for", () => {
    expect(read("packages/opencode/src/cli/cmd/github.handler.ts")).toContain("'/lunos'")
  })
})
