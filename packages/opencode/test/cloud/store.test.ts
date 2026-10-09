import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { CloudStore } from "../../src/cloud/store"

// XCOD-185: the file backend (no keychain: Windows, headless Linux, or LUNOS_CLOUD_STORE=file).
// The keychain backends were checked by hand on macOS; see the PR.
let previous: string
let dir: string
beforeAll(async () => {
  process.env.LUNOS_CLOUD_STORE = "file"
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-cloud-"))
  previous = Global.Path.data
  ;(Global.Path as { data: string }).data = dir
})
afterAll(async () => {
  ;(Global.Path as { data: string }).data = previous
  delete process.env.LUNOS_CLOUD_STORE
  await fs.rm(dir, { recursive: true, force: true })
})

describe("CloudStore (XCOD-185)", () => {
  test("a session is saved where only the user can read it, loaded back, and cleared", async () => {
    expect(await CloudStore.load()).toBeUndefined()
    const session = {
      issuer: "https://id.example.eu/realms/lunos",
      clientID: "lunos-cli",
      tokens: { access_token: "a", refresh_token: "r", token_type: "Bearer" },
      email: "dev@lunos.test",
      sub: "u-1",
      savedAt: new Date().toISOString(),
    }
    expect(await CloudStore.save(session)).toBe("file")
    const file = path.join(dir, "cloud", "session.json")
    if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(await CloudStore.load()).toEqual(session)
    await CloudStore.clear()
    expect(await CloudStore.load()).toBeUndefined()
  })
})
