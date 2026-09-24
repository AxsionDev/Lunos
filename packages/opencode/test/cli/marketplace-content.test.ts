// Subprocess coverage for `marketplace search`/`install` and `plugin add`, driven like
// mcp-add-marketplace.test.ts: real CLI binary, isolated $HOME, `--yes` for the non-interactive path.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Filesystem } from "@/util/filesystem"
import { cliIt, type OpencodeCli } from "../lib/cli-process"

const allKinds = {
  name: "mp",
  owner: { name: "mp" },
  plugins: [{ name: "a-plugin", source: { type: "npm", package: "a-plugin" }, description: "formats things" }],
  skills: [{ name: "team-skills", url: "http://127.0.0.1:9/skills/", description: "team skills" }],
  hooks: [
    {
      name: "format-on-edit",
      event: "tool.execute.after",
      command: ["prettier", "--write", "."],
      matcher: { tool: "edit" },
      description: "formats after edit",
    },
  ],
  mcp: [{ name: "a-server", type: "remote", url: "https://example.test/mcp", description: "a server" }],
}

async function readGlobalConfig(home: string): Promise<Record<string, any> | undefined> {
  const dir = path.join(home, ".config", "opencode")
  for (const file of [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")]) {
    if (await Filesystem.exists(file)) return parseJsonc(await Filesystem.readText(file))
  }
  return undefined
}

function setup(home: string, opencode: OpencodeCli, manifest: unknown = allKinds) {
  return Effect.gen(function* () {
    const file = path.join(home, "mp.json")
    yield* Effect.promise(() => Bun.write(file, JSON.stringify(manifest)))
    opencode.expectExit(yield* opencode.spawn(["marketplace", "add", file]), 0, "marketplace add")
  })
}

describe("opencode marketplace search (subprocess)", () => {
  cliIt.concurrent(
    "matches across every kind and labels each row with its kind",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        const result = yield* opencode.spawn(["marketplace", "search", "a"])
        opencode.expectExit(result, 0, "marketplace search")
        const out = result.stdout + result.stderr
        for (const row of [
          "mp/a-plugin  [plugin]",
          "mp/team-skills  [skill]",
          "mp/format-on-edit  [hook]",
          "mp/a-server  [mcp]",
        ])
          expect(out).toContain(row)
      }),
    60_000,
  )

  cliIt.concurrent(
    "--kind narrows to one kind",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        const result = yield* opencode.spawn(["marketplace", "search", "a", "--kind", "hook"])
        const out = result.stdout + result.stderr
        expect(out).toContain("mp/format-on-edit  [hook]")
        expect(out).not.toContain("[plugin]")
        expect(out).not.toContain("[mcp]")
      }),
    60_000,
  )
})

describe("opencode marketplace install (subprocess)", () => {
  cliIt.concurrent(
    "reports a refused install as a plain error, without the Unexpected error banner",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode, { ...allKinds, hooks: [{ ...allKinds.hooks[0], event: "PostToolUse" }] })
        const result = yield* opencode.spawn(["marketplace", "install", "format-on-edit", "--yes"])
        opencode.expectExit(result, 1, "marketplace install")
        expect(result.stderr).toContain('targets event "PostToolUse"')
        expect(result.stderr).not.toContain("Unexpected error")
      }),
    60_000,
  )

  cliIt.concurrent(
    "installs a hook under hooks.<event> after showing what it runs",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        const result = yield* opencode.spawn(["marketplace", "install", "format-on-edit", "--yes"])
        opencode.expectExit(result, 0, "marketplace install hook")
        const out = result.stdout + result.stderr
        expect(out).toContain("on: tool.execute.after (tool edit)")
        expect(out).toContain("runs: prettier --write .")
        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config?.hooks?.["tool.execute.after"]).toEqual([
          { command: ["prettier", "--write", "."], matcher: { tool: "edit" } },
        ])
      }),
    60_000,
  )

  cliIt.concurrent(
    "installs a skill source into skills.urls even when its index is unreachable",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        const result = yield* opencode.spawn(["marketplace", "install", "team-skills", "--yes"])
        opencode.expectExit(result, 0, "marketplace install skill")
        expect(result.stdout + result.stderr).toContain("could not read")
        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config?.skills?.urls).toEqual(["http://127.0.0.1:9/skills/"])
      }),
    60_000,
  )

  cliIt.concurrent(
    "installs an MCP server through the same path as `mcp add <name>`",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        opencode.expectExit(
          yield* opencode.spawn(["marketplace", "install", "a-server", "--yes"]),
          0,
          "marketplace install mcp",
        )
        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config?.mcp?.["a-server"]).toMatchObject({ type: "remote", url: "https://example.test/mcp" })
      }),
    60_000,
  )

  cliIt.concurrent(
    "refuses a hook for an event this version does not dispatch, writing nothing",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode, {
          ...allKinds,
          hooks: [{ name: "future", event: "session.someday", command: ["true"] }],
        })
        const result = yield* opencode.spawn(["marketplace", "install", "future", "--yes"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("does not dispatch")
        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config?.hooks).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "an unknown name fails with a pointer to search",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        const result = yield* opencode.spawn(["marketplace", "install", "nope", "--yes"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("marketplace search")
      }),
    60_000,
  )
})

describe("opencode plugin add (subprocess)", () => {
  cliIt.concurrent(
    "an unknown plugin name fails without touching config",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        const result = yield* opencode.spawn(["plugin", "add", "not-a-plugin"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("No plugin named")
      }),
    60_000,
  )
})
