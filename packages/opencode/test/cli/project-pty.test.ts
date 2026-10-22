import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import * as Pty from "./fixtures/tui-pty"

// XCOD-298: named projects from the CLI (as a script would run it, `--json`) and from /projects in
// the TUI, in a pty at 120x45, isolated (throwaway HOME/XDG, the stand-in keychain, a local model
// nobody calls).

const TIMEOUT = 120_000
const { KEY } = Pty

let run: Awaited<ReturnType<typeof Pty.launch>> | undefined
const homes: string[] = []

afterAll(async () => {
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})
afterEach(async () => {
  await run?.stop()
  if (run) homes.push(run.home)
  run = undefined
})

/** `lunos project …` without a terminal, against one HOME. */
async function project(home: string, ...args: string[]) {
  const result = await Pty.exec(["project", ...args], { home })
  return { ...result, json: result.stdout.trim() ? JSON.parse(result.stdout) : undefined }
}

describe("lunos project", () => {
  test(
    "create, list, rename, add, remove and archive, with --json",
    async () => {
      const { home, dirs } = await Pty.prepare()
      homes.push(home)
      const web = path.join(home, "axsion-web")
      const api = path.join(home, "axsion-api")
      const infra = path.join(home, "infra")

      const created = await project(home, "create", "Axsion web", web, api, "--json")
      expect(created.code).toBe(0)
      expect(created.json).toMatchObject({ name: "Axsion web", folders: [web, api] })
      const id = created.json.id as string
      expect(id.startsWith("pgrp_")).toBe(true)

      expect((await project(home, "add", "axsion web", infra, "--json")).json.folders).toEqual([web, api, infra])
      expect((await project(home, "remove", id, api, "--json")).json.folders).toEqual([web, infra])
      expect((await project(home, "rename", id, "Axsion", "--json")).json.name).toBe("Axsion")

      const listed = await project(home, "list", "--json")
      expect(listed.json).toEqual([expect.objectContaining({ id, name: "Axsion", folders: [web, infra] })])

      expect((await project(home, "archive", "Axsion", "--json")).json.archived).toBe(true)
      expect((await project(home, "list", "--json")).json).toEqual([])
      expect((await project(home, "list", "--archived", "--json")).json).toHaveLength(1)

      // A refusal: the message as JSON, exit code 1.
      const missing = await project(home, "rename", "nope", "x", "--json")
      expect(missing.code).toBe(1)
      expect(missing.json.error.message).toContain('"nope"')

      // Stored on this computer, under the data directory.
      const stored = JSON.parse(await fs.readFile(path.join(dirs.data, "opencode", "project-groups.json"), "utf8"))
      expect(stored.groups[0].id).toBe(id)
    },
    TIMEOUT,
  )
})

describe("/projects", () => {
  test(
    "lists this folder's repository project, creates a named one from it, and adds and removes a folder",
    async () => {
      run = await Pty.launch()
      await run.waitFor("Ask anything", 30_000)
      await run.type("/projects")
      await Bun.sleep(300)
      run.press(KEY.enter)
      await run.waitFor("This folder counts in")
      await run.waitFor("its repository · no setup")

      // New project…: named from this folder.
      await run.type("New project")
      await Bun.sleep(200)
      run.press(KEY.enter)
      await run.waitFor("New project", 10_000)
      await run.type("Axsion web")
      run.press(KEY.enter)
      await run.waitFor("Projects › Axsion web")
      await run.waitFor("Add a folder…")
      // The server sees the real path (on macOS /private/var/… for a /var/… HOME).
      const here = await fs.realpath(run.dirs.project)

      // Add a folder…
      await run.type("Add a folder")
      await Bun.sleep(200)
      run.press(KEY.enter)
      await run.waitFor("Add a folder", 10_000)
      await run.type("~/axsion-api")
      run.press(KEY.enter)
      const stored = async () =>
        JSON.parse(await fs.readFile(path.join(run!.dirs.data, "opencode", "project-groups.json"), "utf8"))
      const settle = async (count: number) => {
        const until = Date.now() + 10_000
        while ((await stored()).groups[0].folders.length !== count && Date.now() < until) await Bun.sleep(100)
      }
      await settle(2)
      await run.waitFor(/Folders[\s\S]*~\/axsion-api[\s\S]*Add a folder…/)
      expect((await stored()).groups[0].folders).toEqual([here, path.join(run.home, "axsion-api")])

      // Enter on a folder removes it, after asking.
      await run.type("axsion-api")
      await Bun.sleep(200)
      run.press(KEY.enter)
      await run.waitFor("Remove ~/axsion-api from Axsion web?")
      run.press(KEY.enter)
      await run.waitFor("Projects › Axsion web")
      await settle(1)
      expect((await stored()).groups[0].folders).toEqual([here])

      // Back in the list, this folder now counts in the named project.
      run.press(KEY.left)
      await run.waitFor(/This folder counts in[\s\S]*Axsion web/)

      // Settings › Projects lists it too.
      run.press(KEY.escape)
      await Bun.sleep(300)
      await run.type("/settings projects")
      await Bun.sleep(300)
      run.press(KEY.enter)
      await run.waitFor("Settings › Projects › Projects")
      await run.waitFor(/Axsion web[\s\S]*1 folder[\s\S]*All projects…/)
    },
    TIMEOUT,
  )
})
