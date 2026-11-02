export * as AgentEditHere from "./edit-here"

import fs from "node:fs/promises"
import path from "node:path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Schema } from "effect"
import { Config } from "@/config/config"
import * as InstanceState from "@/effect/instance-state"
import { Provider } from "@/provider/provider"
import { Skill } from "@/skill"
import { ToolRegistry } from "@/tool/registry"
import { sanitize } from "@/mcp/catalog"
import { AgentEdit } from "./edit"
import { AgentFile } from "./file"

/**
 * XCOD-210: what an agent is checked against on save (the models, tools, skills and MCP servers
 * available here), and the save itself. `lunos agent edit` and the TUI's /agents screen (through
 * the config API) both save through `save`, so they refuse the same things.
 */

export const known = Effect.fn("AgentEditHere.known")(function* () {
  const config = yield* Config.Service.use((cfg) => cfg.get())
  const providers = yield* Provider.Service.use((svc) => svc.list())
  return {
    models: new Set(
      Object.entries(providers).flatMap(([provider, info]) =>
        Object.keys(info.models).map((model) => `${provider}/${model}`),
      ),
    ),
    tools: new Set(yield* ToolRegistry.Service.use((svc) => svc.ids())),
    skills: new Set((yield* Skill.Service.use((svc) => svc.all())).map((skill) => skill.name)),
    mcp: new Set(Object.keys(config.mcp ?? {}).map(sanitize)),
  } satisfies AgentEdit.Known
})

/**
 * The file that defines agent `name` here, if it's one Lunos can edit. The loaded config's
 * directories, plus any project `.opencode` folder that exists now: one created since Lunos
 * started (a project's first `.opencode/agents/`) isn't in the loaded list yet.
 */
export const file = Effect.fn("AgentEditHere.file")(function* (name: string) {
  const ctx = yield* InstanceState.context
  const loaded = yield* Config.Service.use((cfg) => cfg.directories())
  const directories = yield* Effect.promise(async () => {
    const found: string[] = []
    if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return loaded
    const stop = path.resolve(ctx.worktree)
    for (let dir = path.resolve(ctx.directory); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, ".opencode")
      if (
        await fs.stat(candidate).then(
          (stat) => stat.isDirectory(),
          () => false,
        )
      )
        found.unshift(candidate)
      if (dir === stop || dir === path.dirname(dir)) break
    }
    // The loaded order puts the closest folder last (it wins); new folders slot in the same way.
    return [...new Set([...loaded, ...found])]
  })
  return yield* Effect.promise(() => AgentFile.locate(directories, name))
})

export type Saved = { ok: true; file: string } | { ok: false; problems: string[] }

/** Writes `doc` to the agent's file if it validates; otherwise lists every problem, writing nothing. */
export const save = Effect.fn("AgentEditHere.save")(function* (target: string, doc: AgentFile.Doc) {
  const problems = AgentEdit.validate(doc, yield* known())
  if (problems.length) return { ok: false, problems } satisfies Saved
  yield* Effect.promise(() => fs.writeFile(target, AgentFile.render(doc)))
  return { ok: true, file: target } satisfies Saved
})

/** `save` for the text of an edited file, which may not parse at all. */
export const saveText = Effect.fn("AgentEditHere.saveText")(function* (target: string, text: string) {
  let doc: AgentFile.Doc
  try {
    doc = AgentFile.parse(text)
  } catch (error) {
    return {
      ok: false,
      problems: [`the file can't be read: ${error instanceof Error ? error.message : String(error)}`],
    } satisfies Saved
  }
  return yield* save(target, doc)
})

/** XCOD-215: Lunos's own agents, for ones turned off with `disable` (they're no longer listed). */
const BUILT_IN = new Set(["build", "plan", "research", "dev-cycle", "general", "explore", "architect", "planner", "qa"])
/** Hidden helpers that name sessions, summarise and compact long context. */
const HELPERS = new Set(["compaction", "title", "summary"])

export const helper = (name: string) => HELPERS.has(name)
export const builtIn = (name: string) => BUILT_IN.has(name) || HELPERS.has(name)

// The config API's shapes for the TUI's /agents screen.

export const AgentEntry = Schema.Struct({
  name: Schema.String,
  mode: Schema.String,
  description: Schema.optional(Schema.String),
  hidden: Schema.optional(Schema.Boolean),
  native: Schema.Boolean,
  /** The agent's file, when Lunos can edit it; with its current text. */
  file: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  /** XCOD-215: what /settings → Agents shows. main = primary, helper = a hidden built-in primary. */
  kind: Schema.optional(Schema.Literals(["main", "subagent", "helper"])),
  disabled: Schema.optional(Schema.Boolean),
  /** Raw `agent.<name>.model`: "inherit", "small" or "provider/model"; absent means it inherits. */
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  topP: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  /** Each scope's own overrides for this agent (`agent.<name>` in that file), and its deprecated keys. */
  overrides: Schema.optional(
    Schema.Struct({
      user: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
      project: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    }),
  ),
}).annotate({ identifier: "AgentFileEntry" })

export const AgentList = Schema.Array(AgentEntry).annotate({ identifier: "AgentFileList" })

export const SaveInput = Schema.Struct({ name: Schema.String, text: Schema.String }).annotate({
  identifier: "AgentSaveInput",
})

export const SaveOutput = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), file: Schema.String }),
  Schema.Struct({ ok: Schema.Literal(false), problems: Schema.Array(Schema.String) }),
]).annotate({ identifier: "AgentSaveOutput" })
