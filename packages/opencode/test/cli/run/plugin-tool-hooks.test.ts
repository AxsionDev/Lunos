// XCOD-75: v2 plugin tool hooks, exercised in a real `lunos run` subprocess. The unit-level
// ToolHooks tests can pass while nothing fires at runtime: live sessions dispatch tool calls
// through the v1 trigger, and only the bridge in src/plugin/index.ts connects the two.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

const probe = (log: string) => `
import { appendFileSync } from "fs"
export default {
  id: "tool-probe",
  setup: async (ctx) => {
    await ctx.tool["execute.before"]((event) => {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ phase: "before", tool: event.tool, args: event.args }) + "\\n")
      if (event.tool !== "bash") return
      if (event.args.command.includes("BLOCKME")) throw new Error("blocked by tool-probe")
      event.args.command = event.args.command.replace("ORIGINAL", "REWRITTEN")
    })
    await ctx.tool["execute.after"]((event) => {
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ phase: "after", tool: event.tool, output: event.output.output }) + "\\n")
    })
  },
}
`

async function install(home: string) {
  const log = path.join(home, "probe.log")
  // The harness disables project config, so the probe goes where a user's global plugins live.
  const dir = path.join(home, ".config", "opencode", "plugins")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "tool-probe.ts"), probe(log))
  return async () =>
    (await fs.readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
}

describe("v2 plugin tool hooks in a real run", () => {
  cliIt.live(
    "execute.before can rewrite args, and execute.after sees the tool output",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const entries = yield* Effect.promise(() => install(home))
        const out = path.join(home, "out.txt")
        yield* llm.push(reply().tool("bash", { command: `printf ORIGINAL > ${out}`, description: "write" }))
        yield* llm.text("done")
        const result = yield* opencode.run("use a tool", { permission: { "*": "allow" } })
        opencode.expectExit(result, 0)

        const written = yield* Effect.promise(() => fs.readFile(out, "utf8"))
        expect(written).toBe("REWRITTEN")
        const log = yield* Effect.promise(entries)
        expect(log.map((entry) => entry.phase)).toEqual(["before", "after"])
        expect(log[0]).toMatchObject({ tool: "bash" })
        expect(log[1]).toMatchObject({ tool: "bash" })
      }),
    90_000,
  )

  cliIt.live(
    "a rejecting execute.before hook aborts the first tool call of the run",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const entries = yield* Effect.promise(() => install(home))
        const marker = path.join(home, "BLOCKME-marker")
        yield* llm.push(reply().tool("bash", { command: `touch ${marker}`, description: "blocked" }))
        yield* llm.text("continued after block")
        const result = yield* opencode.run("use a tool", { permission: { "*": "allow" }, format: "json" })
        opencode.expectExit(result, 0)

        const created = yield* Effect.promise(() =>
          fs.access(marker).then(
            () => true,
            () => false,
          ),
        )
        expect(created).toBe(false)
        const log = yield* Effect.promise(entries)
        expect(log.map((entry) => entry.phase)).toEqual(["before"])
        const tool = opencode.parseJsonEvents(result.stdout).find((event) => event.type === "tool_use") as {
          part?: { state?: { status?: string; error?: string } }
        }
        expect(tool?.part?.state?.status).toBe("error")
        expect(tool?.part?.state?.error).toContain("blocked by tool-probe")
      }),
    90_000,
  )
})
