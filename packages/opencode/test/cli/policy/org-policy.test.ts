// XCOD-102: a locked `share` can't be reopened from any surface. Real CLI, fake LLM, isolated HOME;
// the managed directory is the test hook, pointed inside the isolated home.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../../lib/cli-process"

const setup = (home: string, managed: object, user: object) =>
  Effect.promise(async () => {
    const managedDir = path.join(home, "managed")
    await fs.mkdir(managedDir, { recursive: true })
    await fs.writeFile(path.join(managedDir, "managed.json"), JSON.stringify(managed))
    const userDir = path.join(home, ".config", "opencode")
    await fs.mkdir(userDir, { recursive: true })
    await fs.writeFile(path.join(userDir, "opencode.json"), JSON.stringify(user))
    return { OPENCODE_TEST_MANAGED_CONFIG_DIR: managedDir }
  })

describe("organisation policy: locked share (subprocess)", () => {
  cliIt.live(
    "user config share: manual, OPENCODE_AUTO_SHARE=1 and run --share are all refused",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const env = yield* setup(home, { $locked: ["share"], share: "disabled" }, { share: "manual" })
        yield* llm.text("hello")
        const result = yield* opencode.run("hi", {
          extraArgs: ["--share"],
          printLogs: true,
          env: { ...env, OPENCODE_AUTO_SHARE: "1" },
        })
        const out = result.stdout + result.stderr
        expect(out).toContain("share is set by your organisation's policy")
        expect(out).not.toContain("opncd.ai/s/")
        // The model call itself still ran: the policy refuses sharing, not the session.
        expect(out).toContain("hello")
      }),
    90_000,
  )

  cliIt.live(
    "OPENCODE_AUTO_SHARE can't turn a locked manual share into auto",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const env = yield* setup(home, { $locked: ["share"], share: "manual" }, {})
        yield* llm.text("hello")
        const result = yield* opencode.run("hi", { printLogs: true, env: { ...env, OPENCODE_AUTO_SHARE: "1" } })
        const out = result.stdout + result.stderr
        expect(out).toContain("share is set by your organisation's policy")
        expect(out).toContain("OPENCODE_AUTO_SHARE")
        expect(out).not.toContain("opncd.ai/s/")
      }),
    90_000,
  )

  cliIt.live(
    "debug config shows the managed value and the lock, not the user's",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        yield* llm.text("hello")
        const env = yield* setup(
          home,
          { $locked: ["residency"], residency: { allow: ["eu"] } },
          {
            residency: { allow: ["eu", "us"], audit: false },
          },
        )
        const result = yield* opencode.spawn(["debug", "config"], { env })
        const config = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")))
        expect(config.residency).toEqual({ allow: ["eu"] })
        expect(config.$locked).toEqual(["residency"])
        // The server's config endpoint must still encode a locked residency (a deep clone once broke
        // the Schema class instance, and `run` silently got no config).
        const run = yield* opencode.run("hi", { printLogs: true, env })
        expect(run.stdout + run.stderr).not.toContain("schema rejection")
      }),
    60_000,
  )
})

describe("lunos debug config --sources (subprocess)", () => {
  cliIt.live(
    "shows which layer set each key and which keys are locked",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const env = yield* setup(
          home,
          { $locked: ["share"], share: "disabled", autoupdate: "notify" },
          { share: "manual", username: "someone" },
        )
        const result = yield* opencode.spawn(["debug", "config", "--sources"], { env })
        opencode.expectExit(result, 0, "debug config --sources")
        const row = (key: string) => result.stdout.split("\n").find((line) => line.startsWith(key + " "))
        expect(row("share")).toMatch(/managed\s+locked\s+.*managed\.json/)
        expect(row("autoupdate")).toMatch(/managed\s+\S*managed\.json/)
        expect(row("autoupdate")).not.toContain("locked")
        expect(row("username")).toMatch(/global\s+/)
      }),
    60_000,
  )
})

describe("organisation policy: marketplace allowlist (subprocess)", () => {
  const manifest = (name: string) => ({
    name,
    owner: { name },
    plugins: [],
    mcp: [{ name: "srv", type: "remote", url: "https://example.test/mcp" }],
  })

  cliIt.live(
    "add and install --from are refused for a source off a locked allow list; the built-in is listed as refused",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const allowed = path.join(home, "allowed.json")
        const other = path.join(home, "other.json")
        yield* Effect.promise(() => fs.writeFile(allowed, JSON.stringify(manifest("allowed-mp"))))
        yield* Effect.promise(() => fs.writeFile(other, JSON.stringify(manifest("other-mp"))))
        const env = yield* setup(home, { $locked: ["marketplace_allow"], marketplace_allow: [allowed] }, {})

        const add = yield* opencode.spawn(["marketplace", "add", other], { env })
        expect(add.exitCode).not.toBe(0)
        expect(add.stdout + add.stderr).toContain("marketplace_allow is set by your organisation's policy")

        const install = yield* opencode.spawn(["marketplace", "install", "srv", "--from", other, "--yes"], { env })
        expect(install.exitCode).not.toBe(0)
        expect(install.stdout + install.stderr).toContain("marketplace_allow is set by your organisation's policy")

        opencode.expectExit(yield* opencode.spawn(["marketplace", "add", allowed], { env }), 0, "add allowed")
        const list = yield* opencode.spawn(["marketplace", "list"], { env })
        const out = list.stdout + list.stderr
        expect(out).toContain("allowed-mp")
        expect(out).toContain("not on your organisation's allowed marketplace list")
      }),
    90_000,
  )
})
