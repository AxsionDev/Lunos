import { afterEach, describe, expect } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { formatPatch, structuredPatch } from "diff"
import { Effect, Layer } from "effect"
import { pathToFileURL } from "url"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { dir as fixtureDir, fixtures } from "../ide/hunk-fixtures"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// XCOD-333: the IDE protocol (sdks/ide/PROTOCOL.md) end to end through the real server, as the
// JetBrains and Visual Studio plugins drive it: create a session in the project directory, send a
// prompt with the editor selection as a file part, answer the edit approval, wait for idle, and
// read the change as a diff the plugin splits into hunks. Also that the session is in the same
// list the TUI's /sessions reads, and that subagent (child) sessions are listed for the panel.

const it = testEffect(Layer.mergeAll(httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
})

const json = Effect.fn(function* <T>(directory: string, url: string, init?: RequestInit) {
  const res = yield* requestInDirectory(url, directory, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  })
  return { status: res.status, body: (res.status === 204 ? undefined : yield* res.json) as T }
})

const before = fixtures().find((item) => item.name === "two-hunks")!.before
const after = fixtures().find((item) => item.name === "two-hunks")!.after

describe("IDE protocol (XCOD-333)", () => {
  it.live(
    "a refactor of the selection arrives as a diff of the user's message; approvals answered over the API",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        // Edits ask for approval, as with the TUI's Manual approval mode (XCOD-310).
        const directory = yield* tmpdirScoped({
          git: true,
          config: { ...testProviderConfig(llm.url), permission: { edit: "ask" } },
        })
        const file = path.join(directory, "Calc.cs")
        // With a UTF-8 BOM, as Visual Studio saves .cs files by default.
        yield* Effect.promise(() => fs.writeFile(file, "\uFEFF" + before))
        yield* llm.push(reply().tool("write", { filePath: file, content: after }))
        yield* llm.text("Both methods are expression-bodied now.")

        const session = yield* json<{ id: string; directory: string }>(directory, "/session", {
          method: "POST",
          body: JSON.stringify({ title: "Refactor from the IDE" }),
        })
        expect(session.status).toBe(200)
        expect(session.body.directory).toBe(directory)
        const id = session.body.id

        // The list the TUI's /sessions dialog reads (sdk.session.list).
        const list = yield* json<{ id: string }[]>(directory, "/session")
        expect(list.body.map((item) => item.id)).toContain(id)

        const url = pathToFileURL(file)
        url.searchParams.set("start", "4")
        url.searchParams.set("end", "8")
        const sent = yield* json(directory, `/session/${id}/prompt_async`, {
          method: "POST",
          body: JSON.stringify({
            model: { providerID: "test", modelID: "test-model" },
            parts: [
              { type: "text", text: "Make Add and Mul expression-bodied." },
              { type: "file", mime: "text/plain", filename: "Calc.cs", url: url.href },
            ],
          }),
        })
        expect(sent.status).toBe(204)

        // The plugin's loop: answer approvals for this session until it is idle with the change on disk.
        const asked: string[] = []
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const pending = yield* json<{ id: string; sessionID: string; permission: string }[]>(
              directory,
              "/permission",
            )
            for (const request of pending.body.filter((item) => item.sessionID === id)) {
              asked.push(request.permission)
              const replied = yield* json(directory, `/permission/${request.id}/reply`, {
                method: "POST",
                body: JSON.stringify({ reply: "once" }),
              })
              expect(replied.status).toBe(200)
            }
            const status = yield* json<Record<string, { type: string }>>(directory, "/session/status")
            const content = yield* Effect.promise(() => fs.readFile(file, "utf8"))
            return (status.body[id]?.type ?? "idle") === "idle" &&
              content.replace(/^\uFEFF/, "") === after &&
              (yield* llm.calls) >= 2
              ? true
              : undefined
          }),
          "the session never finished the edit",
          "30 seconds",
        )

        // The selected lines reached the model as context.
        expect(JSON.stringify(yield* llm.inputs)).toContain("int Mul(int a, int b) { return a * b; }")

        const messages = yield* json<{ info: { id: string; role: string } }[]>(directory, `/session/${id}/message`)
        const user = messages.body.find((item) => item.info.role === "user")!.info.id
        // One fetch right when the session is idle, as the plugins do: the diff must already be there.
        const diff = (yield* json<{ file?: string; patch?: string; status?: string }[]>(
          directory,
          `/session/${id}/diff?messageID=${user}`,
        )).body
        expect(diff).toHaveLength(1)
        expect(diff[0].file).toBe("Calc.cs")
        // Exactly the format the plugins' fixtures use: full-file context, one `@@` section.
        expect(diff[0].patch).toBe(
          formatPatch(
            structuredPatch("Calc.cs", "Calc.cs", before, after, "", "", { context: Number.MAX_SAFE_INTEGER }),
          ),
        )
        // The BOM stays in the file but isn't in the patch: the plugins strip it before applying hunks.
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe("\uFEFF" + after)
        expect(asked).toEqual(["edit"])
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    60_000,
  )

  it.live(
    "with Dynamic workflows on, the subagents the main agent dispatches are child sessions the panel lists",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const directory = yield* tmpdirScoped({
          git: true,
          config: { ...testProviderConfig(llm.url), workflows: { dynamic: true }, permission: { "*": "allow" } },
        })
        const file = path.join(directory, "Calc.cs")
        yield* Effect.promise(() => fs.writeFile(file, before))
        // Main agent: dispatches a subagent. Subagent: writes and reports. Main agent: hands back.
        yield* llm.tool("task", {
          description: "refactor Calc",
          prompt: "Make Add and Mul expression-bodied in Calc.cs.",
          subagent_type: "general",
        })
        yield* llm.tool("write", { filePath: file, content: after })
        yield* llm.text("Refactored Calc.cs.")
        yield* llm.text("Done: Add and Mul are expression-bodied.")

        const session = yield* json<{ id: string }>(directory, "/session", { method: "POST", body: "{}" })
        const id = session.body.id
        yield* json(directory, `/session/${id}/prompt_async`, {
          method: "POST",
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "Refactor Calc." }],
          }),
        })
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const status = yield* json<Record<string, { type: string }>>(directory, "/session/status")
            return (status.body[id]?.type ?? "idle") === "idle" && (yield* llm.calls) >= 4 ? true : undefined
          }),
          "the workflow never finished",
          "30 seconds",
        )

        const children = yield* json<{ id: string; parentID: string; title: string }[]>(
          directory,
          `/session/${id}/children`,
        )
        expect(children.body).toHaveLength(1)
        expect(children.body[0].parentID).toBe(id)
        // The subagent did the edit, in its own session: the panel shows it as that subagent's activity.
        const parts = (yield* json<{ parts: { type: string; tool?: string; sessionID: string }[] }[]>(
          directory,
          `/session/${children.body[0].id}/message`,
        )).body.flatMap((message) => message.parts)
        expect(parts.some((part) => part.type === "tool" && part.tool === "write")).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(after)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    60_000,
  )

  it.live("subagent sessions are listed under their parent for the IDE panel", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true })
      const parent = yield* json<{ id: string }>(directory, "/session", { method: "POST", body: "{}" })
      const child = yield* json<{ id: string; parentID: string }>(directory, "/session", {
        method: "POST",
        body: JSON.stringify({ parentID: parent.body.id, title: "explore" }),
      })
      expect(child.body.parentID).toBe(parent.body.id)
      const children = yield* json<{ id: string }[]>(directory, `/session/${parent.body.id}/children`)
      expect(children.body.map((item) => item.id)).toEqual([child.body.id])
    }).pipe(Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )
})

describe("IDE hunk fixtures (XCOD-333)", () => {
  it.live("sdks/ide/fixtures/hunks is what hunk-fixtures.ts generates", () =>
    Effect.sync(() => {
      const committed = readdirSync(fixtureDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8")))
      expect(committed).toEqual(fixtures().sort((a, b) => a.name.localeCompare(b.name)))
    }),
  )
})
