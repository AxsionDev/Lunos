// XCOD-85: the memory-layer spike recommends `.opencode/memory/*.md` loaded through the existing
// `instructions` glob. This proves that works today, with no code, in a real `lunos run`: the
// memory file's text reaches the model's system prompt.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../../lib/cli-process"

describe("memory convention (XCOD-85)", () => {
  cliIt.live(
    "files matched by an instructions glob reach the system prompt",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const dir = path.join(home, ".config", "opencode")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(dir, "memory"), { recursive: true })
          await fs.writeFile(path.join(dir, "memory", "deploy.md"), "MEMORY-FACT-7F3A: deploys go out on Tuesdays.\n")
          await fs.writeFile(
            path.join(dir, "opencode.json"),
            JSON.stringify({ instructions: [path.join(dir, "memory", "*.md")] }),
          )
        })
        yield* llm.text("ok")
        const result = yield* opencode.run("when do deploys go out?")
        opencode.expectExit(result, 0)
        const prompts = (yield* llm.inputs).map((input) => JSON.stringify(input.messages ?? []))
        expect(prompts.some((text) => text.includes("MEMORY-FACT-7F3A"))).toBe(true)
      }),
    60_000,
  )
})
