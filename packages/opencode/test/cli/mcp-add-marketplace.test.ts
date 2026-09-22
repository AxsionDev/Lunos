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

function globalConfigCandidates(home: string) {
  const dir = path.join(home, ".config", "opencode")
  return [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]
}

async function readGlobalMcpConfig(home: string): Promise<{ mcp?: Record<string, unknown> } | undefined> {
  for (const file of globalConfigCandidates(home)) {
    if (await Filesystem.exists(file)) {
      return parseJsonc(await Filesystem.readText(file))
    }
  }
  return undefined
}

// Writes back to whichever candidate file `marketplace add` already created (falling back to
// opencode.json, same default resolveConfigPath in mcp.ts uses), so seeding a config value
// directly -- without going through a CLI command that only ever writes the full ConfigMCPV1.Info
// shape -- lands in the file the CLI will actually read next.
async function writeGlobalConfig(home: string, config: Record<string, unknown>): Promise<string> {
  const candidates = globalConfigCandidates(home)
  const file = (await Promise.all(candidates.map((f) => Filesystem.exists(f)))).findIndex(Boolean)
  const target = file >= 0 ? candidates[file]! : candidates[0]!
  await Filesystem.write(target, JSON.stringify(config, null, 2))
  return target
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
    "refuses to overwrite an entry configured only with the {enabled:false} shorthand",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mp = path.join(home, "mp.json")
        yield* Effect.promise(() =>
          Bun.write(
            mp,
            manifest("collide", [{ name: "disabled-server", type: "local", command: ["npx", "-y", "disabled-pkg"] }]),
          ),
        )
        opencode.expectExit(yield* opencode.spawn(["marketplace", "add", mp]), 0, "marketplace add")

        // Seed the shorthand form directly: ConfigV1.mcp accepts `{enabled: boolean}` as an
        // alternative to the full ConfigMCPV1.Info shape, e.g. for a user disabling a server
        // without deleting its entry. That shape has no "type" field, so isMcpConfigured returns
        // false for it -- the guard must key on presence in the record, not on isMcpConfigured,
        // or a disabled server would be silently overwritten and re-enabled by this add.
        const seeded = yield* Effect.promise(() => readGlobalMcpConfig(home))
        yield* Effect.promise(() =>
          writeGlobalConfig(home, { ...seeded, mcp: { ...(seeded?.mcp ?? {}), "disabled-server": { enabled: false } } }),
        )

        const before = yield* Effect.promise(() => readGlobalMcpConfig(home))

        const result = yield* opencode.spawn(["mcp", "add", "disabled-server", "--yes"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("disabled-server")
        expect(result.stderr.toLowerCase()).toContain("already exists")

        // Compare the `mcp` subtree specifically, not the whole file: loading config through the
        // CLI self-heals a missing top-level "$schema" key (see config.ts), which would make a
        // whole-file comparison flag an unrelated, harmless side effect as a broken refusal.
        const after = yield* Effect.promise(() => readGlobalMcpConfig(home))
        expect(after?.mcp).toEqual(before?.mcp)
        expect((after?.mcp as Record<string, unknown> | undefined)?.["disabled-server"]).toEqual({ enabled: false })
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
      }),
    60_000,
  )

  cliIt.concurrent(
    "when the required variable IS set, the value is never written -- only the {env:NAME} reference is",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const mp = path.join(home, "mp.json")
        yield* Effect.promise(() =>
          Bun.write(
            mp,
            manifest("env-check-set", [
              {
                name: "needs-key-2",
                type: "local",
                command: ["npx", "-y", "some-server"],
                environment: ["API_TOKEN"],
                description: "Needs a key",
              },
            ]),
          ),
        )
        opencode.expectExit(yield* opencode.spawn(["marketplace", "add", mp]), 0, "marketplace add")

        // Spawn with the variable actually set in the environment, so there's something real for
        // the "no literal secret value" assertion below to catch if it ever regressed. The
        // sibling test above covers the "unset" branch (the warning); this one covers the branch
        // where a value exists and must still never be written literally.
        const result = yield* opencode.spawn(["mcp", "add", "needs-key-2", "--yes"], {
          env: { API_TOKEN: "leaked-value" },
        })
        opencode.expectExit(result, 0, "mcp add needs-key-2 --yes")
        expect(result.stderr).not.toContain("API_TOKEN is not set")

        const config = yield* Effect.promise(() => readGlobalMcpConfig(home))
        expect((config?.mcp as Record<string, unknown> | undefined)?.["needs-key-2"]).toEqual({
          type: "local",
          command: ["npx", "-y", "some-server"],
          enabled: true,
          environment: { API_TOKEN: "{env:API_TOKEN}" },
        })
        // Check the raw file text, not just the parsed structure, so a leak written outside the
        // `mcp` subtree -- or anywhere jsonc-parser's re-serialization might otherwise mask --
        // would still be caught.
        const rawText = yield* Effect.promise(async () => {
          for (const file of globalConfigCandidates(home)) {
            if (await Filesystem.exists(file)) return Filesystem.readText(file)
          }
          return ""
        })
        expect(rawText).toContain("{env:API_TOKEN}")
        expect(rawText).not.toContain("leaked-value")
      }),
    60_000,
  )
})
