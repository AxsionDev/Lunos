import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"
import { testProviderConfig } from "../../lib/test-provider"

const TIMEOUT = 60_000

// XCOD-303: `lunos run` on the Build agent runs as a Dynamic workflow by default, so the main agent
// is never offered bash, edit or write; with "workflows": { "dynamic": false } it is.
describe("lunos run: Dynamic workflows", () => {
  const config = (llm: string, dynamic?: boolean) =>
    JSON.stringify({
      ...testProviderConfig(llm),
      workflows: dynamic === undefined ? {} : { dynamic },
    })
  const offered = (body: Record<string, unknown>) =>
    ((body.tools ?? []) as { function?: { name?: string } }[]).map((tool) => tool.function?.name)

  cliIt.concurrent(
    "default: the main agent's bash call never runs",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bash", { command: "echo main-agent-ran", description: "Echo" }))
        yield* llm.text("done")

        const result = yield* opencode.run("check", {
          format: "json",
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url) },
        })

        expect(result.stdout).not.toContain("main-agent-ran")
        const [first] = (yield* llm.inputs).filter((body) => !JSON.stringify(body).includes("Generate a title"))
        expect(offered(first)).toContain("task")
        expect(offered(first)).not.toContain("bash")
        expect(offered(first)).not.toContain("write")
      }),
    TIMEOUT,
  )

  cliIt.concurrent(
    'with "dynamic": false the main agent runs it',
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bash", { command: "echo main-agent-ran", description: "Echo" }))
        yield* llm.text("done")

        const result = yield* opencode.run("check", {
          format: "json",
          env: { OPENCODE_CONFIG_CONTENT: config(llm.url, false) },
        })

        expect(result.stdout).toContain("main-agent-ran")
      }),
    TIMEOUT,
  )
})
