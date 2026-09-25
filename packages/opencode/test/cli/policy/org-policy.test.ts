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
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const env = yield* setup(home, { $locked: ["residency"], residency: { allow: ["eu"] } }, {
          residency: { allow: ["eu", "us"], audit: false },
        })
        const result = yield* opencode.spawn(["debug", "config"], { env })
        const config = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")))
        expect(config.residency).toEqual({ allow: ["eu"] })
        expect(config.$locked).toEqual(["residency"])
      }),
    60_000,
  )
})
