import { afterEach, describe, expect } from "bun:test"
import { createServer } from "node:net"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { Effect, Layer } from "effect"
import { ExternalRegistry } from "../../src/external/registry"
import { SessionPeers } from "../../src/session/peers"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// XCOD-325: renaming any row of "Sessions on this computer" through the server: a Claude Code /
// Codex session (its Lunos name, in the registry; the tool's files untouched), a session another
// Lunos runs (through that Lunos; here when none runs it any more) and the errors a row shows.

const it = testEffect(Layer.mergeAll(httpApiLayer))
const audit = path.join(os.tmpdir(), `lunos-rename-audit-${process.pid}.jsonl`)

const entry = (sessionID: string): ExternalRegistry.Entry => ({
  sessionID,
  tool: "claude",
  cwd: "/work/api",
  started: new Date().toISOString(),
  updated: new Date().toISOString(),
  status: "done",
})

const post = (directory: string, url: string, body: unknown) =>
  requestInDirectory(url, directory, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const overviewTitle = Effect.fn(function* (directory: string, id: string) {
  const res = yield* requestInDirectory("/experimental/session-overview", directory)
  const body = (yield* res.json) as { sessions: { id: string; title: string }[] }
  return body.sessions.find((item) => item.id === id)?.title
})

const sessionOf = Effect.fn(function* (directory: string, id: string) {
  const res = yield* requestInDirectory(`/session/${id}`, directory)
  return (yield* res.json) as { title: string; metadata?: Record<string, unknown> }
})

const auditLines = Effect.fn(function* () {
  // The audit line is written asynchronously.
  for (let i = 0; i < 50 && !(existsSync(audit) && readFileSync(audit, "utf8").includes("session.rename")); i++)
    yield* Effect.sleep(20)
  return existsSync(audit)
    ? readFileSync(audit, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((line) => JSON.stringify(line).includes("session.rename"))
    : []
})

afterEach(async () => {
  rmSync(path.join(path.dirname(SessionPeers.dir()), "external"), { recursive: true, force: true })
  rmSync(SessionPeers.dir(), { recursive: true, force: true })
  rmSync(audit, { force: true })
  await disposeAllInstances()
})

describe("rename from Sessions on this computer (XCOD-325)", () => {
  it.instance(
    "a Claude Code session gets a Lunos name that survives the tool's next save; empty brings the automatic one back",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* Effect.promise(() => ExternalRegistry.save(entry("cc-1")))
        expect(yield* overviewTitle(test.directory, "external:cc-1")).toBe("Claude Code · api")

        const res = yield* post(test.directory, "/experimental/external/cc-1/rename", { title: "  API\n  refactor  " })
        expect(res.status).toBe(200)
        expect(yield* overviewTitle(test.directory, "external:cc-1")).toBe("API refactor")
        // The runner rewrites the whole entry on every turn, without the name: it stays.
        yield* Effect.promise(() => ExternalRegistry.save({ ...entry("cc-1"), status: "running" }))
        const saved = yield* Effect.promise(() => ExternalRegistry.get("cc-1"))
        expect(saved).toMatchObject({ status: "running", title: "API refactor" })
        expect(yield* overviewTitle(test.directory, "external:cc-1")).toBe("API refactor")

        // One line of at most 80 characters.
        yield* post(test.directory, "/experimental/external/cc-1/rename", { title: "x".repeat(200) })
        expect(yield* overviewTitle(test.directory, "external:cc-1")).toBe("x".repeat(80))

        yield* post(test.directory, "/experimental/external/cc-1/rename", { title: "   " })
        expect(yield* overviewTitle(test.directory, "external:cc-1")).toBe("Claude Code · api")
        expect((yield* Effect.promise(() => ExternalRegistry.get("cc-1")))?.title).toBeUndefined()

        // Audited without the name.
        const lines = yield* auditLines()
        expect(lines.length).toBe(3)
        expect(JSON.stringify(lines)).toContain("external:cc-1")
        expect(JSON.stringify(lines)).not.toContain("API refactor")
        expect(lines.at(-1)).toMatchObject({ kind: "external", cleared: true })
      }),
    { config: { audit: { enabled: true, path: audit } } as any },
  )

  it.instance("an archived Claude Code session can be renamed too", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => ExternalRegistry.save({ ...entry("cc-old"), archived: new Date().toISOString() }))
      expect((yield* post(test.directory, "/experimental/external/cc-old/rename", { title: "old work" })).status).toBe(
        200,
      )
      const res = yield* requestInDirectory("/experimental/session-overview?archived=true", test.directory)
      const body = (yield* res.json) as { sessions: { id: string; title: string }[] }
      expect(body.sessions.find((item) => item.id === "external:cc-old")?.title).toBe("old work")
    }),
  )

  it.instance("a Claude Code session that is gone: 404 with a reason the row can show", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const res = yield* post(test.directory, "/experimental/external/cc-gone/rename", { title: "x" })
      expect(res.status).toBe(404)
      expect(JSON.stringify(yield* res.json)).toContain("That session was deleted.")
    }),
  )

  it.instance("another Lunos's session that no Lunos runs any more is renamed here, as a user's name", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const created = (yield* (yield* post(test.directory, "/session", {})).json) as { id: string }
      const res = yield* post(test.directory, `/experimental/peer/${created.id}/rename`, { title: "Named elsewhere" })
      expect(res.status).toBe(200)
      const info = yield* sessionOf(test.directory, created.id)
      expect(info.title).toBe("Named elsewhere")
      expect(info.metadata?.titleSource).toBe("user")

      const gone = yield* post(test.directory, "/experimental/peer/ses_gone/rename", { title: "x" })
      expect(gone.status).toBe(404)
      expect(JSON.stringify(yield* gone.json)).toContain("That session was deleted.")
    }),
  )

  it.instance("another Lunos that doesn't answer: the rename fails with why, and the old name stays", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const created = (yield* (yield* post(test.directory, "/session", { title: "old name" })).json) as { id: string }
      // A fresh claim whose control port nothing listens on any more.
      const port = yield* Effect.promise(
        () =>
          new Promise<number>((resolve) => {
            const server = createServer().listen(0, "127.0.0.1", () => {
              const address = server.address() as { port: number }
              server.close(() => resolve(address.port))
            })
          }),
      )
      mkdirSync(SessionPeers.dir(), { recursive: true, mode: 0o700 })
      writeFileSync(
        path.join(SessionPeers.dir(), "999999-deadbeef.json"),
        JSON.stringify({
          version: 1,
          pid: 999999,
          heartbeat: Date.now() + 60_000,
          sessions: { [created.id]: { status: "busy", permissions: 0, questions: 0, directory: test.directory } },
          control: { port, token: "a".repeat(64) },
        }),
        { mode: 0o600 },
      )
      const res = yield* post(test.directory, `/experimental/peer/${created.id}/rename`, { title: "new name" })
      expect(res.status).toBe(400)
      expect(JSON.stringify(yield* res.json)).toContain("the Lunos running it isn't responding")
      expect((yield* sessionOf(test.directory, created.id)).title).toBe("old name")
    }),
  )

  it.instance(
    "a rename through the session route is audited, without the name",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const created = (yield* (yield* post(test.directory, "/session", {})).json) as { id: string }
        const res = yield* requestInDirectory(`/session/${created.id}`, test.directory, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "secret project" }),
        })
        expect(res.status).toBe(200)
        const lines = yield* auditLines()
        expect(lines.length).toBe(1)
        expect(lines[0]).toMatchObject({ kind: "session", origin: "api" })
        expect(JSON.stringify(lines[0])).toContain(created.id)
        expect(JSON.stringify(lines[0])).not.toContain("secret project")
      }),
    { config: { audit: { enabled: true, path: audit } } as any },
  )
})
