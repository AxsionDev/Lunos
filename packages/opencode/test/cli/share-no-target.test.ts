// XCOD-266: upstream shut its share service down in v1.19.3. The real CLI, a fake LLM and an isolated
// HOME: sharing with nowhere to share to says so (always when asked, once per project for "auto"),
// `lunos import` refuses upstream's links, and a share link from your own server still imports.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

const NO_TARGET = `Sharing needs enterprise.url in config, or "share": "cloud" to share with your organisation's Lunos console (after lunos login).`
const DISCONTINUED = "opncd.ai sharing was discontinued upstream; this link can't be imported."

const userConfig = (home: string, config: object) =>
  Effect.promise(async () => {
    const dir = path.join(home, ".config", "opencode")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, "opencode.json"), JSON.stringify(config))
  })

const count = (text: string, needle: string) => text.split(needle).length - 1

describe("sharing with nowhere to share to (subprocess)", () => {
  cliIt.live(
    "run --share says what to set up, and the run itself goes on",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* userConfig(home, { share: "manual" })
        yield* llm.text("hello")
        const result = yield* opencode.run("hi", { extraArgs: ["--share"] })
        opencode.expectExit(result, 0, "run --share")
        const out = result.stdout + result.stderr
        expect(out).toContain(NO_TARGET)
        expect(out).toContain("hello")
      }),
    90_000,
  )

  cliIt.live(
    'share: "auto" says it on the first run in a project only',
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* userConfig(home, { share: "auto" })
        yield* llm.text("first")
        const first = yield* opencode.run("hi")
        opencode.expectExit(first, 0, "first run")
        yield* llm.text("second")
        const second = yield* opencode.run("hi again")
        opencode.expectExit(second, 0, "second run")

        expect(count(first.stdout + first.stderr, NO_TARGET)).toBe(1)
        expect(second.stdout + second.stderr).not.toContain(NO_TARGET)
        expect(second.stdout + second.stderr).toContain("second")
      }),
    120_000,
  )

  cliIt.live(
    "import refuses upstream's share links and exits non-zero",
    ({ opencode }) =>
      Effect.gen(function* () {
        for (const link of ["https://opncd.ai/s/abc", "https://opncd.ai/share/abc", "https://dev.opncd.ai/s/abc"]) {
          const result = yield* opencode.spawn(["import", link])
          expect(result.exitCode).not.toBe(0)
          expect(result.stdout + result.stderr).toContain(DISCONTINUED)
        }
      }),
    90_000,
  )

  cliIt.live(
    "import of a share link from your own server still works, with no organisation or enterprise.url",
    ({ opencode }) =>
      Effect.gen(function* () {
        // What a share server answers at GET /api/share/<id>/data: one flat list.
        const sessionID = "ses_eab7f4ad1ffew7EdNacjxI97Mx"
        const messageID = "msg_15480b58f001Qy5qn6OY7emDtg"
        const body = [
          {
            type: "session",
            data: {
              id: sessionID,
              slug: "shared",
              projectID: "global",
              directory: "/elsewhere",
              title: "Shared from a console",
              version: "1.0.0",
              time: { created: 1, updated: 1 },
            },
          },
          {
            type: "message",
            data: {
              id: messageID,
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
            },
          },
          {
            type: "part",
            data: { id: "prt_15480b5f7001L2vJ3h7z3Y0p0m", messageID, sessionID, type: "text", text: "shared answer" },
          },
        ]
        const requests: string[] = []
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(req) {
            requests.push(new URL(req.url).pathname)
            return Response.json(body)
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))

        const result = yield* opencode.spawn(["import", `http://127.0.0.1:${server.port}/share/abc123`])
        opencode.expectExit(result, 0, "import")
        expect(result.stdout).toContain(`Imported session: ${sessionID}`)
        expect(requests).toEqual(["/api/share/abc123/data"])
      }),
    120_000,
  )
})
