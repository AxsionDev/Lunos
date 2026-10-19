import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

const TIMEOUT = 60_000

// XCOD-164: commands that publish, reach a remote or change state outside the project ask first;
// `lunos run` can't ask, so it refuses them. Everything else still runs unasked.
describe("lunos run: outward commands", () => {
  cliIt.concurrent(
    "refuses `git push` by default",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(reply().tool("bash", { command: "git push origin main", description: "Publish" }))
        yield* llm.text("done")

        const result = yield* opencode.run("ship it", { format: "json" })

        expect(result.stderr + result.stdout).toContain("permission requested: bash (git push origin main)")
        expect(result.stdout).toContain("The user rejected permission to use this specific tool call.")
      }),
    TIMEOUT,
  )

  cliIt.concurrent(
    "still runs an ordinary command unasked, including other git commands",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("bash", { command: "git --version >/dev/null; echo ordinary-ran", description: "Echo" }),
        )
        yield* llm.text("done")

        const result = yield* opencode.run("check", { format: "json" })

        expect(result.stderr + result.stdout).not.toContain("permission requested: bash")
        expect(result.stdout).toContain("ordinary-ran")
      }),
    TIMEOUT,
  )

  cliIt.concurrent(
    "a config rule allowing it lets it run",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        yield* llm.push(
          reply().tool("bash", { command: "git push --help >/dev/null 2>&1; echo push-allowed", description: "x" }),
        )
        yield* llm.text("done")

        const result = yield* opencode.run("ship it", {
          format: "json",
          permission: { bash: { "*": "allow", "git push *": "allow" } },
        })

        expect(result.stderr + result.stdout).not.toContain("permission requested: bash")
        expect(result.stdout).toContain("push-allowed")
      }),
    TIMEOUT,
  )
})
