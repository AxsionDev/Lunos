// Subprocess coverage for the marketplace branch of `mcp add`, and for `mcp search`. The `--yes`
// flag makes every one of these paths fully non-interactive, so — unlike the confirm/select
// prompts elsewhere in this command — they can be driven exactly like the existing
// `mcp-add.test.ts` suite: real CLI binary, isolated $HOME, no mocking of @clack/prompts.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { cliIt } from "../lib/cli-process"

type ManifestMcpEntry = {
  name: string
  type: "local" | "remote"
  command?: string[]
  url?: string
  environment?: string[]
  description?: string
}

function manifest(name: string, mcp: ManifestMcpEntry[]) {
  return JSON.stringify({ name, owner: { name }, plugins: [], mcp })
}

async function readGlobalMcpConfig(home: string): Promise<{ mcp?: Record<string, unknown> } | undefined> {
  const dir = path.join(home, ".config", "opencode")
  for (const file of [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]) {
    if (await Filesystem.exists(file)) {
      return parseJsonc(await Filesystem.readText(file))
    }
  }
  return undefined
}

describe("opencode mcp add <name> (marketplace, subprocess)", () => {
  cliIt.concurrent(
    "an ambiguous name refuses to write and lists every marketplace/name form",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mpA = path.join(home, "mp-a.json")
        const mpB = path.join(home, "mp-b.json")
        yield* Effect.promise(() =>
          Bun.write(mpA, manifest("mp-a", [{ name: "filesystem", type: "local", command: ["npx", "-y", "fs-a"] }])),
        )
        yield* Effect.promise(() =>
          Bun.write(mpB, manifest("mp-b", [{ name: "filesystem", type: "local", command: ["npx", "-y", "fs-b"] }])),
        )

        opencode.expectExit(yield* opencode.spawn(["marketplace", "add", mpA]), 0, "marketplace add mp-a")
        opencode.expectExit(yield* opencode.spawn(["marketplace", "add", mpB]), 0, "marketplace add mp-b")

        const result = yield* opencode.spawn(["mcp", "add", "filesystem", "--yes"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("mp-a/filesystem")
        expect(result.stderr).toContain("mp-b/filesystem")

        // Nothing should have been written by the refused add.
        const config = yield* Effect.promise(() => readGlobalMcpConfig(home))
        expect((config?.mcp as Record<string, unknown> | undefined)?.["filesystem"]).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "an unknown name falls through to the existing --url/-- validation",
    ({ opencode }) =>
      Effect.gen(function* () {
        const result = yield* opencode.spawn(["mcp", "add", "does-not-exist"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("Provide either --url <url> or a command after --")
      }),
    60_000,
  )

  cliIt.concurrent(
    "refuses to overwrite an existing MCP server entry",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Seed a config entry the old-fashioned way (the pre-existing --url branch), then add a
        // marketplace that also declares a server called "seeded".
        opencode.expectExit(
          yield* opencode.spawn(["mcp", "add", "seeded", "--url", "https://seed.example/mcp"]),
          0,
          "seed mcp add",
        )

        const mp = path.join(home, "mp.json")
        yield* Effect.promise(() =>
          Bun.write(mp, manifest("collide", [{ name: "seeded", type: "local", command: ["npx", "-y", "seeded-pkg"] }])),
        )
        opencode.expectExit(yield* opencode.spawn(["marketplace", "add", mp]), 0, "marketplace add")

        const before = yield* Effect.promise(() => readGlobalMcpConfig(home))

        const result = yield* opencode.spawn(["mcp", "add", "seeded", "--yes"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("seeded")
        expect(result.stderr.toLowerCase()).toContain("already exists")
        expect(result.stderr).toContain("https://seed.example/mcp")

        const after = yield* Effect.promise(() => readGlobalMcpConfig(home))
        expect(after).toEqual(before)
        expect((after?.mcp as Record<string, unknown> | undefined)?.["seeded"]).toEqual({
          type: "remote",
          url: "https://seed.example/mcp",
        })
      }),
    60_000,
  )

  cliIt.concurrent(
    "the happy path with --yes writes {env:NAME} references and no literal values",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mp = path.join(home, "mp.json")
        yield* Effect.promise(() =>
          Bun.write(
            mp,
            manifest("env-check", [
              {
                name: "needs-key",
                type: "local",
                command: ["npx", "-y", "some-server"],
                environment: ["API_TOKEN"],
                description: "Needs a key",
              },
            ]),
          ),
        )
        opencode.expectExit(yield* opencode.spawn(["marketplace", "add", mp]), 0, "marketplace add")

        // Everything the command prints (progress, prompts, warnings) goes through
        // UI.println / @clack/prompts, both of which write to stderr, not stdout.
        const result = yield* opencode.spawn(["mcp", "add", "needs-key", "--yes"])
        opencode.expectExit(result, 0, "mcp add needs-key --yes")
        expect(result.stderr).toContain("npx -y some-server")
        expect(result.stderr).toContain("API_TOKEN is not set")

        const config = yield* Effect.promise(() => readGlobalMcpConfig(home))
        expect((config?.mcp as Record<string, unknown> | undefined)?.["needs-key"]).toEqual({
          type: "local",
          command: ["npx", "-y", "some-server"],
          enabled: true,
          environment: { API_TOKEN: "{env:API_TOKEN}" },
        })
        // No literal secret value anywhere in the file, only the {env:NAME} reference.
        expect(JSON.stringify(config)).not.toContain("some-secret-value")
      }),
    60_000,
  )
})
