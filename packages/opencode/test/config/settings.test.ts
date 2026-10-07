// XCOD-128: the settings list is generated from the live schema, and writes go through the same
// decode the config loader uses, with organisation locks and JSONC comments respected.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { existsSync } from "fs"
import os from "os"
import path from "path"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Global } from "@opencode-ai/core/global"
import { ConfigSettings } from "@/config/settings"
import { ConfigPolicy } from "@/config/policy"

let root: string
let previous: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-settings-"))
  previous = Global.Path.config
  ;(Global.Path as { config: string }).config = path.join(root, "user")
  await fs.mkdir(path.join(root, "user"), { recursive: true })
  await fs.mkdir(path.join(root, "project"), { recursive: true })
})

afterEach(async () => {
  ;(Global.Path as { config: string }).config = previous
  await fs.rm(root, { recursive: true, force: true })
})

const ctx = () => ({ directory: path.join(root, "project") })
const userFile = () => path.join(root, "user", "opencode.json")
const read = (file: string) => fs.readFile(file, "utf8")

describe("settings registry", () => {
  test("every top-level ConfigV1.Info key has an entry and a category", () => {
    const keys = Object.keys(ConfigV1.Info.fields)
    const classified = Object.keys(ConfigSettings.CATEGORY)
    // A new schema key fails here until it's given a category in ConfigSettings.CATEGORY.
    expect(keys.filter((key) => !classified.includes(key))).toEqual([])
    expect(classified.filter((key) => !keys.includes(key))).toEqual([])
    const entries = ConfigSettings.entries()
    for (const key of keys) {
      const item = entries.find((entry) => entry.key === key)
      expect(item, key).toBeDefined()
      // Reachable: editable in place, through an existing dialog, or in the file.
      expect(["boolean", "enum", "string", "number", "list", "object"]).toContain(item!.kind)
    }
  })

  test("nested scalar leaves are generated from the schema", () => {
    const keys = ConfigSettings.entries().map((entry) => entry.key)
    expect(keys).toContain("compaction.auto")
    expect(keys).toContain("memory.enabled")
    expect(keys).toContain("residency.allow")
    expect(keys).toContain("tui.theme")
  })

  test("types come from the schema", () => {
    expect(ConfigSettings.find("share")).toMatchObject({ kind: "enum", values: ["manual", "auto", "disabled"] })
    expect(ConfigSettings.find("autoupdate")).toMatchObject({ kind: "enum", values: [true, false, "notify"] })
    expect(ConfigSettings.find("snapshot")?.kind).toBe("boolean")
    expect(ConfigSettings.find("subagent_depth")?.kind).toBe("number")
    expect(ConfigSettings.find("model")).toMatchObject({ kind: "string", dialog: "models" })
    expect(ConfigSettings.find("theme")).toMatchObject({ key: "tui.theme", dialog: "themes", restart: false })
    expect(ConfigSettings.find("mcp")).toMatchObject({ kind: "object", dialog: "mcps", restart: true })
    expect(ConfigSettings.find("plugin")?.restart).toBe(true)
  })

  test("every category is one of the ticket's", () => {
    for (const entry of ConfigSettings.entries()) expect(ConfigSettings.CATEGORIES).toContain(entry.category)
  })
})

describe("settings set", () => {
  test("writes the user config and keeps its comments", async () => {
    await fs.writeFile(userFile(), '{\n  // keep me\n  "$schema": "https://lunos.tech/config.json"\n}\n')
    const result = await ConfigSettings.set({ key: "share", value: "disabled", scope: "user", ctx: ctx(), locked: [] })
    expect(result.file).toBe(userFile())
    const text = await read(userFile())
    expect(text).toContain("// keep me")
    expect(text).toContain('"share": "disabled"')
  })

  test("--project lands in .opencode/opencode.json", async () => {
    const result = await ConfigSettings.set({
      key: "compaction.auto",
      value: "false",
      scope: "project",
      ctx: ctx(),
      locked: [],
    })
    expect(result.file).toBe(path.join(root, "project", ".opencode", "opencode.json"))
    expect(JSON.parse(await read(result.file))).toMatchObject({ compaction: { auto: false } })
  })

  // XCOD-158: a repository's config is ignored for these, so a project write is refused, not lost.
  test("sandbox settings a repository can't choose are refused in project config, and saved in yours", async () => {
    const project = path.join(root, "project", ".opencode", "opencode.json")
    for (const [key, value] of [
      ["sandbox.workspace", "mount"],
      ["sandbox.devcontainer", "build"],
      ["sandbox.network", "open"],
    ] as const) {
      await expect(ConfigSettings.set({ key, value, scope: "project", ctx: ctx(), locked: [] })).rejects.toThrow(
        `${key} can't be set in project config`,
      )
    }
    expect(existsSync(project)).toBe(false)
    // What a repository may do: make it stricter, or turn its devcontainer off.
    for (const [key, value] of [
      ["sandbox.workspace", "copy"],
      ["sandbox.devcontainer", "off"],
      ["sandbox.network", "none"],
    ] as const)
      await ConfigSettings.set({ key, value, scope: "project", ctx: ctx(), locked: [] })
    expect(JSON.parse(await read(project))).toMatchObject({
      sandbox: { workspace: "copy", devcontainer: "off", network: "none" },
    })
    const mine = await ConfigSettings.set({
      key: "sandbox.workspace",
      value: "mount",
      scope: "user",
      ctx: ctx(),
      locked: [],
    })
    expect(JSON.parse(await read(mine.file))).toMatchObject({ sandbox: { workspace: "mount" } })
    // A list of objects is set whole, as JSON, and checked against the schema.
    const mounts = '[{ "source": "/srv/cache", "target": "/cache" }]'
    await expect(
      ConfigSettings.set({ key: "sandbox.mounts", value: mounts, scope: "project", ctx: ctx(), locked: [] }),
    ).rejects.toThrow("sandbox.mounts can't be set in project config")
    await ConfigSettings.set({ key: "sandbox.mounts", value: mounts, scope: "user", ctx: ctx(), locked: [] })
    expect(JSON.parse(await read(mine.file)).sandbox.mounts).toEqual([{ source: "/srv/cache", target: "/cache" }])
    await expect(
      ConfigSettings.set({ key: "sandbox.mounts", value: '[{ "target": 1 }]', scope: "user", ctx: ctx(), locked: [] }),
    ).rejects.toThrow("Invalid value for sandbox.mounts")
  })

  test("an invalid enum value lists the allowed values and writes nothing", async () => {
    const before = '{\n  // untouched\n  "autoupdate": "notify"\n}\n'
    await fs.writeFile(userFile(), before)
    const attempt = ConfigSettings.set({ key: "autoupdate", value: "sometimes", scope: "user", ctx: ctx(), locked: [] })
    await expect(attempt).rejects.toThrow("Allowed values: true, false, notify")
    expect(await read(userFile())).toBe(before)
  })

  test("a value the schema rejects is refused and nothing is written", async () => {
    await expect(
      ConfigSettings.set({ key: "subagent_depth", value: "-1", scope: "user", ctx: ctx(), locked: [] }),
    ).rejects.toThrow("Invalid value for subagent_depth")
    expect(existsSync(userFile())).toBe(false)
  })

  test("unknown keys are refused", async () => {
    await expect(
      ConfigSettings.set({ key: "compaction.autoo", value: "true", scope: "user", ctx: ctx(), locked: [] }),
    ).rejects.toThrow('Unknown setting "compaction.autoo"')
  })

  test("a locked key is refused with the policy message, and the refusal is recorded", async () => {
    const seen: string[] = []
    const off = ConfigPolicy.onRefused((refusal) => seen.push(refusal.key))
    await expect(
      ConfigSettings.set({ key: "share", value: "auto", scope: "user", ctx: ctx(), locked: ["share"] }),
    ).rejects.toThrow(ConfigPolicy.message("share"))
    off()
    expect(seen).toEqual(["share"])
    expect(existsSync(userFile())).toBe(false)
  })

  test("a parent whose subtree is locked is refused too", async () => {
    await expect(
      ConfigSettings.set({
        key: "audit",
        value: '{"enabled":false}',
        scope: "user",
        ctx: ctx(),
        locked: ["audit.enabled"],
      }),
    ).rejects.toThrow(ConfigPolicy.message("audit.enabled"))
    await expect(
      ConfigSettings.set({ key: "memory.enabled", value: "true", scope: "user", ctx: ctx(), locked: ["memory"] }),
    ).rejects.toThrow(ConfigPolicy.message("memory"))
  })

  test("$locked can't be written from settings", async () => {
    await expect(
      ConfigSettings.set({ key: "$locked", value: "share", scope: "user", ctx: ctx(), locked: [] }),
    ).rejects.toThrow("only read from managed config")
  })

  test("the theme goes to tui.json, not opencode.json", async () => {
    const result = await ConfigSettings.set({
      key: "theme",
      value: "tokyonight",
      scope: "user",
      ctx: ctx(),
      locked: [],
    })
    expect(result.file).toBe(path.join(root, "user", "tui.json"))
    expect(JSON.parse(await read(result.file)).theme).toBe("tokyonight")
  })

  test("lists accept comma-separated values and check literals", async () => {
    const result = await ConfigSettings.set({
      key: "residency.allow",
      value: "eu, us",
      scope: "user",
      ctx: ctx(),
      locked: [],
    })
    expect(result.value).toEqual(["eu", "us"])
    await expect(
      ConfigSettings.set({ key: "residency.allow", value: "mars", scope: "user", ctx: ctx(), locked: [] }),
    ).rejects.toThrow("Allowed values: eu, us, other, configurable, unknown")
  })
})

describe("settings list", () => {
  test("source badges follow the config layers, and locks win", async () => {
    const rows = await ConfigSettings.list({
      config: { share: "manual", autoupdate: "notify", $locked: ["share"] },
      origins: {
        share: { layer: "managed", source: "/managed/managed.json" },
        autoupdate: { layer: "global", source: Global.Path.config },
      },
      locked: ["share"],
      ctx: ctx(),
      env: {},
    })
    const row = (key: string) => rows.find((item) => item.key === key)!
    expect(row("share")).toMatchObject({ source: "managed", locked: true, value: "manual" })
    expect(row("autoupdate")).toMatchObject({ source: "user", locked: false, value: "notify" })
    expect(row("snapshot")).toMatchObject({ source: "default", value: true })
  })

  test("an environment override is shown and explained", async () => {
    const rows = await ConfigSettings.list({
      config: { memory: { enabled: true } },
      origins: { memory: { layer: "global", source: Global.Path.config } },
      locked: [],
      ctx: ctx(),
      env: { LUNOS_DISABLE_MEMORY: "1" },
    })
    const row = rows.find((item) => item.key === "memory.enabled")!
    expect(row.source).toBe("env")
    expect(row.override).toContain("LUNOS_DISABLE_MEMORY")
  })

  test("secrets are masked and {env:} references are shown as written", async () => {
    await fs.writeFile(
      userFile(),
      JSON.stringify({
        provider: { acme: { options: { apiKey: "{env:ACME_KEY}" } } },
        enterprise: { url: "{env:ENT}" },
      }),
    )
    const rows = await ConfigSettings.list({
      config: {
        provider: { acme: { options: { apiKey: "sk-real-secret" } } },
        enterprise: { url: "https://resolved.example" },
      },
      origins: {
        provider: { layer: "global", source: Global.Path.config },
        enterprise: { layer: "global", source: Global.Path.config },
      },
      locked: [],
      ctx: ctx(),
      env: {},
    })
    expect(JSON.stringify(rows)).not.toContain("sk-real-secret")
    expect(rows.find((item) => item.key === "enterprise.url")!.value).toBe("{env:ENT}")
  })
})

// XCOD-214: model-valued settings are checked against the models available here, with suggestions.
describe("model settings", () => {
  const models = new Set(["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5", "mistral/mistral-large"])

  test("a known model, inherit and small are accepted; an unknown one gets the closest matches", () => {
    expect(ConfigSettings.modelProblem("subagent.model", "anthropic/claude-haiku-4-5", models)).toBeUndefined()
    expect(ConfigSettings.modelProblem("subagent.model", "inherit", models)).toBeUndefined()
    expect(ConfigSettings.modelProblem("subagent.model", "small", models)).toBeUndefined()
    expect(ConfigSettings.modelProblem("model", "inherit", models)).toContain(`"inherit" isn't a model`)
    const problem = ConfigSettings.modelProblem("subagent.model", "anthropic/claude-haiku-45", models)
    expect(problem).toContain(`Did you mean "anthropic/claude-haiku-4-5"`)
    // A key that doesn't name a model isn't checked.
    expect(ConfigSettings.modelProblem("share", "anything", models)).toBeUndefined()
  })

  test("a model the residency policy blocks is refused with the policy's reason (XCOD-212)", () => {
    const blocked = new Map([["anthropic/claude-haiku-4-5", 'Provider "anthropic" processes in "us".']])
    for (const key of ["model", "small_model", "subagent.model"])
      expect(ConfigSettings.modelProblem(key, "anthropic/claude-haiku-4-5", models, blocked)).toBe(
        `"anthropic/claude-haiku-4-5" is blocked by the data-residency policy. Provider "anthropic" processes in "us"`,
      )
    expect(
      ConfigSettings.modelProblem(
        "subagent.dynamic.allow",
        ["mistral/mistral-large", "anthropic/claude-haiku-4-5"],
        models,
        blocked,
      ),
    ).toContain("blocked by the data-residency policy")
    expect(ConfigSettings.modelProblem("subagent.model", "inherit", models, blocked)).toBeUndefined()
  })

  test("every entry of subagent.dynamic.allow is checked", () => {
    expect(ConfigSettings.modelProblem("subagent.dynamic.allow", [...models], models)).toBeUndefined()
    expect(ConfigSettings.modelProblem("subagent.dynamic.allow", ["mistral/mistral-large", "x/y"], models)).toContain(
      `"x/y" isn't a model`,
    )
  })

  test("set refuses an unknown model and writes nothing; a known one is saved", async () => {
    await expect(
      ConfigSettings.set({
        key: "subagent.model",
        value: "anthropic/claude-haiku-45",
        scope: "user",
        ctx: ctx(),
        locked: [],
        models,
      }),
    ).rejects.toThrow("Nothing was written")
    expect(existsSync(userFile())).toBe(false)
    await ConfigSettings.set({
      key: "subagent.dynamic.allow",
      value: JSON.stringify(["anthropic/claude-haiku-4-5", "mistral/mistral-large"]),
      scope: "user",
      ctx: ctx(),
      locked: [],
      models,
    })
    expect(JSON.parse(await read(userFile())).subagent.dynamic.allow).toEqual([
      "anthropic/claude-haiku-4-5",
      "mistral/mistral-large",
    ])
  })

  test("the subagent model settings open the model picker", () => {
    const entries = ConfigSettings.entries()
    expect(entries.find((item) => item.key === "subagent.model")?.dialog).toBe("models")
    expect(entries.find((item) => item.key === "subagent.dynamic.allow")?.dialog).toBe("models")
  })
})

describe("agent settings (XCOD-215)", () => {
  const models = new Set(["mistral/mistral-large"])
  const write = (doc: unknown) =>
    fs
      .mkdir(path.dirname(userFile()), { recursive: true })
      .then(() => fs.writeFile(userFile(), JSON.stringify(doc, null, 2)))

  test("agent.<name>.<field> keys exist for the editable fields, and not for anything else", () => {
    expect(ConfigSettings.find("agent.build.steps")?.kind).toBe("number")
    expect(ConfigSettings.find("agent.build.disable")?.kind).toBe("boolean")
    expect(ConfigSettings.find("agent.build.mode")?.values).toEqual(["subagent", "primary", "all"])
    expect(ConfigSettings.find("agent.build.model")?.dialog).toBe("models")
    expect(ConfigSettings.find("agent.build.maxSteps")).toBeUndefined()
    expect(ConfigSettings.find("agent.build.nonsense")).toBeUndefined()
    expect(ConfigSettings.find("agent.bad name.steps")).toBeUndefined()
  })

  test("set writes agent.<name>.<field>, checks the model and the ranges", async () => {
    await ConfigSettings.set({ key: "agent.build.steps", value: "20", scope: "user", ctx: ctx(), locked: [], models })
    await ConfigSettings.set({ key: "agent.qa.model", value: "small", scope: "user", ctx: ctx(), locked: [], models })
    expect(JSON.parse(await read(userFile())).agent).toEqual({ build: { steps: 20 }, qa: { model: "small" } })
    await expect(
      ConfigSettings.set({
        key: "agent.build.temperature",
        value: "2.5",
        scope: "user",
        ctx: ctx(),
        locked: [],
        models,
      }),
    ).rejects.toThrow("between 0 and 2")
    await expect(
      ConfigSettings.set({ key: "agent.build.model", value: "x/y", scope: "user", ctx: ctx(), locked: [], models }),
    ).rejects.toThrow(`"x/y" isn't a model`)
  })

  test("an agent's model blocked by the residency policy is refused (XCOD-212 + XCOD-215)", () => {
    const blocked = new Map([["anthropic/claude-haiku-4-5", 'Provider "anthropic" processes in "us".']])
    const all = new Set(["anthropic/claude-haiku-4-5", "mistral/mistral-large"])
    expect(ConfigSettings.modelProblem("agent.build.model", "anthropic/claude-haiku-4-5", all, blocked)).toContain(
      "blocked by the data-residency policy",
    )
    expect(ConfigSettings.modelProblem("agent.build.model", "mistral/mistral-large", all, blocked)).toBeUndefined()
    expect(ConfigSettings.modelProblem("agent.build.model", "inherit", all, blocked)).toBeUndefined()
  })

  test("a locked agent key is refused with the policy message (existing rule)", async () => {
    await expect(
      ConfigSettings.set({
        key: "agent.build.model",
        value: "inherit",
        scope: "user",
        ctx: ctx(),
        locked: ["agent.build"],
      }),
    ).rejects.toThrow()
  })

  test("unset removes the key, and an object it leaves empty", async () => {
    await write({ agent: { build: { steps: 20 }, plan: { steps: 5, disable: true } } })
    const result = await ConfigSettings.unset({ key: "agent.build.steps", scope: "user", ctx: ctx(), locked: [] })
    expect(result.changed).toBe(true)
    await ConfigSettings.unset({ key: "agent.plan.steps", scope: "user", ctx: ctx(), locked: [] })
    expect(JSON.parse(await read(userFile())).agent).toEqual({ plan: { disable: true } })
    const again = await ConfigSettings.unset({ key: "agent.build.steps", scope: "user", ctx: ctx(), locked: [] })
    expect(again.changed).toBe(false)
    await ConfigSettings.unset({ key: "agent.plan", scope: "user", ctx: ctx(), locked: [] })
    expect(JSON.parse(await read(userFile())).agent).toBeUndefined()
  })

  test("migrating deprecated keys keeps every value, and a value already on the new key wins", async () => {
    await write({
      mode: { build: { temperature: 0.2 }, review: { description: "Reviews" } },
      agent: {
        build: { steps: 9, maxSteps: 30, tools: { bash: false, write: true } },
        plan: { maxSteps: 12, tools: { webfetch: false }, permission: { webfetch: "allow" } },
      },
    })
    expect(ConfigSettings.deprecatedAgentKeys(JSON.parse(await read(userFile())))).toEqual([
      "mode",
      "agent.build.tools",
      "agent.build.maxSteps",
      "agent.plan.tools",
      "agent.plan.maxSteps",
    ])
    const result = await ConfigSettings.migrateAgents({ scope: "user", ctx: ctx(), locked: [] })
    expect(result.migrated.length).toBe(5)
    const doc = JSON.parse(await read(userFile()))
    expect(doc.mode).toBeUndefined()
    expect(doc.agent).toEqual({
      build: { temperature: 0.2, steps: 9, permission: { bash: "deny", edit: "allow" } },
      plan: { steps: 12, permission: { webfetch: "allow" } },
      review: { description: "Reviews" },
    })
    expect((await ConfigSettings.migrateAgents({ scope: "user", ctx: ctx(), locked: [] })).migrated).toEqual([])
  })
})
