// XCOD-236: `lunos run --cloud` as a user runs it: the real CLI in a subprocess, against the fake
// control plane, whose workers each run a real `lunos serve` with the test's fake model. Nothing
// here reaches a hosted model, a real control plane, the keychain or this machine's own Lunos.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { $ } from "bun"
import { cliIt, type CliFixture } from "../lib/cli-process"
import { testProviderConfig } from "../lib/test-provider"
import * as Fake from "./fixtures/fake-control-plane"

const ENTRY = path.join(import.meta.dir, "../../src/index.ts")
const TIMEOUT = 120_000

/** A fake control plane serving real workers, a pushed repository, and the client signed in to it. */
function setup(input: CliFixture, extra: Record<string, unknown> = {}) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const fake = await Fake.start({
        serve: ENTRY,
        serveEnv: {
          OPENCODE_PURE: "1",
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          OPENCODE_DISABLE_MODELS_FETCH: "1",
          OPENCODE_DISABLE_AUTOCOMPACT: "1",
          OPENCODE_AUTH_CONTENT: "{}",
          ...(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH
            ? { BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH }
            : {}),
        },
      })
      // The session `lunos login` would have saved, in the client's own (throwaway) data directory.
      const store = path.join(input.home, ".local/share/opencode/cloud/session.json")
      await fs.mkdir(path.dirname(store), { recursive: true })
      await fs.writeFile(
        store,
        JSON.stringify({
          issuer: fake.issuer,
          clientID: "lunos-cli",
          tokens: { access_token: Fake.TOKEN, token_type: "Bearer", expires_at: Math.floor(Date.now() / 1000) + 3600 },
          sub: "ada",
          savedAt: new Date().toISOString(),
        }),
      )
      // The repository, beside HOME rather than in it, with its commit on the "remote".
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-cloud-run-"))
      const remote = path.join(root, "remote.git")
      const work = path.join(root, "work")
      await $`git init -q --bare -b main ${remote}`.quiet()
      await $`git clone -q ${remote} ${work}`.quiet()
      await fs.writeFile(path.join(work, "calc.py"), "def add(a, b):\n    return a + b\n")
      await fs.writeFile(path.join(work, ".gitignore"), ".opencode/\n")
      await $`git -C ${work} add -A`.quiet()
      await $`git -C ${work} -c user.email=t@t -c user.name=t commit -qm init`.quiet()
      await $`git -C ${work} push -q origin HEAD:main`.quiet()
      await $`git -C ${work} branch -q --set-upstream-to=origin/main`.quiet()
      // The client's config; the worker gets the same one, named as a secret, as a user would send it.
      const config = JSON.stringify({ ...testProviderConfig(input.llm.url), cloud: { endpoint: fake.url }, ...extra })
      const env = { LUNOS_CLOUD_STORE: "file", OPENCODE_CONFIG_CONTENT: config, GIT_CONFIG_NOSYSTEM: "1" }
      return { fake, root, remote, work, env }
    }),
    ({ fake, root }) =>
      Effect.promise(async () => {
        fake.stop()
        await fs.rm(root, { recursive: true, force: true })
      }),
  )
}

const noTrace = (stderr: string) => {
  expect(stderr).not.toContain("TypeError")
  expect(stderr).not.toMatch(/^\s+at /m)
}

describe("lunos run --cloud (XCOD-236)", () => {
  cliIt.live(
    "--cloud-secret before the message takes one name, repeated or comma-separated; the message is sent",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, env } = yield* setup(input)
        yield* input.llm.text("done on the worker")
        const result = yield* input.opencode.spawn(
          [
            "run",
            "--cloud",
            "--dir",
            work,
            "--cloud-secret",
            "OPENCODE_CONFIG_CONTENT",
            "--cloud-secret=EXTRA_A,EXTRA_B",
            "say hi",
          ],
          { timeoutMs: 90_000, env: { ...env, EXTRA_A: "a", EXTRA_B: "b" } },
        )
        input.opencode.expectExit(result, 0)
        expect(result.stdout).toContain("done on the worker")
        const put = fake.requests.find((r) => r.method === "PUT")!
        expect(Object.keys(put.body.secrets).sort()).toEqual(["EXTRA_A", "EXTRA_B", "OPENCODE_CONFIG_CONTENT"])
        expect(JSON.stringify(yield* input.llm.inputs)).toContain("say hi")
        expect(result.stderr).toMatch(/cloud: finished/)
      }),
    TIMEOUT,
  )

  cliIt.live(
    "a run the worker refuses for residency exits non-zero and says it failed",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, env } = yield* setup(input, { residency: { allow: ["eu"] } })
        yield* input.llm.text("must never be asked")
        const result = yield* input.opencode.spawn(
          ["run", "--cloud", "--dir", work, "--cloud-secret", "OPENCODE_CONFIG_CONTENT", "say hi"],
          { timeoutMs: 90_000, env },
        )
        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain("Blocked by data-residency policy")
        expect(result.stderr).toMatch(/cloud: failed/)
        expect(fake.requests.some((r) => r.method === "DELETE")).toBe(true)
        expect(yield* input.llm.calls).toBe(0)
      }),
    TIMEOUT,
  )

  cliIt.live(
    "--model whose provider isn't on the worker fails clearly instead of falling back",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, env } = yield* setup(input)
        yield* input.llm.text("must never be asked")
        const result = yield* input.opencode.spawn(
          [
            "run",
            "--cloud",
            "--dir",
            work,
            "--model",
            "mistral/mistral-large-latest",
            "--cloud-secret",
            "OPENCODE_CONFIG_CONTENT",
            "say hi",
          ],
          { timeoutMs: 90_000, env },
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain(`"mistral/mistral-large-latest" can't run on the worker`)
        expect(result.stderr).toContain("--cloud-secret")
        expect(result.stderr).not.toContain("is used instead")
        expect(yield* input.llm.calls).toBe(0)
        expect(fake.requests.some((r) => r.method === "DELETE")).toBe(true)
      }),
    TIMEOUT,
  )

  cliIt.live(
    "Ctrl+C ends the worker, prints the results line and no stack trace, and exits 130",
    (input) =>
      Effect.gen(function* () {
        const { fake, work, env } = yield* setup(input)
        yield* input.llm.hang
        const run = yield* input.opencode.startRun("wait forever", {
          env,
          extraArgs: ["--cloud", "--dir", work, "--cloud-secret", "OPENCODE_CONFIG_CONTENT"],
        })
        yield* input.llm.wait(1)
        run.interrupt()
        const result = yield* run.result
        expect(result.exitCode).toBe(130)
        expect(result.stderr).toMatch(/cloud: interrupted: (results on|nothing changed)/)
        noTrace(result.stderr)
        expect(fake.requests.some((r) => r.method === "DELETE")).toBe(true)
      }),
    TIMEOUT,
  )

  // XCOD-237: billing stops a run mid-way the way lunoshq does: the Worker gains `ended`, the busy
  // session is aborted, the worker stays up. The attached client says why and exits non-zero, and
  // the worker is still ended so its results are pushed.
  for (const [reason, message] of [
    ["spending_cap", "Your Pro plan has used its 40 included agent-hours for 2026-10. Raise the cap in the console."],
    [
      "suspended",
      "Your last payment failed, so cloud runs are paused until the card is updated in the billing portal.",
    ],
  ] as const)
    cliIt.live(
      `a run the control plane stops for billing (${reason}) says why and exits non-zero`,
      (input) =>
        Effect.gen(function* () {
          const { fake, work, env } = yield* setup(input)
          yield* input.llm.hang
          const run = yield* input.opencode.startRun("work until stopped", {
            env,
            extraArgs: ["--cloud", "--dir", work, "--cloud-secret", "OPENCODE_CONFIG_CONTENT"],
          })
          yield* input.llm.wait(1)
          const id = [...fake.workers.keys()][0]
          yield* Effect.promise(() => fake.end(id, reason, message))
          const result = yield* run.result
          expect(result.exitCode).toBe(1)
          expect(result.stderr).toContain(`Lunos Cloud stopped the run: ${message}`)
          expect(result.stderr).not.toContain('"name": "MessageAbortedError"')
          expect(result.stderr).toMatch(/cloud: failed: (results on|nothing changed)/)
          noTrace(result.stderr)
          expect(fake.requests.some((r) => r.method === "DELETE")).toBe(true)
        }),
      TIMEOUT,
    )
})
