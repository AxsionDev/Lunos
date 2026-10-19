import { EOL } from "os"
import { Effect } from "effect"
import { MemorySetup } from "@opencode-ai/core/memory-setup"
import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import type { Residency } from "@opencode-ai/core/residency"
import type { ConfigMemory } from "@opencode-ai/core/config/memory"
import { effectCmd } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import type { MemoryTemplate } from "@/memory/template"

// The memory modules are imported when used, not when the CLI loads (like memory-setup.ts does).
const external = () => import("@/memory/external").then((mod) => mod.MemoryExternal)
const templates = () => import("@/memory/template").then((mod) => mod.MemoryTemplate)

// XCOD-264: step 2 of `lunos memory setup`, "Where should memory be stored?": start from a
// template, or choose storage yourself from the cards (with Compare and Help me choose). The same
// words as the TUI wizard, from @opencode-ai/core/memory-storage.

type Prompts = typeof import("@clack/prompts")

export type Args = {
  yes?: boolean
  project?: boolean
  template?: string
  start?: boolean
  url?: string
  jurisdiction?: string
  vendor?: string
}

export type Outcome =
  | {
      kind: "ok"
      draft: MemorySetup.Draft
      template?: { name: string; scope: MemoryTemplate.Scope; env: Record<string, string> }
    }
  | { kind: "cancel" }
  | { kind: "fail"; message: string }

type Env = { environment: MemoryStorage.Environment; templates: MemoryStorage.Listed[] }

const say = (text: string) => process.stdout.write(text + EOL)

/** "What this means" for a card, indented under its title. */
export function cardText(card: MemoryStorage.Card) {
  return [
    `${card.title}${card.recommended ? ` (${card.recommended})` : ""}${card.unavailable ? ` — ${card.unavailable}` : ""}`,
    `  ${card.summary}`,
    ...MemoryStorage.meaning(card).map((line) => `  ${line}`),
  ]
}

const DEFAULT_USER = { neo4j: "{env:NEO4J_USER}", postgres: "{env:POSTGRES_USER}" }
const DEFAULT_PASSWORD = { neo4j: "{env:NEO4J_PASSWORD}", postgres: "{env:POSTGRES_PASSWORD}" }
const URL_EXAMPLE = { neo4j: "bolt+s://graph.internal:7687", postgres: "postgres://db.internal:5432/lunos" }

export async function storage(input: {
  prompts: Prompts
  env: Env
  draft: MemorySetup.Draft
  residency: Residency.Resolved | undefined
  worktree: string
  args: Args
}): Promise<Outcome> {
  const { prompts, env, args } = input
  const scope: MemoryTemplate.Scope = args.project ? "project" : "user"
  const cancelled = (value: unknown) => prompts.isCancel(value)

  if (args.template) return applyTemplate({ ...input, scope, name: args.template })
  if (args.yes) return { kind: "ok", draft: input.draft }

  const how = await prompts.select({
    message: "2/6 Where should memory be stored?",
    options: [
      { value: "choose", label: "Choose storage myself", hint: "the options, explained" },
      { value: "template", label: "Start from a template", hint: "ready-made setups, some run a database in Docker" },
    ],
    initialValue: "choose",
  })
  if (cancelled(how)) return { kind: "cancel" }
  if (how === "template") {
    while (true) {
      const picked = await prompts.select({
        message: "Start from a template",
        options: env.templates.map((item) => ({
          value: item.name,
          label: `${item.title}${item.organisation ? " (your organisation)" : ""}`,
          hint: item.unavailable ? `can't be used: ${item.unavailable}` : `leaves the computer: ${item.leaves}`,
        })),
      })
      if (cancelled(picked)) return { kind: "cancel" }
      const template = MemoryStorage.find(env.templates, String(picked))!
      if (template.unavailable) {
        say(`${template.title} can't be used here: ${template.unavailable}.`)
        continue
      }
      return applyTemplate({ ...input, scope, name: template.name })
    }
  }
  return choose(input)
}

async function choose(input: {
  prompts: Prompts
  env: Env
  draft: MemorySetup.Draft
  residency: Residency.Resolved | undefined
  args: Args
}): Promise<Outcome> {
  const { prompts, env } = input
  const cards = MemoryStorage.cards(env.environment)
  for (const card of cards) say(cardText(card).join(EOL) + EOL)
  let initial: string = input.draft.backend.type
  while (true) {
    const where = await prompts.select({
      message: "Where should memory be stored?",
      options: [
        ...cards.map((card) => ({
          value: card.kind as string,
          label: card.title,
          hint: card.unavailable ?? card.recommended ?? card.summary,
        })),
        { value: "compare", label: "Compare", hint: "the options side by side" },
        { value: "help", label: "Help me choose", hint: "two questions" },
      ],
      initialValue: initial,
    })
    if (prompts.isCancel(where)) return { kind: "cancel" }
    if (where === "compare") {
      say(EOL + MemoryStorage.compareLines(env.environment).join(EOL) + EOL)
      continue
    }
    if (where === "help") {
      const who = await prompts.select({
        message: MemoryStorage.HELP_QUESTIONS.who.message,
        options: MemoryStorage.HELP_QUESTIONS.who.options.map((item) => ({ value: item.value, label: item.label })),
      })
      if (prompts.isCancel(who)) return { kind: "cancel" }
      const runs =
        who === "team"
          ? await prompts.select({
              message: MemoryStorage.HELP_QUESTIONS.runs.message,
              options: MemoryStorage.HELP_QUESTIONS.runs.options.map((item) => ({
                value: item.value,
                label: item.label,
              })),
            })
          : "none"
      if (prompts.isCancel(runs)) return { kind: "cancel" }
      const pick = MemoryStorage.choose({ who: who as MemoryStorage.Who, runs: runs as MemoryStorage.Runs })
      say(`Recommended: ${MemoryStorage.label(pick.kind)}. ${pick.reason}`)
      initial = pick.kind
      continue
    }
    const card = cards.find((item) => item.kind === where)!
    if (card.unavailable) {
      say(`${card.title}: ${card.unavailable}.`)
      continue
    }
    if (card.kind === "embedded") {
      const draft = { ...input.draft, backend: { type: "embedded" as const } }
      if (draft.encryption === "off") draft.encryption = "os-keychain"
      return { kind: "ok", draft }
    }
    return database({ ...input, type: card.kind as MemorySetup.Database })
  }
}

/** The database's URL, region and credentials, then "Test connection" before going on. */
async function database(input: {
  prompts: Prompts
  draft: MemorySetup.Draft
  residency: Residency.Resolved | undefined
  type: MemorySetup.Database
  values?: { url?: string; jurisdiction?: string }
  extraEnv?: Record<string, string>
}): Promise<Outcome> {
  const { prompts, type } = input
  const current = input.draft.backend.type === type ? input.draft.backend : undefined
  const field = async (message: string, placeholder: string, initialValue?: string) => {
    const value = await prompts.text({ message, placeholder, initialValue })
    return prompts.isCancel(value) ? undefined : String(value).trim()
  }
  const url = input.values?.url ?? (await field(`${MemoryStorage.label(type)}: URL`, URL_EXAMPLE[type], current?.url))
  if (url === undefined) return { kind: "cancel" }
  const jurisdiction =
    input.values?.jurisdiction ?? (await field('Where it runs (region, e.g. "EU-DE")', "EU-DE", current?.jurisdiction))
  if (jurisdiction === undefined) return { kind: "cancel" }
  const username = await field("Username (a reference)", DEFAULT_USER[type], current?.username ?? DEFAULT_USER[type])
  if (username === undefined) return { kind: "cancel" }
  const password = await field(
    "Password (a reference, never the password)",
    DEFAULT_PASSWORD[type],
    current?.password ?? DEFAULT_PASSWORD[type],
  )
  if (password === undefined) return { kind: "cancel" }
  const backend = { type, url, jurisdiction, username, password }
  const draft = { ...input.draft, backend, encryption: "off" as const }
  const tested = await test({ memory: { backend, encryption: "off" }, residency: input.residency, env: input.extraEnv })
  if (tested.ok) return { kind: "ok", draft }
  // A setting or the residency policy refusing it can't be saved; a connection that failed can.
  if (tested.error.stage === "settings" || tested.error.stage === "residency")
    return { kind: "fail", message: `That database can't be used: ${tested.error.message}` }
  const keep = await prompts.confirm({ message: "Save these settings anyway?", initialValue: false })
  if (prompts.isCancel(keep) || keep !== true) return { kind: "cancel" }
  return { kind: "ok", draft }
}

/** Test connection: print what happened, in XCOD-263's shape (stage, message, fix). */
export async function test(input: {
  memory: Record<string, unknown>
  residency: Residency.Resolved | undefined
  env?: Record<string, string>
}) {
  say("Testing the connection (connect, write, read and delete a probe)…")
  const MemoryTemplate = await templates()
  const MemoryExternal = await external()
  const resolved = await MemoryTemplate.resolve(input.memory, input.env)
  const result = await MemoryExternal.probe({ memory: resolved as ConfigMemory.Info, residency: input.residency })
  if (result.ok) {
    say(`✓ Connected to ${result.server}: wrote, read and deleted a probe (${(result.ms / 1000).toFixed(1)} s).`)
    for (const warning of result.warnings) say(`  Warning: ${warning}.`)
  } else {
    say(`✗ ${result.error.stage}: ${result.error.message}`)
    if (result.error.fix) say(`  ${result.error.fix}`)
  }
  return result
}

async function applyTemplate(input: {
  prompts: Prompts
  env: Env
  draft: MemorySetup.Draft
  residency: Residency.Resolved | undefined
  worktree: string
  args: Args
  scope: MemoryTemplate.Scope
  name: string
}): Promise<Outcome> {
  const { prompts, env, args, scope } = input
  const MemoryTemplate = await templates()
  const interactive = !args.yes
  const template = MemoryStorage.find(env.templates, input.name)
  if (!template)
    return {
      kind: "fail",
      message: `No memory template named "${input.name}". See them with: lunos memory templates`,
    }
  if (template.unavailable)
    return { kind: "fail", message: `${template.title} can't be used here: ${template.unavailable}` }
  say(`${template.title}${template.description ? `: ${template.description}` : ""}`)
  say(`Leaves the computer: ${template.leaves}.`)

  const values: MemoryTemplate.Values = {}
  if (template.requires?.includes("local-model")) {
    const models = env.environment.localModels
    if (interactive && models.length > 1) {
      const picked = await prompts.select({
        message: "Which local model extracts facts?",
        options: models.map((model) => ({ value: model, label: model })),
      })
      if (prompts.isCancel(picked)) return { kind: "cancel" }
      values.localModel = String(picked)
    } else values.localModel = models[0]
  }
  if (template.ask?.length) {
    const vendor = args.vendor ?? (interactive ? undefined : "")
    let type = vendor as MemorySetup.Database | undefined
    if (type === undefined) {
      const picked = await prompts.select({
        message: "Which database?",
        options: [
          { value: "postgres", label: "PostgreSQL" },
          { value: "neo4j", label: "Neo4j" },
        ],
      })
      if (prompts.isCancel(picked)) return { kind: "cancel" }
      type = picked as MemorySetup.Database
    }
    if (type !== "neo4j" && type !== "postgres")
      return { kind: "fail", message: `${template.title} needs --vendor neo4j or --vendor postgres` }
    if (!interactive && (!args.url || !args.jurisdiction))
      return { kind: "fail", message: `${template.title} needs --url and --jurisdiction with --yes` }
    const memory = MemoryStorage.memoryOf(template, { vendor: type })
    const draft = MemorySetup.apply(input.draft, memory)
    if (!interactive) {
      const backend = {
        type,
        url: args.url!,
        jurisdiction: args.jurisdiction!,
        username: DEFAULT_USER[type],
        password: DEFAULT_PASSWORD[type],
      }
      const tested = await test({ memory: { backend, encryption: "off" }, residency: input.residency })
      if (!tested.ok && (tested.error.stage === "settings" || tested.error.stage === "residency"))
        return { kind: "fail", message: `That database can't be used: ${tested.error.message}` }
      return { kind: "ok", draft: { ...draft, backend, encryption: "off" } }
    }
    return database({
      prompts,
      draft,
      residency: input.residency,
      type,
      values: { url: args.url, jurisdiction: args.jurisdiction },
    })
  }

  const memory = MemoryStorage.memoryOf(template, values)
  const draft = MemorySetup.apply(input.draft, memory)
  if (!template.compose) return { kind: "ok", draft }

  // A Docker template: preview everything, write after confirming, start only when asked.
  const preview = await MemoryTemplate.plan({
    template,
    scope,
    worktree: input.worktree,
    docker: env.environment.docker,
    reveal: false,
  })
  say(`${EOL}These files would be written to ${preview.dir}:`)
  for (const file of preview.files) {
    say(`${EOL}── ${file.path}${file.exists ? " (exists)" : ""}${file.mode ? " (permissions 0600)" : ""}`)
    say(file.content.trimEnd())
  }
  say(`${EOL}── memory config (${scope} config; credentials as {env:} references only)`)
  say(JSON.stringify(memory, null, 2))
  if (template.licence) say(`${EOL}${template.licence}`)
  const existing = preview.files.filter((file) => file.exists).map((file) => file.name)
  let overwrite: string[] = []
  if (existing.length) {
    if (!interactive)
      return {
        kind: "fail",
        message: `${existing.join(", ")} already exist${existing.length === 1 ? "s" : ""} in ${preview.dir}; nothing was written. Run without --yes to choose whether to replace them`,
      }
    const replace = await prompts.confirm({
      message: `${existing.join(", ")} already exist${existing.length === 1 ? "s" : ""}. Replace ${existing.length === 1 ? "it" : "them"}?`,
      initialValue: false,
    })
    if (prompts.isCancel(replace) || replace !== true) return { kind: "cancel" }
    overwrite = existing
  } else if (interactive) {
    const ok = await prompts.confirm({ message: `Write these files to ${preview.dir}?`, initialValue: true })
    if (prompts.isCancel(ok) || ok !== true) return { kind: "cancel" }
  }
  const plan = await MemoryTemplate.plan({ template, scope, worktree: input.worktree, docker: env.environment.docker })
  try {
    await MemoryTemplate.write(plan, overwrite)
  } catch (error) {
    return { kind: "fail", message: error instanceof Error ? error.message : String(error) }
  }
  say(`Wrote ${plan.files.map((file) => file.name).join(", ")} to ${plan.dir}.`)

  let start = !!args.start
  if (interactive) {
    const now = await prompts.select({
      message: `Start the database now? This runs: ${plan.command}`,
      options: [
        { value: "now", label: "Start it now", hint: "waits for it to be healthy, up to 2 minutes" },
        { value: "later", label: "I'll start it myself", hint: "shows the command to copy" },
      ],
    })
    if (prompts.isCancel(now)) return { kind: "cancel" }
    start = now === "now"
  }
  if (!start) say(`Start it with:${EOL}  ${plan.command}`)
  else {
    say(`Running: ${plan.command}`)
    let last = ""
    const started = await MemoryTemplate.start(plan, {
      onProgress: (status, ms) => {
        if (status === last) return
        last = status
        say(`  ${status} (${Math.round(ms / 1000)} s)`)
      },
    })
    if (!started.ok) {
      say(`✗ ${started.stage}: ${started.message}`)
      if (started.fix) say(`  ${started.fix}`)
      return { kind: "fail", message: "The database didn't start; nothing was saved" }
    }
    say(`✓ The database is healthy (${(started.ms / 1000).toFixed(1)} s).`)
  }
  const vars = Object.keys(template.env ?? {}).filter((key) => JSON.stringify(memory).includes(`{env:${key}}`))
  say(
    `Lunos reads ${vars.join(" and ")} from the environment. Before starting Lunos, load them, e.g.:${EOL}  set -a; . ${plan.dir}/.env; set +a`,
  )
  return {
    kind: "ok",
    draft,
    ...(start ? { template: { name: template.name, scope, env: await MemoryTemplate.env(plan.dir) } } : {}),
  }
}

/** `lunos memory templates`: the templates `lunos memory setup --template` accepts. */
export const MemoryTemplatesCommand = effectCmd({
  command: "templates",
  describe: "list the memory setup templates (lunos memory setup --template <name>)",
  builder: (yargs) => yargs.option("json", { type: "boolean", describe: "print them as JSON" }),
  handler: Effect.fn("Cli.memory.templates")(function* (args: { json?: boolean }) {
    const { MemorySetupEnv } = yield* Effect.promise(() => import("@/memory/setup-env"))
    const { templates } = yield* MemorySetupEnv.environment()
    if (args.json) return yield* writeStdoutEffect(JSON.stringify(templates, null, 2) + EOL)
    const lines = templates.flatMap((item) => [
      `${item.name.padEnd(16)} ${item.title}${item.organisation ? " (your organisation)" : ""}${item.unavailable ? ` — can't be used: ${item.unavailable}` : ""}`,
      `${"".padEnd(16)} leaves the computer: ${item.leaves}`,
    ])
    yield* writeStdoutEffect(lines.join(EOL) + EOL)
  }),
})
