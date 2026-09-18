import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import { createTuiPluginApi } from "../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TuiConfig } from "../../../src/config/tui"

const { TuiPluginRuntime } = await import("../../../src/plugin/tui/runtime")

const manifest = {
  name: "demo-marketplace",
  owner: { name: "Demo" },
  plugins: [
    {
      name: "weather-widget",
      description: "Shows the weather in the status bar",
      source: { type: "npm", package: "opencode-weather-widget", version: "1.2.0" },
    },
  ],
}

test("discovers plugins from a locally added marketplace", async () => {
  await using tmp = await tmpdir()
  await fs.mkdir(path.join(tmp.path, ".opencode"), { recursive: true })
  await Bun.write(
    path.join(tmp.path, ".opencode", "opencode.json"),
    JSON.stringify({ marketplace: [tmp.path] }, null, 2),
  )
  await Bun.write(path.join(tmp.path, "marketplace.json"), JSON.stringify(manifest, null, 2))

  process.env.OPENCODE_PLUGIN_META_FILE = path.join(tmp.path, "plugin-meta.json")
  const config = createTuiResolvedConfig({ plugin: [] })
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

  try {
    await TuiPluginRuntime.init({ api, config })
    const result = await TuiPluginRuntime.discoverPlugins()

    expect(result.marketplaceCount).toBeGreaterThanOrEqual(1)
    expect(result.marketplaces).toEqual([{ name: "demo-marketplace", source: tmp.path, fetchedAt: expect.any(Number) }])
    const entry = result.plugins.find((item) => item.spec === "opencode-weather-widget@1.2.0")
    expect(entry).toEqual({
      name: "weather-widget",
      marketplace: "demo-marketplace",
      description: "Shows the weather in the status bar",
      spec: "opencode-weather-widget@1.2.0",
    })
  } finally {
    await TuiPluginRuntime.dispose()
    cwd.mockRestore()
    wait.mockRestore()
    delete process.env.OPENCODE_PLUGIN_META_FILE
  }
})

test("discover returns an empty result before the plugin runtime has initialized", async () => {
  const result = await TuiPluginRuntime.discoverPlugins()
  expect(result).toEqual({ marketplaceCount: 0, marketplaces: [], plugins: [] })
})
