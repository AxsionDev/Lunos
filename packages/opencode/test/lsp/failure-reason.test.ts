// XCOD-257: a language server that doesn't start says why, and /lsp lists every server's state.
import { describe, expect, test } from "bun:test"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { LSP } from "@/lsp/lsp"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LSP.node))
const fake = path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.js")

const touch = (name: string) =>
  Effect.gen(function* () {
    const dir = (yield* TestInstance).directory
    yield* Effect.promise(() => Bun.write(path.join(dir, name), "x"))
    return path.join(dir, name)
  })

describe("LSP failure reasons (XCOD-257)", () => {
  test("spawn errors read as people say them", () => {
    expect(LSP.spawnReason(Object.assign(new Error("spawn gopls ENOENT"), { code: "ENOENT" }), "gopls")).toBe(
      "command not found: gopls",
    )
    expect(LSP.spawnReason(new Error("EACCES"))).toBe("EACCES")
  })

  test("where a running server came from", () => {
    const bin = "/home/u/.cache/opencode/bin"
    expect(LSP.sourceOf("/p/node_modules/.bin/typescript-language-server", bin, false)).toBe(
      "project node_modules/.bin",
    )
    expect(LSP.sourceOf(`${bin}/gopls`, bin, false)).toBe(`downloaded (${bin}/gopls)`)
    expect(LSP.sourceOf("/usr/local/bin/gopls", bin, false)).toBe("PATH (/usr/local/bin/gopls)")
    expect(LSP.sourceOf("/x", bin, true)).toBe("custom command")
  })

  it.instance(
    'a missing command is failed with "command not found", in status and the overview',
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          yield* lsp.touchFile(yield* touch("a.zzq"))
          const status = yield* lsp.status()
          const failed = status.find((item) => item.id === "nowhere")
          expect(failed).toMatchObject({ status: "error", reason: "command not found: lunos-no-such-lsp-binary" })
          const overview = yield* lsp.overview()
          expect(overview.servers.find((item) => item.id === "nowhere")).toMatchObject({
            state: "failed",
            custom: true,
            reason: "command not found: lunos-no-such-lsp-binary",
          })
        }),
      ),
    { config: { lsp: { nowhere: { command: ["lunos-no-such-lsp-binary"], extensions: [".zzq"] } } } },
  )

  it.instance(
    "a server that exits while starting is failed with its exit code and last stderr line",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          yield* lsp.touchFile(yield* touch("a.zzc"))
          const reason = (yield* lsp.status()).find((item) => item.id === "crashy")?.reason ?? ""
          expect(reason).toContain("exited with code 3 before it finished starting")
          expect(reason).toContain("boom: no config")
        }),
      ),
    {
      config: {
        lsp: {
          crashy: {
            command: [
              process.execPath,
              "-e",
              "console.error('boom: no config'); setTimeout(() => process.exit(3), 50)",
            ],
            extensions: [".zzc"],
          },
        },
      },
    },
  )

  it.instance(
    "a working server is running with its pid, stops, and restarts on the next file",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const file = yield* touch("a.zzf")
          yield* lsp.touchFile(file)
          const running = (yield* lsp.overview()).servers.find((item) => item.id === "fake")
          expect(running).toMatchObject({ state: "running", source: "custom command" })
          expect(running?.pid).toBeGreaterThan(0)
          yield* lsp.stop("fake", false)
          expect((yield* lsp.overview()).servers.find((item) => item.id === "fake")?.state).toBe("not_started")
          yield* lsp.touchFile(file)
          expect((yield* lsp.overview()).servers.find((item) => item.id === "fake")?.state).toBe("running")
        }),
      ),
    { config: { lsp: { fake: { command: [process.execPath, fake], extensions: [".zzf"] } } } },
  )

  it.instance(
    "with LSP off every built-in server is listed as off; one turned off in config is listed too",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const overview = yield* lsp.overview()
          expect(overview.enabled).toBe(false)
          expect(overview.servers.length).toBeGreaterThan(20)
          expect(overview.servers.every((item) => item.state === "disabled")).toBe(true)
        }),
      ),
    { config: { lsp: false } },
  )

  it.instance(
    "a server turned off in config shows as off with the reason",
    () =>
      LSP.Service.use((lsp) =>
        Effect.gen(function* () {
          const gopls = (yield* lsp.overview()).servers.find((item) => item.id === "gopls")
          expect(gopls).toMatchObject({ state: "disabled", reason: "turned off in config" })
        }),
      ),
    { config: { lsp: { gopls: { disabled: true } } } },
  )
})
