import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

// XCOD-167: a real run where the model calls a tool that doesn't exist.
describe("lunos run: an unknown tool", () => {
  cliIt.concurrent(
    "tells the model the tool doesn't exist and names the nearest real ones, then carries on",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bassh", { command: "echo hi" }))
        yield* llm.text("recovered")

        const result = yield* opencode.run("do it", { format: "json" })

        opencode.expectExit(result, 0)
        expect(result.stdout).toContain('There is no tool named \\"bassh\\"')
        expect(result.stdout).toContain("bash")
        expect(result.stdout).toContain("recovered")
      }),
    60_000,
  )
})
