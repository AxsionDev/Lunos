// XCOD-185: `lunos sync on|off|status|link` through the real CLI against the fake control plane
// (test/cloud/fixtures/fake-sync-plane.ts). The session is a fake token in the file store, the
// endpoint comes from global config, as it does for real use.
import { describe, expect } from "bun:test"
import { parse } from "jsonc-parser"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"
import * as Fake from "../cloud/fixtures/fake-sync-plane"

const setup = (home: string, plane: Fake.FakeSyncPlane, opts: { signedIn?: boolean; locked?: boolean; project?: string } = {}) =>
  Effect.promise(async () => {
    const managed = path.join(home, "managed")
    await fs.mkdir(managed, { recursive: true })
    await fs.writeFile(
      path.join(managed, "managed.json"),
      JSON.stringify(opts.locked ? { $locked: ["sync"], sync: false } : {}),
    )
    const config = path.join(home, ".config", "opencode")
    await fs.mkdir(config, { recursive: true })
    await fs.writeFile(path.join(config, "opencode.json"), JSON.stringify({ cloud: { endpoint: plane.url } }))
    if (opts.signedIn !== false) {
      const cloud = path.join(home, ".local", "share", "opencode", "cloud")
      await fs.mkdir(cloud, { recursive: true })
      await fs.writeFile(
        path.join(cloud, "session.json"),
        JSON.stringify({
          issuer: plane.issuer,
          clientID: "lunos-cli",
          tokens: { access_token: Fake.TOKEN, token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
          email: "tester@example.com",
          sub: Fake.SUB,
          savedAt: new Date().toISOString(),
        }),
      )
    }
    return { OPENCODE_TEST_MANAGED_CONFIG_DIR: managed, LUNOS_CLOUD_STORE: "file" }
  })

const withPlane = Effect.acquireRelease(
  Effect.sync(() => Fake.start()),
  (plane) => Effect.sync(() => plane.stop()),
)

describe("lunos sync (subprocess)", () => {
  cliIt.live(
    "off then status shows off, on flips it back",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const plane = yield* withPlane
        const env = yield* setup(home, plane)
        const off = yield* opencode.spawn(["sync", "off"], { env })
        opencode.expectExit(off, 0, "sync off")
        expect(off.stdout).toContain("Session sync is off for this device")
        expect(plane.device()!.syncEnabled).toBe(false)
        const status = yield* opencode.spawn(["sync", "status"], { env })
        opencode.expectExit(status, 0, "sync status")
        expect(status.stdout).toContain("tester@example.com")
        expect(status.stdout).toContain(plane.url)
        expect(status.stdout).toMatch(/device switch:\s+off/)
        expect(status.stdout).toContain("allows sync")
        expect(status.stdout).toContain("personal space")
        const on = yield* opencode.spawn(["sync", "on"], { env })
        expect(on.stdout).toContain("Session sync is on for this device")
        expect(plane.device()!.syncEnabled).toBe(true)
      }),
    120_000,
  )

  cliIt.live(
    "on under a locked-off policy prints the policy line",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const plane = yield* withPlane
        const env = yield* setup(home, plane, { locked: true })
        const on = yield* opencode.spawn(["sync", "on"], { env })
        opencode.expectExit(on, 0, "sync on")
        expect(on.stdout).toContain("Your organisation's policy keeps session sync off (sync is locked).")
        const status = yield* opencode.spawn(["sync", "status"], { env })
        expect(status.stdout).toContain("locked off")
      }),
    120_000,
  )

  cliIt.live(
    "link writes the project, keeps other keys, validates ids, and --off writes false",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const plane = yield* withPlane
        const env = yield* setup(home, plane)
        const cwd = home // the child runs in the isolated home
        const file = path.join(cwd, ".opencode", "opencode.json")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.writeFile(file, '{\n  "$schema": "https://lunos.tech/config.json",\n  // keep\n  "model": "test/test-model"\n}\n')
        })
        const linked = yield* opencode.spawn(["sync", "link", "p1"], { env })
        opencode.expectExit(linked, 0, "sync link")
        const text = yield* Effect.promise(() => fs.readFile(file, "utf8"))
        expect(text).toContain("// keep")
        expect(parse(text)).toMatchObject({ model: "test/test-model", sync: { project: "p1" } })
        const status = yield* opencode.spawn(["sync", "status"], { env })
        expect(status.stdout).toContain("project p1")

        const bad = yield* opencode.spawn(["sync", "link", "nope"], { env })
        expect(bad.exitCode).toBe(1)
        expect(bad.stdout + bad.stderr).toContain("No project nope in your spaces.")

        opencode.expectExit(yield* opencode.spawn(["sync", "link", "--off"], { env }), 0, "link --off")
        expect(parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).sync).toBe(false)
      }),
    180_000,
  )

  cliIt.live(
    "signed out: every subcommand points at lunos login",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const plane = yield* withPlane
        const env = yield* setup(home, plane, { signedIn: false })
        for (const args of [["sync", "on"], ["sync", "off"], ["sync", "status"], ["sync", "link", "p1"]]) {
          const r = yield* opencode.spawn(args, { env })
          expect(r.exitCode).toBe(1)
          expect(r.stdout + r.stderr).toContain("Run lunos login first.")
        }
      }),
    180_000,
  )
})
