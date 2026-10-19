import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import { Filesystem } from "@/util/filesystem"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "../../../src/config/tui"

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

// Backs the tabbed Discover view: one listing across all four kinds, and plan/install for the
// config kinds going through the same planner as the CLI.
const manifest = {
  name: "demo-marketplace",
  owner: { name: "Demo" },
  plugins: [{ name: "weather-widget", source: { type: "npm", package: "opencode-weather-widget" } }],
  skills: [{ name: "team-skills", url: "http://127.0.0.1:9/skills/" }],
  hooks: [
    { name: "fmt", event: "tool.execute.after", command: ["prettier", "--write", "."], matcher: { tool: "edit" } },
    { name: "future", event: "session.someday", command: ["true"] },
  ],
  mcp: [{ name: "docs", type: "remote", url: "https://example.test/mcp" }],
}

async function withRuntime(fn: () => Promise<void>) {
  await using tmp = await tmpdir()
  await fs.mkdir(path.join(tmp.path, ".opencode"), { recursive: true })
  await Bun.write(
    path.join(tmp.path, ".opencode", "opencode.json"),
    JSON.stringify({ marketplace: [tmp.path], marketplace_default: false }),
  )
  await Bun.write(path.join(tmp.path, "marketplace.json"), JSON.stringify(manifest))
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const api = createTuiPluginApi({
    state: {
      path: {
        state: path.join(tmp.path, "state.json"),
        config: path.join(tmp.path, "tui.json"),
        worktree: tmp.path,
        directory: tmp.path,
      },
    },
  })
  // Global config is shared by the whole test process, and install writes to whichever of these
  // already exists. Snapshot both and restore them, rather than deleting files other tests made.
  const candidates = ["opencode.json", "opencode.jsonc"].map((file) => path.join(Global.Path.config, file))
  const saved = await Promise.all(candidates.map((file) => Filesystem.readText(file).catch(() => undefined)))
  await Promise.all(candidates.map((file) => fs.rm(file, { force: true })))
  try {
    await TuiPluginRuntime.init({ api, config: createTuiResolvedConfig({ plugin: [] }) })
    await fn()
  } finally {
    await TuiPluginRuntime.dispose()
    await Promise.all(
      candidates.map((file, i) =>
        saved[i] === undefined ? fs.rm(file, { force: true }) : Filesystem.write(file, saved[i]!),
      ),
    )
    cwd.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
}

test("lists every content kind, each tagged, with a spec only on plugins", async () => {
  await withRuntime(async () => {
    const result = await TuiPluginRuntime.discoverMarketplace()
    const kinds = result.items.map((item) => `${item.kind}:${item.name}`)
    expect(kinds).toEqual(["plugin:weather-widget", "skill:team-skills", "hook:fmt", "hook:future", "mcp:docs"])
    expect(result.items.find((item) => item.kind === "plugin")?.spec).toBe("opencode-weather-widget")
    expect(result.items.find((item) => item.kind === "hook")).not.toHaveProperty("spec")
    expect((await TuiPluginRuntime.discoverMarketplace("mcp")).items.map((item) => item.name)).toEqual(["docs"])
  })
})

test("plans a hook with what it runs, then installs it into global config", async () => {
  await withRuntime(async () => {
    const plan = await TuiPluginRuntime.planMarketplace("hook", "demo-marketplace", "fmt")
    expect(plan).toMatchObject({
      ok: true,
      details: ["on: tool.execute.after (tool edit)", "runs: prettier --write ."],
    })
    const out = await TuiPluginRuntime.installMarketplace("hook", "demo-marketplace", "fmt")
    if (!out.ok) throw new Error(out.message)
    const config = parseJsonc(await Filesystem.readText(out.configPath))
    expect(config.hooks["tool.execute.after"]).toEqual([
      { command: ["prettier", "--write", "."], matcher: { tool: "edit" } },
    ])
  })
})

test("a refused entry comes back as ok:false with the reason, and writes nothing", async () => {
  await withRuntime(async () => {
    const plan = await TuiPluginRuntime.planMarketplace("hook", "demo-marketplace", "future")
    expect(plan).toMatchObject({ ok: false })
    expect(plan.ok ? "" : plan.message).toContain("does not dispatch")
    const out = await TuiPluginRuntime.installMarketplace("hook", "demo-marketplace", "future")
    expect(out.ok).toBe(false)
    for (const file of ["opencode.json", "opencode.jsonc"])
      expect(await Filesystem.exists(path.join(Global.Path.config, file))).toBe(false)
  })
})
