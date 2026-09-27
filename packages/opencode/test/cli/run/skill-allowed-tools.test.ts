// XCOD-83: a skill's `allowed-tools` restricts what the agent can do while it's active, checked in a
// real `lunos run` subprocess. Matched A/B, as in the XCOD-71 port report: the same scripted
// write, with and without the read-only skill loaded first. Only the skill load differs.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

async function installSkill(home: string) {
  const dir = path.join(home, ".claude", "skills", "read-only-probe")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    "---\nname: read-only-probe\ndescription: Investigate without changing anything\nallowed-tools: Read, Grep, Glob\n---\n\nRead-only.\n",
  )
}

describe("skill allowed-tools in a real run", () => {
  cliIt.live(
    "with the read-only skill loaded, a write in the same turn is blocked",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installSkill(home))
        const target = path.join(home, "target.txt")
        yield* llm.push(reply().tool("skill", { name: "read-only-probe" }))
        yield* llm.push(reply().tool("write", { filePath: target, content: "EDITED" }))
        yield* llm.text("done")
        const result = yield* opencode.run("investigate", { permission: { "*": "allow" }, format: "json" })
        opencode.expectExit(result, 0)

        const exists = yield* Effect.promise(() =>
          fs.access(target).then(
            () => true,
            () => false,
          ),
        )
        expect(exists).toBe(false)
        const tools = opencode
          .parseJsonEvents(result.stdout)
          .filter((event) => event.type === "tool_use")
          .map((event) => (event as { part: { tool: string; state: { status: string } } }).part)
        expect(tools.find((part) => part.tool === "skill")?.state.status).toBe("completed")
        expect(tools.find((part) => part.tool === "write")?.state.status).not.toBe("completed")
      }),
    90_000,
  )

  cliIt.live(
    "control: without the skill loaded, the same write applies",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installSkill(home))
        const target = path.join(home, "target.txt")
        yield* llm.push(reply().tool("write", { filePath: target, content: "EDITED" }))
        yield* llm.text("done")
        const result = yield* opencode.run("edit", { permission: { "*": "allow" } })
        opencode.expectExit(result, 0)
        expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("EDITED")
      }),
    90_000,
  )

  cliIt.live(
    "hook scripts see the active agent and skill in their environment",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => installSkill(home))
        const log = path.join(home, "hook-env.log")
        const script = path.join(home, "record-env.sh")
        yield* Effect.promise(async () => {
          await fs.writeFile(script, `#!/bin/sh\necho "$LUNOS_TOOL agent=$LUNOS_AGENT skill=$LUNOS_SKILL" >> ${log}\n`)
          await fs.chmod(script, 0o755)
          // Real config file through the live config path (the XCOD-68 lesson), merged with the
          // harness's inline provider config.
          const dir = path.join(home, ".config", "opencode")
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(
            path.join(dir, "opencode.json"),
            JSON.stringify({ hooks: { "tool.execute.before": [{ command: [script] }] } }),
          )
        })
        yield* llm.push(reply().tool("glob", { pattern: "*.nothing" }))
        yield* llm.push(reply().tool("skill", { name: "read-only-probe" }))
        yield* llm.push(reply().tool("glob", { pattern: "*.nothing" }))
        yield* llm.text("done")
        const result = yield* opencode.run("look around", { permission: { "*": "allow" } })
        opencode.expectExit(result, 0)

        const lines = (yield* Effect.promise(() => fs.readFile(log, "utf8"))).trim().split("\n")
        expect(lines).toEqual([
          "glob agent=build skill=",
          "skill agent=build skill=",
          "glob agent=build skill=read-only-probe",
        ])
      }),
    90_000,
  )
})
