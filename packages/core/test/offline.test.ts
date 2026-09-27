import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Npm } from "@opencode-ai/core/npm"
import { Offline } from "@opencode-ai/core/offline"
import { tmpdir } from "./fixture/tmpdir"

const previous = process.env[Offline.ENV]
afterEach(() => {
  if (previous === undefined) delete process.env[Offline.ENV]
  else process.env[Offline.ENV] = previous
})

describe("Offline", () => {
  test("reads LUNOS_OFFLINE when asked, not at import", () => {
    delete process.env[Offline.ENV]
    expect(Offline.enabled()).toBe(false)
    process.env[Offline.ENV] = "1"
    expect(Offline.enabled()).toBe(true)
    process.env[Offline.ENV] = "0"
    expect(Offline.enabled()).toBe(false)
  })

  test("every blocked call names the switch", () => {
    expect(new Offline.DisabledError("Downloading ripgrep").message).toBe(
      "Downloading ripgrep is disabled because LUNOS_OFFLINE is set (offline mode)",
    )
  })

  test("the call list has unique ids and covers what the ticket names", () => {
    const ids = Offline.CALLS.map((call) => call.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ["models-catalogue", "update-check", "lsp-download", "share", "marketplace"])
      expect(Offline.CALLS.find((call) => call.id === id)?.offline).toBe("blocked")
    expect(Offline.CALLS.find((call) => call.id === "model-provider")?.offline).toBe("yours")
  })

  test("the report lists what offline mode turned off", () => {
    expect(Offline.report(false)).toStartWith("offline mode: off")
    const on = Offline.report(true)
    expect(on).toStartWith("offline mode: on (LUNOS_OFFLINE); disabled:")
    expect(on).toContain("Session sharing")
    expect(on).not.toContain("Model provider")
  })
})

describe("Npm offline", () => {
  const add = async (tmp: string) => {
    await fs.mkdir(path.join(tmp, "fixture-provider"), { recursive: true })
    await Bun.write(
      path.join(tmp, "fixture-provider", "package.json"),
      JSON.stringify({ name: "fixture-provider", version: "1.0.0", main: "index.js" }),
    )
    await Bun.write(path.join(tmp, "fixture-provider", "index.js"), "export const fixture = true\n")
    const spec = `fixture-provider@file:${path.join(tmp, "fixture-provider")}`
    const cache = path.join(tmp, "cache")
    const layer = AppNodeBuilder.build(Npm.node, [
      [Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })],
    ])
    return Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.runPromiseExit)
  }

  test("installs are refused before anything is fetched", async () => {
    await using tmp = await tmpdir()
    process.env[Offline.ENV] = "1"
    const exit = await add(tmp.path)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("disabled because LUNOS_OFFLINE is set")
    expect(await fs.exists(path.join(tmp.path, "cache", "packages"))).toBe(false)
  })

  test("the same install works with offline mode off", async () => {
    await using tmp = await tmpdir()
    delete process.env[Offline.ENV]
    const exit = await add(tmp.path)
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
