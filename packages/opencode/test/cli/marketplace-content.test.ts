// Subprocess coverage for `marketplace search`/`install` and `plugin add`, driven like
// mcp-add-marketplace.test.ts: real CLI binary, isolated $HOME, `--yes` for the non-interactive path.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
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
    "a real fault (unwritable config) keeps the Unexpected error banner",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // Only expected refusals are demoted to plain messages; a genuine I/O fault must still read
        // as a crash, or the user can't tell "Lunos said no" from "Lunos broke".
        yield* setup(home, opencode)
        const file = path.join(home, ".config", "opencode", "opencode.json")
        yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
        if (!(yield* Effect.promise(() => Filesystem.exists(file)))) yield* Effect.promise(() => Bun.write(file, "{}"))
        yield* Effect.promise(() => fs.chmod(file, 0o444))
        try {
          const result = yield* opencode.spawn([
            "marketplace",
            "install",
            "format-on-edit",
            "--yes",
            "--allow-unreviewed",
          ])
          opencode.expectExit(result, 1, "marketplace install")
          expect(result.stderr).toContain("Unexpected error")
        } finally {
          yield* Effect.promise(() => fs.chmod(file, 0o644))
        }
      }),
    60_000,
  )

  cliIt.concurrent(
    "reports a refused install as a plain error, without the Unexpected error banner",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode, { ...allKinds, hooks: [{ ...allKinds.hooks[0], event: "PostToolUse" }] })
        const result = yield* opencode.spawn([
          "marketplace",
          "install",
          "format-on-edit",
          "--yes",
          "--allow-unreviewed",
        ])
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
        const result = yield* opencode.spawn([
          "marketplace",
          "install",
          "format-on-edit",
          "--yes",
          "--allow-unreviewed",
        ])
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
        const result = yield* opencode.spawn(["marketplace", "install", "team-skills", "--yes", "--allow-unreviewed"])
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
          yield* opencode.spawn(["marketplace", "install", "a-server", "--yes", "--allow-unreviewed"]),
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
        const result = yield* opencode.spawn(["marketplace", "install", "future", "--yes", "--allow-unreviewed"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("does not dispatch")
        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config?.hooks).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "--from a manifest named like an added marketplace refuses plainly, never as ambiguous (XCOD-112)",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        // A second manifest publishing under the same name, e.g. a local checkout of the site copy.
        const copy = path.join(home, "copy", "marketplace.json")
        yield* Effect.promise(() => Bun.write(copy, JSON.stringify(allKinds)))
        const result = yield* opencode.spawn([
          "marketplace",
          "install",
          "mp/a-plugin",
          "--kind",
          "plugin",
          "--from",
          copy,
          "--yes",
        ])
        opencode.expectExit(result, 1, "marketplace install --from")
        const out = result.stdout + result.stderr
        expect(out).toContain('a marketplace named "mp" is already added from')
        expect(out).not.toContain("more than one place")
        expect(out).not.toContain("Unexpected error")
        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(JSON.stringify(config?.marketplace ?? [])).not.toContain("copy")
        expect(config?.plugin).toBeUndefined()
      }),
    60_000,
  )

  // XCOD-105: review status at install time.
  cliIt.concurrent(
    "a community entry is refused without --allow-unreviewed, writing nothing",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode, {
          ...allKinds,
          mcp: [{ ...allKinds.mcp[0], review: { status: "community" }, license: "MIT" }],
        })
        const result = yield* opencode.spawn(["marketplace", "install", "a-server", "--yes"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("is a community entry")
        expect(result.stdout + result.stderr).toContain("--allow-unreviewed")
        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config?.mcp?.["a-server"]).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "org policy that locks marketplace_unreviewed: false refuses --allow-unreviewed",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        const managed = path.join(home, "managed")
        yield* Effect.promise(async () => {
          await fs.mkdir(managed, { recursive: true })
          await fs.writeFile(
            path.join(managed, "managed.json"),
            JSON.stringify({ $locked: ["marketplace_unreviewed"], marketplace_unreviewed: false }),
          )
        })
        const result = yield* opencode.spawn(["marketplace", "install", "a-server", "--yes", "--allow-unreviewed"], {
          env: { OPENCODE_TEST_MANAGED_CONFIG_DIR: managed },
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("marketplace_unreviewed is set by your organisation's policy")
      }),
    60_000,
  )

  cliIt.concurrent(
    "a verified plugin whose integrity doesn't match the registry is refused before anything is installed",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const registry = Bun.serve({
          port: 0,
          fetch: (request) =>
            new URL(request.url).pathname === "/a-plugin/1.2.3"
              ? Response.json({ name: "a-plugin", version: "1.2.3", dist: { integrity: "sha512-REPUBLISHED" } })
              : new Response("not found", { status: 404 }),
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.stop(true)))
        yield* setup(home, opencode, {
          ...allKinds,
          plugins: [
            {
              ...allKinds.plugins[0],
              review: { status: "verified", reviewed_version: "1.2.3", reviewer: "Jane Doe" },
              integrity: "sha512-REVIEWED",
            },
          ],
        })
        const result = yield* opencode.spawn(["marketplace", "install", "a-plugin", "--yes"], {
          env: { npm_config_registry: `http://127.0.0.1:${registry.port}` },
        })
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("the reviewed integrity is sha512-REVIEWED")
        const config = yield* Effect.promise(() => readGlobalConfig(home))
        expect(config?.plugin).toBeUndefined()
      }),
    60_000,
  )

  cliIt.concurrent(
    "an unknown name fails with a pointer to search",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        yield* setup(home, opencode)
        const result = yield* opencode.spawn(["marketplace", "install", "nope", "--yes", "--allow-unreviewed"])
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
