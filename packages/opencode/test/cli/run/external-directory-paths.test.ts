// XCOD-137: external_directory rules written in a directory's real spelling must hold for every
// spelling a model reproduces, checked in a real `lunos run` subprocess. On Windows that means a
// driveless, forward-slash, lowercased path and an 8.3 short-name path; the deny direction is the
// one that matters for safety.
import { afterAll, describe, expect } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import os from "os"
import path from "path"
import { reply } from "../../lib/llm-server"
import { cliIt } from "../../lib/cli-process"

// Outside the run's project (the fixture's home), so reads here are external.
const given = mkdtempSync(path.join(os.tmpdir(), "lunos-ext-"))
const real = realpathSync.native(given)
writeFileSync(path.join(real, "secret.txt"), "external-content")
afterAll(() => rmSync(real, { recursive: true, force: true }))

const variants =
  process.platform === "win32"
    ? [
        // Driveless, `/`, lowercased: what a model copying a POSIX-looking path produces.
        path
          .join(real, "secret.txt")
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase(),
        // TEMP as the runner sets it, with 8.3 short names (C:\Users\RUNNER~1\...).
        path.join(given, "secret.txt"),
      ]
    : [path.join(real, "secret.txt")]

const readParts = (stdout: string, parse: (s: string) => Array<Record<string, unknown>>) =>
  parse(stdout)
    .filter((event) => event.type === "tool_use")
    .map((event) => (event as { part: { tool: string; state: { status: string; output?: string } } }).part)
    .filter((part) => part.tool === "read")

describe("external_directory rules in a real run", () => {
  cliIt.live(
    "an allow rule on the real spelling allows every spelling of the path",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        for (const filePath of variants) yield* llm.push(reply().tool("read", { filePath }))
        yield* llm.text("done")
        const result = yield* opencode.run("read it", {
          format: "json",
          permission: { "*": "allow", external_directory: { "*": "deny", [path.join(real, "*")]: "allow" } },
        })
        opencode.expectExit(result, 0)

        const parts = readParts(result.stdout, opencode.parseJsonEvents)
        // A failed read shows its whole state, so a CI failure says why.
        expect(parts.map((part) => (part.state.status === "completed" ? "completed" : part.state))).toEqual(
          variants.map(() => "completed"),
        )
        for (const part of parts) expect(part.state.output).toContain("external-content")
      }),
    90_000,
  )

  cliIt.live(
    "a deny rule on the real spelling denies every spelling of the path",
    ({ llm, opencode }) =>
      Effect.gen(function* () {
        for (const filePath of variants) yield* llm.push(reply().tool("read", { filePath }))
        yield* llm.text("done")
        const result = yield* opencode.run("read it", {
          format: "json",
          permission: { "*": "allow", external_directory: { "*": "allow", [path.join(real, "*")]: "deny" } },
        })
        opencode.expectExit(result, 0)

        const parts = readParts(result.stdout, opencode.parseJsonEvents)
        expect(parts).toHaveLength(variants.length)
        for (const part of parts) {
          expect(part.state.status).not.toBe("completed")
          expect(JSON.stringify(part.state)).not.toContain("external-content")
        }
      }),
    90_000,
  )
})
