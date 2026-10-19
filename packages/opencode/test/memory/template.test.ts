import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import { MemoryTemplate } from "../../src/memory/template"

// XCOD-264: Docker memory templates write files only after a preview, never overwrite silently,
// keep the password in a 0600 .env, and give the config {env:} references only.

let root: string
let previous: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-template-"))
  previous = Global.Path.config
  ;(Global.Path as { config: string }).config = path.join(root, "config")
})
afterEach(async () => {
  ;(Global.Path as { config: string }).config = previous
  await fs.rm(root, { recursive: true, force: true })
})

const neo4j = MemoryStorage.BUILTIN.find((item) => item.name === "neo4j-docker")!
const postgres = MemoryStorage.BUILTIN.find((item) => item.name === "postgres-docker")!

describe("docker templates", () => {
  for (const template of [neo4j, postgres])
    test(`${template.name}: the preview masks the password and writes nothing`, async () => {
      const plan = await MemoryTemplate.plan({ template, scope: "user", worktree: root, reveal: false })
      expect(plan.dir).toBe(path.join(root, "config", "memory", template.name))
      expect(plan.files.map((file) => file.name)).toEqual(["docker-compose.yml", ".env", ".env.example"])
      expect(plan.files.find((file) => file.name === ".env")!.content).toContain(MemoryTemplate.MASK)
      expect(plan.command).toContain(`-p lunos-memory-${template.name} up -d`)
      expect(await fs.stat(plan.dir).catch(() => undefined)).toBeUndefined()
    })

  test("writing: the password is only in .env (0600), the config block has {env:} references only", async () => {
    const plan = await MemoryTemplate.plan({
      template: postgres,
      scope: "user",
      worktree: root,
      password: "pw-1234567890-abcdefghijkl",
    })
    await MemoryTemplate.write(plan)
    const env = path.join(plan.dir, ".env")
    expect((await fs.stat(env)).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(env, "utf8")).toContain("POSTGRES_PASSWORD=pw-1234567890-abcdefghijkl")
    for (const name of ["docker-compose.yml", ".env.example"])
      expect(await fs.readFile(path.join(plan.dir, name), "utf8")).not.toContain("pw-1234567890")
    expect(JSON.stringify(plan.memory)).not.toContain("pw-1234567890")
    expect(plan.memory.backend).toMatchObject({ password: "{env:POSTGRES_PASSWORD}", username: "{env:POSTGRES_USER}" })
    expect(await MemoryTemplate.env(plan.dir)).toMatchObject({ POSTGRES_PASSWORD: "pw-1234567890-abcdefghijkl" })
  })

  test("a generated password is long and random", () => {
    const a = MemoryTemplate.password()
    expect(a.length).toBeGreaterThanOrEqual(24)
    expect(a).not.toBe(MemoryTemplate.password())
  })

  test("an existing file is never overwritten unless the user named it", async () => {
    const plan = await MemoryTemplate.plan({ template: neo4j, scope: "user", worktree: root })
    await fs.mkdir(plan.dir, { recursive: true })
    await fs.writeFile(path.join(plan.dir, "docker-compose.yml"), "mine\n")
    const again = await MemoryTemplate.plan({ template: neo4j, scope: "user", worktree: root })
    expect(again.files.find((file) => file.name === "docker-compose.yml")!.exists).toBe(true)
    await expect(MemoryTemplate.write(again)).rejects.toThrow(/already exists; nothing was written/)
    expect(await fs.readFile(path.join(plan.dir, "docker-compose.yml"), "utf8")).toBe("mine\n")
    expect(await fs.stat(path.join(plan.dir, ".env")).catch(() => undefined)).toBeUndefined()
    await MemoryTemplate.write(again, ["docker-compose.yml"])
    expect(await fs.readFile(path.join(plan.dir, "docker-compose.yml"), "utf8")).toContain("neo4j:5")
  })

  test("in a project: under .opencode/memory/, with the .env kept out of git", async () => {
    const plan = await MemoryTemplate.plan({ template: neo4j, scope: "project", worktree: root })
    expect(plan.dir).toBe(path.join(root, ".opencode", "memory", "neo4j-docker"))
    expect(plan.files.find((file) => file.name === ".gitignore")?.content).toBe(".env\n")
    expect(plan.project).toMatch(/^lunos-memory-neo4j-docker-[0-9a-f]{8}$/)
  })

  test("Docker or Podman not found: detect says so", async () => {
    expect(await MemoryTemplate.detect(() => null)).toBeUndefined()
  })
})

test("Move's child process runs in the project, not in a dev run's --cwd", async () => {
  const { MemoryMove } = await import("../../src/memory/move")
  expect(MemoryMove.withoutCwd(["--cwd", "/lunos/packages/opencode", "--smol", "--cwd=/x"])).toEqual(["--smol"])
})
