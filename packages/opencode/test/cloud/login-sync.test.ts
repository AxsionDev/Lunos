// XCOD-185: what `lunos login` does for session sync once the sign-in succeeded (cli/cmd/cloud.ts).
import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { loginSync } from "@/cli/cmd/cloud"
import { CloudSyncApi } from "@/cloud/sync-api"
import * as Fake from "./fixtures/fake-sync-plane"

let plane: Fake.FakeSyncPlane
let printed: string[]
let calls: string[]
const original = Global.Path.data
const globalConfig = () => path.join(Global.Path.config, "opencode.json")

beforeEach(async () => {
  ;(Global.Path as any).data = await fs.mkdtemp(path.join(os.tmpdir(), "login-sync-"))
  await fs.mkdir(Global.Path.config, { recursive: true })
  plane = Fake.start()
  printed = []
  calls = []
})
afterEach(async () => {
  plane.stop()
  await fs.rm(globalConfig(), { force: true })
  ;(Global.Path as any).data = original
})

const recording: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push(String(input instanceof Request ? input.url : input))
    return fetch(input, init)
  },
  { preconnect: fetch.preconnect },
)
const opts = { fetch: recording, token: async () => Fake.TOKEN, sub: Fake.SUB }
const print = (line: string) => printed.push(line)

test("an organisation's identity provider without cloud.endpoint: no registration, no request", async () => {
  await loginSync({ issuer: "https://idp.example.org/realms/acme", locked: false, print, opts })
  expect(printed).toEqual(["Session sync needs cloud.endpoint for your organisation's identity provider."])
  expect(calls).toEqual([])
  expect(await CloudSyncApi.load()).toBeUndefined()
})

test("with cloud.endpoint set: registers, and the notice is shown once", async () => {
  await fs.writeFile(globalConfig(), JSON.stringify({ cloud: { endpoint: plane.url } }))
  await loginSync({ issuer: "https://idp.example.org/realms/acme", locked: false, print, opts })
  await loginSync({ issuer: "https://idp.example.org/realms/acme", locked: false, print, opts })
  expect(printed).toEqual([CloudSyncApi.NOTICE])
  expect(calls.every((u) => u.startsWith(plane.url))).toBe(true)
  expect((await CloudSyncApi.load())!.noticeShown).toBe(true)
})

test("an organisation policy locking sync off: the policy line, not the notice", async () => {
  await fs.writeFile(globalConfig(), JSON.stringify({ cloud: { endpoint: plane.url } }))
  await loginSync({ issuer: "https://idp.example.org/realms/acme", locked: true, print, opts })
  expect(printed).toEqual(["Your organisation's policy keeps session sync off."])
  expect((await CloudSyncApi.load())!.noticeShown).toBe(false)
})
