// XCOD-128: `lunos settings list|get|set` against the real CLI, isolated HOME. Values written here
// are read back through the live config loader (`lunos debug config`), not just the settings decode.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"

const userFile = (home: string) => path.join(home, ".config", "opencode", "opencode.json")

const seed = (home: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(userFile(home)), { recursive: true })
    await fs.writeFile(userFile(home), text)
  })

const resolved = (stdout: string) => JSON.parse(stdout.slice(stdout.indexOf("{")))

describe("lunos settings (subprocess)", () => {
  cliIt.live(
    "set writes the user config, keeps comments, and the live loader reads it back",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* seed(home, '{\n  // my comment\n  "$schema": "https://lunos.tech/config.json"\n}\n')
        const share = yield* opencode.spawn(["settings", "set", "share", "manual"])
        expect(share.exitCode).toBe(0)
        const depth = yield* opencode.spawn(["settings", "set", "subagent_depth", "2"])
        expect(depth.exitCode).toBe(0)
        const text = yield* Effect.promise(() => fs.readFile(userFile(home), "utf8"))
        expect(text).toContain("// my comment")
        const config = resolved((yield* opencode.spawn(["debug", "config"])).stdout)
        expect(config.share).toBe("manual")
        expect(config.subagent_depth).toBe(2)
        const get = yield* opencode.spawn(["settings", "get", "share"])
        expect(get.stdout.trim()).toBe("manual")
        const list = yield* opencode.spawn(["settings", "list", "--json"])
        const row = JSON.parse(list.stdout).find((item: { key: string }) => item.key === "share")
        expect(row).toMatchObject({ value: "manual", source: "user", locked: false })
      }),
    90_000,
  )

  cliIt.live(
    "an invalid value exits non-zero, lists the allowed values and writes nothing",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        // With $schema already there: the loader adds it to files that lack it, which isn't a write of ours.
        const before =
          '{\n  // untouched\n  "$schema": "https://lunos.tech/config.json",\n  "autoupdate": "notify"\n}\n'
        yield* seed(home, before)
        const result = yield* opencode.spawn(["settings", "set", "autoupdate", "sometimes"])
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("Allowed values: true, false, notify")
        expect(yield* Effect.promise(() => fs.readFile(userFile(home), "utf8"))).toBe(before)
      }),
    60_000,
  )

  cliIt.live(
    "a key locked by managed config is refused with the policy message",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const managed = path.join(home, "managed")
        yield* Effect.promise(async () => {
          await fs.mkdir(managed, { recursive: true })
          await fs.writeFile(
            path.join(managed, "managed.json"),
            JSON.stringify({ $locked: ["share"], share: "manual" }),
          )
        })
        const seeded = '{\n  "$schema": "https://lunos.tech/config.json"\n}\n'
        yield* seed(home, seeded)
        const env = { OPENCODE_TEST_MANAGED_CONFIG_DIR: managed }
        const result = yield* opencode.spawn(["settings", "set", "share", "auto"], { env })
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain(
          "share is set by your organisation's policy and can't be changed here",
        )
        expect(yield* Effect.promise(() => fs.readFile(userFile(home), "utf8"))).toBe(seeded)
        const list = yield* opencode.spawn(["settings", "list"], { env })
        expect(list.stdout).toMatch(/share\s+manual\s+managed 🔒/)
      }),
    60_000,
  )
})
