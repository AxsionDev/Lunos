import { describe, test, expect, spyOn, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Npm } from "@opencode-ai/core/npm"
import * as LSPServer from "@/lsp/server"
import type { InstanceContext } from "@/project/instance-context"
import type { RuntimeFlags } from "@/effect/runtime-flags"
import { tmpdir } from "../fixture/fixture"

// XCOD-246: the TypeScript server prefers a typescript-language-server already on the machine,
// and only downloads one when downloads are allowed.

function makeCtx(directory: string): InstanceContext {
  return { directory, worktree: "/", project: {} as any }
}

const flags = (disableLspDownload: boolean) => ({ disableLspDownload }) as RuntimeFlags.Info

// A project that resolves typescript/lib/tsserver.js, which the server needs before anything else.
async function project(dir: string) {
  await fs.mkdir(path.join(dir, "node_modules", "typescript", "lib"), { recursive: true })
  await Bun.write(
    path.join(dir, "node_modules", "typescript", "package.json"),
    '{"name":"typescript","main":"lib/typescript.js"}',
  )
  await Bun.write(path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "")
}

// A stand-in language server that exits straight away.
async function fakeServer(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, "#!/bin/sh\nexit 0\n")
  await fs.chmod(file, 0o755)
}

const originalPath = process.env.PATH

describe.skipIf(process.platform === "win32")("typescript server binary", () => {
  afterEach(() => {
    process.env.PATH = originalPath
  })

  test("uses typescript-language-server from PATH without downloading", async () => {
    await using dir = await tmpdir()
    await project(dir.path)
    const bin = path.join(dir.path, "bin")
    await fakeServer(path.join(bin, "typescript-language-server"))
    process.env.PATH = bin + path.delimiter + originalPath
    const npm = spyOn(Npm, "which")

    try {
      const handle = await LSPServer.Typescript.spawn(dir.path, makeCtx(dir.path), flags(true))
      expect(handle).toBeDefined()
      expect(handle!.process.spawnfile).toBe(path.join(bin, "typescript-language-server"))
      handle!.process.kill()
      expect(npm).not.toHaveBeenCalled()
    } finally {
      npm.mockRestore()
    }
  })

  test("prefers the project's node_modules/.bin over PATH", async () => {
    await using dir = await tmpdir()
    await project(dir.path)
    const local = path.join(dir.path, "node_modules", ".bin", "typescript-language-server")
    await fakeServer(local)
    const bin = path.join(dir.path, "bin")
    await fakeServer(path.join(bin, "typescript-language-server"))
    process.env.PATH = bin + path.delimiter + originalPath

    const handle = await LSPServer.Typescript.spawn(dir.path, makeCtx(dir.path), flags(true))
    expect(handle!.process.spawnfile).toBe(local)
    handle!.process.kill()
  })

  test("does not download when downloads are disabled and no server is installed", async () => {
    await using dir = await tmpdir()
    await project(dir.path)
    process.env.PATH = path.join(dir.path, "empty")
    const npm = spyOn(Npm, "which")

    try {
      const handle = await LSPServer.Typescript.spawn(dir.path, makeCtx(dir.path), flags(true))
      expect(handle).toBeUndefined()
      expect(npm).not.toHaveBeenCalled()
    } finally {
      npm.mockRestore()
    }
  })

  test("downloads when allowed and no server is installed", async () => {
    await using dir = await tmpdir()
    await project(dir.path)
    process.env.PATH = path.join(dir.path, "empty")
    const npm = spyOn(Npm, "which").mockResolvedValue(undefined)

    try {
      await LSPServer.Typescript.spawn(dir.path, makeCtx(dir.path), flags(false))
      expect(npm).toHaveBeenCalledWith("typescript-language-server")
    } finally {
      npm.mockRestore()
    }
  })
})

describe("biome server binary", () => {
  test("does not download when downloads are disabled", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "node_modules", "biome"), { recursive: true })
    await Bun.write(path.join(dir.path, "node_modules", "biome", "package.json"), '{"name":"biome","main":"index.js"}')
    await Bun.write(path.join(dir.path, "node_modules", "biome", "index.js"), "")
    const original = process.env.PATH
    process.env.PATH = path.join(dir.path, "empty")
    const npm = spyOn(Npm, "which")

    try {
      const handle = await LSPServer.Biome.spawn(dir.path, makeCtx(dir.path), flags(true))
      expect(handle).toBeUndefined()
      expect(npm).not.toHaveBeenCalled()
    } finally {
      npm.mockRestore()
      process.env.PATH = original
    }
  })
})
