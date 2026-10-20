// XCOD-281: a prompt sent while the sandbox is starting waits for it and runs inside it. The sandbox's
// server is a real `lunos serve` subprocess in its own directory (the workspace), behind the TUI's
// waiting transport; the model is the mock one. Its file edit lands in the workspace, not in the
// project directory the TUI started from, and nothing is asked of the model before the sandbox is up.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { SandboxBackground } from "../../src/sandbox/background"

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false,
  )

describe("a prompt queued while the sandbox starts", () => {
  cliIt.live(
    "runs inside the sandbox: its file edit lands in the sandbox's workspace, not on the host",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const workspace = home
        const host = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "lunos-host-project-")))
        yield* llm.push(reply().tool("write", { filePath: "edited.txt", content: "from the sandbox" }))
        yield* llm.text("done")
        const server = yield* opencode.serve({
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              model: "test/test-model",
              permission: { "*": "allow" },
            }),
          },
        })

        let open!: () => void
        const gate = new Promise<void>((resolve) => (open = resolve))
        const background = SandboxBackground.start({
          launch: async () => {
            await gate
            return { url: server.url, headers: {} }
          },
          failed: () => ({ status: "failed", failure: { reason: "unexpected", time: "" } }),
        })
        const sdk = createOpencodeClient({
          baseUrl: "http://opencode.internal",
          fetch: background.fetch,
          directory: workspace,
        })

        // The event stream, opened while starting, goes through the same waiting transport.
        const events: string[] = []
        const stream = (async () => {
          const subscription = await sdk.global.event()
          for await (const event of subscription.stream) {
            events.push((event as { payload?: { type?: string } }).payload?.type ?? "")
            if (events.includes("session.idle") || events.includes("session.status")) return
          }
        })()

        // Sent while starting: the session and the prompt wait.
        const sent = (async () => {
          const session = await sdk.session.create({}, { throwOnError: true })
          await sdk.session.prompt(
            {
              sessionID: session.data.id,
              parts: [{ type: "text", text: "write edited.txt" }],
              model: { providerID: "test", modelID: "test-model" },
            },
            { throwOnError: true },
          )
        })()
        yield* Effect.promise(() => Bun.sleep(500))
        expect(yield* llm.calls).toBe(0)
        expect(background.host.state().status).toBe("starting")

        open()
        yield* Effect.promise(() => sent)
        expect(yield* Effect.promise(() => fs.readFile(path.join(workspace, "edited.txt"), "utf8"))).toBe(
          "from the sandbox",
        )
        expect(yield* Effect.promise(() => exists(path.join(host, "edited.txt")))).toBe(false)
        // The TUI's live updates arrive through it too.
        yield* Effect.promise(() => Promise.race([stream, Bun.sleep(10_000)]))
        expect(events.some((type) => type.startsWith("session."))).toBe(true)
        yield* Effect.promise(() => fs.rm(host, { recursive: true, force: true }))
      }),
    90_000,
  )
})
