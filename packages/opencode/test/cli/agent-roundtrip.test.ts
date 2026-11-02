import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

// XCOD-203 AC1 (XCOD-210): an agent edited on one machine, exported, imported on a second machine
// and run there makes the same request to the model: same system prompt, same tools.

/** A second "machine": its own home, config and data, sharing nothing with the first. */
function machine(home: string) {
  return {
    OPENCODE_TEST_HOME: home,
    HOME: home,
    PWD: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  }
}

/** The system prompt and the tool names one request to the model carried. */
function request(body: Record<string, unknown>) {
  const messages = (body.messages as { role: string; content: unknown }[]) ?? []
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n")
  const tools = ((body.tools as { function?: { name?: string }; name?: string }[]) ?? [])
    .map((tool) => tool.function?.name ?? tool.name)
    .sort()
  return { system, tools }
}

describe("agent create → edit → export → import elsewhere → run (subprocess)", () => {
  cliIt.live(
    "the imported agent makes the same model request as the original",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        const config = path.join(home, ".config", "opencode")
        const other = path.join(home, "second-machine")
        const bundle = path.join(home, "reviewer.lunos-agent")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(config, "agents"), { recursive: true })
          await fs.mkdir(other, { recursive: true })
          await fs.writeFile(
            path.join(config, "agents", "reviewer.md"),
            "---\ndescription: Reviews code\nmode: all\n---\nFirst draft.\n",
          )
          await fs.writeFile(path.join(home, "prompt.txt"), "You review code. Be specific; quote the lines you mean.\n")
        })

        // Edit: a new prompt, no webfetch, ask before bash, and a step limit.
        const edited = yield* opencode.spawn([
          "agent",
          "edit",
          "reviewer",
          "--prompt-file",
          path.join(home, "prompt.txt"),
          "--permission",
          "webfetch=deny,bash=ask",
          "--steps",
          "7",
        ])
        opencode.expectExit(edited, 0, "edit")

        // A save naming a tool that doesn't exist here is refused, and the file is unchanged.
        const before = yield* Effect.promise(() => fs.readFile(path.join(config, "agents", "reviewer.md"), "utf8"))
        const refused = yield* opencode.spawn(["agent", "edit", "reviewer", "--permission", "no_such_tool=allow"])
        expect(refused.exitCode).not.toBe(0)
        expect(refused.stdout + refused.stderr).toContain(`permission "no_such_tool" doesn't match any tool`)
        expect(yield* Effect.promise(() => fs.readFile(path.join(config, "agents", "reviewer.md"), "utf8"))).toBe(
          before,
        )

        opencode.expectExit(yield* opencode.spawn(["agent", "export", "reviewer", "-o", bundle]), 0, "export")
        opencode.expectExit(
          yield* opencode.spawn(["agent", "import", bundle, "--yes"], { env: machine(other) }),
          0,
          "import on the second machine",
        )

        yield* llm.text("first")
        opencode.expectExit(yield* opencode.run("review this", { extraArgs: ["--agent", "reviewer"] }), 0, "run here")
        yield* llm.text("second")
        opencode.expectExit(
          yield* opencode.run("review this", { extraArgs: ["--agent", "reviewer"], env: machine(other) }),
          0,
          "run on the second machine",
        )

        // Each run also asks the model for a session title; that request carries no tools.
        const runs = (yield* llm.inputs).map(request).filter((item) => item.tools.length > 0)
        expect(runs).toHaveLength(2)
        const [here, there] = runs
        expect(here.system).toContain("You review code. Be specific; quote the lines you mean.")
        expect(there.system).toContain("You review code. Be specific; quote the lines you mean.")
        // webfetch is denied, so it isn't offered on either machine; the tool lists match.
        expect(here.tools).not.toContain("webfetch")
        expect(there.tools).toEqual(here.tools)
      }),
    180_000,
  )
})
