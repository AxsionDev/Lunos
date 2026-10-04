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
