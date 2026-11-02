// XCOD-219: a locked `model` is the one actually used. Real CLI, fake LLM, isolated HOME; the managed
// directory is the test hook, pointed inside the isolated home.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../../lib/cli-process"

// A second model on the fake provider, so there is another real model to be refused.
const other = {
  provider: {
    test: {
      models: {
        "other-model": {
          id: "other-model",
          name: "Other Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100_000, output: 10_000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
    },
  },
}

const setup = (home: string, managed: object | undefined, user: object = {}) =>
  Effect.promise(async () => {
    const managedDir = path.join(home, "managed")
    const log = path.join(home, "audit", "audit.log")
    await fs.mkdir(managedDir, { recursive: true })
    if (managed) await fs.writeFile(path.join(managedDir, "managed.json"), JSON.stringify(managed))
    const userDir = path.join(home, ".config", "opencode")
    await fs.mkdir(userDir, { recursive: true })
    await fs.writeFile(
      path.join(userDir, "opencode.json"),
      JSON.stringify({ ...other, ...user, audit: { enabled: true, path: log } }),
    )
    return { env: { OPENCODE_TEST_MANAGED_CONFIG_DIR: managedDir }, log }
  })

const events = (log: string) =>
  Effect.promise(() =>
    fs
      .readFile(log, "utf8")
      .catch(() => "")
      .then((text) =>
        text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      ),
  )

describe("organisation policy: locked model (subprocess)", () => {
  cliIt.live(
    "run --model with another model is refused with the policy message and audited; the locked model works",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const { env, log } = yield* setup(home, { $locked: ["model"], model: "test/test-model" })
        yield* llm.text("hello")

        const refused = yield* opencode.run("hi", { model: "test/other-model", env })
        const out = refused.stdout + refused.stderr
        expect(out).toContain("model is set by your organisation's policy and can't be changed here")
        expect(out).toContain("it is set to test/test-model")
        expect(refused.exitCode).not.toBe(0)
        expect(out).not.toContain("hello")
        expect(yield* events(log)).toContainEqual(
          expect.objectContaining({
            event: "policy.override_refused",
            key: "model",
            via: "session model test/other-model",
          }),
        )

        const ok = yield* opencode.run("hi", { model: "test/test-model", env })
        opencode.expectExit(ok, 0, "run with the locked model")
        expect(ok.stdout + ok.stderr).toContain("hello")
        expect(ok.stdout + ok.stderr).not.toContain("organisation's policy")
      }),
    90_000,
  )

  cliIt.live(
    "lunos models tags every other model as locked",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        const { env } = yield* setup(home, { $locked: ["model"], model: "test/test-model" })
        const result = yield* opencode.spawn(["models", "test"], { env })
        opencode.expectExit(result, 0, "models")
        const row = (id: string) => result.stdout.split("\n").find((line) => line.startsWith(id))
        expect(row("test/other-model")).toBe("test/other-model\tlocked by your organisation (model)")
        expect(row("test/test-model")).toBe("test/test-model")
      }),
    60_000,
  )

  cliIt.live(
    "a locked agent model is offered and works in that agent's mode, and only there",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const { env, log } = yield* setup(home, {
          $locked: ["model", "agent.plan.model"],
          model: "test/test-model",
          agent: { plan: { model: "test/other-model" } },
        })
        const models = yield* opencode.spawn(["models", "test"], { env })
        expect(models.stdout).not.toContain("locked by your organisation")

        yield* llm.text("hello")
        const plan = yield* opencode.run("hi", { agent: "plan", model: "test/other-model", env })
        opencode.expectExit(plan, 0, "plan on its locked model")
        expect(plan.stdout + plan.stderr).toContain("hello")

        const build = yield* opencode.run("hi", { model: "test/other-model", env })
        expect(build.exitCode).not.toBe(0)
        expect(build.stdout + build.stderr).toContain("it is set to test/test-model")
        expect(yield* events(log)).toContainEqual(
          expect.objectContaining({ event: "policy.override_refused", key: "model" }),
        )
      }),
    90_000,
  )

  cliIt.live(
    "a command's own model is ignored under the lock, not refused",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const { env, log } = yield* setup(
          home,
          { $locked: ["model"], model: "test/test-model" },
          { command: { greet: { template: "say hi", model: "test/other-model" } } },
        )
        yield* llm.text("hello")
        const result = yield* opencode.run("", { command: "greet", env })
        opencode.expectExit(result, 0, "command with its own model")
        expect(result.stdout + result.stderr).toContain("hello")
        expect((yield* events(log)).some((line) => line.event === "policy.override_refused")).toBe(false)
      }),
    90_000,
  )

  cliIt.live(
    "without a lock nothing changes",
    ({ llm, opencode, home }) =>
      Effect.gen(function* () {
        const { env, log } = yield* setup(home, { model: "test/test-model" })
        yield* llm.text("hello")
        const result = yield* opencode.run("hi", { model: "test/other-model", env })
        opencode.expectExit(result, 0, "run without a lock")
        expect(result.stdout + result.stderr).toContain("hello")
        expect((yield* events(log)).some((line) => line.event === "policy.override_refused")).toBe(false)
        const models = yield* opencode.spawn(["models", "test"], { env })
        expect(models.stdout).not.toContain("locked by your organisation")
      }),
    90_000,
  )
})
