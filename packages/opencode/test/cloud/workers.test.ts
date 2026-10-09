import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { $ } from "bun"
import { Global } from "@opencode-ai/core/global"
import { CloudStore } from "../../src/cloud/store"
import { CloudWorkers } from "../../src/cloud/workers"
import { secrets } from "../../src/cli/cmd/cloud-run"
import * as Fake from "./fixtures/fake-control-plane"

// XCOD-186: the client side of Lunos Cloud workers, against a fake control plane.

let dir: string
let previous: string
let fake: Awaited<ReturnType<typeof Fake.start>> | undefined

beforeAll(async () => {
  process.env.LUNOS_CLOUD_STORE = "file"
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-cloud-workers-"))
  previous = Global.Path.data
  ;(Global.Path as { data: string }).data = dir
})
afterAll(async () => {
  ;(Global.Path as { data: string }).data = previous
  delete process.env.LUNOS_CLOUD_STORE
  await fs.rm(dir, { recursive: true, force: true })
})
afterEach(async () => {
  fake?.stop()
  fake = undefined
  delete process.env.LUNOS_OFFLINE
  await CloudStore.clear()
})

async function signIn(issuer: string) {
  await CloudStore.save({
    issuer,
    clientID: "lunos-cli",
    tokens: { access_token: Fake.TOKEN, token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
    sub: "ada",
    email: "ada@example.test",
    savedAt: new Date().toISOString(),
  })
}

/** A bare "remote" with one commit on main, and a clone of it to work in. */
async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-cloud-repo-"))
  const remote = path.join(root, "remote.git")
  const work = path.join(root, "work")
  await $`git init -q --bare -b main ${remote}`.quiet()
  await $`git clone -q ${remote} ${work}`.quiet()
  await fs.writeFile(path.join(work, "calc.py"), "def add(a, b):\n    return a + b\n")
  await $`git -C ${work} add -A`.quiet()
  await $`git -C ${work} -c user.email=t@t -c user.name=t commit -qm init`.quiet()
  await $`git -C ${work} push -q origin HEAD:main`.quiet()
  await $`git -C ${work} branch -q --set-upstream-to=origin/main`.quiet()
  return { root, remote, work }
}

const audit = async (file: string) =>
  (await fs.readFile(file, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

describe("CloudWorkers (XCOD-186)", () => {
  test("no endpoint, offline, signed out: refused before any request", async () => {
    fake = await Fake.start()
    const { work } = await repository()
    const found = await CloudWorkers.repo(work, {})
    await expect(CloudWorkers.create({ config: {}, repo: found.repo })).rejects.toThrow(/cloud\.endpoint/)
    const config = { cloud: { endpoint: fake.url } }
    await expect(CloudWorkers.create({ config, repo: found.repo })).rejects.toThrow(/lunos login/)
    process.env.LUNOS_OFFLINE = "1"
    await signIn(fake.issuer)
    await expect(CloudWorkers.create({ config, repo: found.repo })).rejects.toThrow(/offline mode/)
    expect(fake.requests.filter((r) => r.path.startsWith("/v1"))).toEqual([])
    expect(() => CloudWorkers.endpoint({ cloud: { endpoint: "http://cloud.example.com" } })).toThrow(/https/)
  })

  test("residency: a US control plane under an EU-only policy is refused and audited; no worker is asked for", async () => {
    fake = await Fake.start({ region: "us" })
    await signIn(fake.issuer)
    const { root, work } = await repository()
    const auditPath = path.join(root, "audit.log")
    const config = { cloud: { endpoint: fake.url }, residency: { allow: ["eu"] as const, auditPath } }
    const found = await CloudWorkers.repo(work, config)
    await expect(CloudWorkers.create({ config, repo: found.repo })).rejects.toThrow(
      /runs workers in "us".*allows only: eu/,
    )
    expect(fake.requests.some((r) => r.method === "PUT")).toBe(false)
    await Bun.sleep(100)
    expect((await audit(auditPath)).map((e) => [e.event, e.reason])).toContainEqual(["cloud.denied", "residency"])
  })

  test("a commit that isn't on the remote is refused: Lunos never uploads the working tree", async () => {
    const { work } = await repository()
    await fs.writeFile(path.join(work, "local.txt"), "x")
    await $`git -C ${work} add -A`.quiet()
    await $`git -C ${work} -c user.email=t@t -c user.name=t commit -qm local`.quiet()
    await expect(CloudWorkers.repo(work, {})).rejects.toThrow(/isn't on origin yet.*Push it first/)
  })

  test("the control plane's errors become messages a user can act on", async () => {
    for (const [status, code, expected] of [
      [402, "spending_cap", /spending cap reached/],
      [429, "concurrency_limit", /too many cloud runs at once/],
      [403, "forbidden", /Not on your plan/],
      [401, "unauthenticated", /Run lunos login/],
    ] as const) {
      fake = await Fake.start({ fail: { path: "/v1/workers", status, code, message: "Not on your plan." } })
      await signIn(fake.issuer)
      const { work } = await repository()
      const config = { cloud: { endpoint: fake.url } }
      const found = await CloudWorkers.repo(work, config)
      const error = await CloudWorkers.create({ config, repo: found.repo }).catch((e) => e)
      expect(error).toBeInstanceOf(CloudWorkers.ServiceError)
      expect(error.code).toBe(code)
      expect(error.message).toMatch(expected)
      fake.stop()
    }
    fake = undefined
  })

  test("only named secrets are sent; stored provider keys never leave the machine", async () => {
    fake = await Fake.start()
    await signIn(fake.issuer)
    const { work } = await repository()
    const config = { cloud: { endpoint: fake.url } }
    const found = await CloudWorkers.repo(work, config)
    const env = { OPENCODE_AUTH_CONTENT: '{"anthropic":{"key":"sk-stored"}}', MISTRAL_API_KEY: "m-123" }
    expect(() => secrets(["NOPE"], env)).toThrow(/NOPE isn't set here/)
    const started = await CloudWorkers.create({ config, repo: found.repo, secrets: secrets(["MISTRAL_API_KEY"], env) })
    const put = fake.requests.find((r) => r.method === "PUT")!
    expect(put.body.secrets).toEqual({ MISTRAL_API_KEY: "m-123" })
    expect(JSON.stringify(fake.requests)).not.toContain("sk-stored")
    expect(put.auth).toBe(`Bearer ${Fake.TOKEN}`)
    await CloudWorkers.finish(config, started.base, started.worker.id, "finished")
  })

  test("end to end: the worker starts from the pushed commit; results come back as lunos/cloud/<id>, never main", async () => {
    fake = await Fake.start()
    await signIn(fake.issuer)
    const { root, remote, work } = await repository()
    const auditPath = path.join(root, "audit.log")
    const config = { cloud: { endpoint: fake.url }, residency: { allow: ["eu"] as const, auditPath } }
    const found = await CloudWorkers.repo(work, config)
    const mainBefore = (await $`git -C ${remote} rev-parse main`.quiet().text()).trim()

    const started = await CloudWorkers.create({ config, repo: found.repo })
    const { worker } = started
    expect(worker.status).toBe("running")
    expect(worker.branch).toBe(`lunos/cloud/${worker.id}`)
    const put = fake.requests.find((r) => r.method === "PUT")!
    expect(put.body.residency).toEqual({ allow: ["eu"], enforce: true })
    expect(put.body.repo).toMatchObject({ url: remote, commit: mainBefore, branch: "main" })
    const conn = CloudWorkers.connection(worker)
    expect(conn.headers.Authorization).toStartWith("Basic ")

    // The agent's work on the worker.
    await fs.writeFile(
      path.join(worker.directory!, "calc.py"),
      "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n",
    )
    const done = await CloudWorkers.finish(config, started.base, worker.id, "finished")
    expect(done).toMatchObject({ pushed: true, branch: `lunos/cloud/${worker.id}` })
    expect(await $`git -C ${remote} show ${done.branch}:calc.py`.quiet().text()).toContain("def sub")
    expect((await $`git -C ${remote} rev-parse main`.quiet().text()).trim()).toBe(mainBefore)

    await Bun.sleep(100)
    const events = (await audit(auditPath)).map((e) => e.event)
    expect(events).toContain("cloud.dispatch")
    expect(events).toContain("cloud.finish")
  })

  test("a control plane that would push anywhere but lunos/cloud/<id> is refused", async () => {
    fake = await Fake.start({ wrongBranch: true })
    await signIn(fake.issuer)
    const { work } = await repository()
    const config = { cloud: { endpoint: fake.url } }
    const found = await CloudWorkers.repo(work, config)
    await expect(CloudWorkers.create({ config, repo: found.repo })).rejects.toThrow(/would push to "main"/)
    // The refused worker was ended, not left running.
    expect(fake.workers.size).toBe(0)
    expect(fake.requests.some((r) => r.method === "DELETE")).toBe(true)
  })

  test("a token in the remote URL is never sent or audited", async () => {
    fake = await Fake.start()
    await signIn(fake.issuer)
    const { root, work } = await repository()
    await $`git -C ${work} remote set-url origin https://ada:ghp_SECRET123@example.invalid/acme/app.git`.quiet()
    const auditPath = path.join(root, "audit.log")
    const config = { cloud: { endpoint: fake.url }, residency: { allow: ["eu"] as const, auditPath } }
    const found = await CloudWorkers.repo(work, config)
    expect(found.strippedCredentials).toBe(true)
    expect(found.repo.url).toBe("https://example.invalid/acme/app.git")
    expect(CloudWorkers.publicRemote("git@github.com:acme/app.git")).toEqual({
      url: "git@github.com:acme/app.git",
      stripped: false,
    })
    // The fake can't clone example.invalid, so the start fails; that path must not leak it either.
    await expect(CloudWorkers.create({ config, repo: found.repo })).rejects.toThrow()
    await Bun.sleep(100)
    expect(JSON.stringify(fake.requests)).not.toContain("ghp_SECRET123")
    expect(await fs.readFile(auditPath, "utf8")).not.toContain("ghp_SECRET123")
    const events = (await audit(auditPath)).map((e) => [e.event, e.outcome])
    expect(events).toContainEqual(["cloud.finish", "not started"])
  })

  test("the worker's password only goes to an https (or localhost) server", () => {
    const worker = {
      id: "abcdef123456",
      status: "running" as const,
      region: "eu" as const,
      auth: { username: "opencode", password: "pw" },
      branch: "lunos/cloud/abcdef123456",
      activeSeconds: 0,
    }
    expect(() => CloudWorkers.connection({ ...worker, url: "http://worker.example.com" })).toThrow(/must be https/)
    expect(CloudWorkers.connection({ ...worker, url: "https://w1.cloud.lunos.tech" }).url).toBe(
      "https://w1.cloud.lunos.tech",
    )
  })
})
