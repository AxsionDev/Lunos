import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// XCOD-211: `lunos agent run` through the CLI, against the mock model, without a sandbox (Docker
// isn't available in CI). Nobody approves anything; every limit stops the run.

type Report = {
  status: string
  reason: string
  steps: number
  cost: number
  denied: { permission: string }[]
  edited: string[]
}

const AGENT = "---\ndescription: Night shift\nmode: all\npermission:\n  bash: ask\n  read: allow\n---\nDo the job.\n"

function setup(home: string) {
  return Effect.promise(async () => {
    const config = path.join(home, ".config", "opencode")
    await fs.mkdir(path.join(config, "agents"), { recursive: true })
    await fs.writeFile(path.join(config, "agents", "nightly.md"), AGENT)
    await fs.writeFile(path.join(home, "notes.txt"), "hello\n")
  })
}

function report(output: string) {
  const file = output.match(/report: (\S+\.json)/)?.[1]
  if (!file) throw new Error(`no report path in output:\n${output}`)
  return fs.readFile(file, "utf8").then((text) => JSON.parse(text) as Report)
}

const run = (extra: string[] = []) => [
  "agent",
  "run",
  "nightly",
  "--prompt",
  "do the nightly job",
  "--no-sandbox",
  ...extra,
]

describe("lunos agent run (subprocess)", () => {
  cliIt.live(
    "a run that finishes writes a report and an audit event",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* setup(home)
        const log = path.join(home, "audit.log")
        yield* llm.text("All done.")
        const result = yield* opencode.spawn(run(), {
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...testProviderConfig(llm.url),
              audit: { enabled: true, path: log },
            }),
          },
        })
        opencode.expectExit(result, 0, "agent run")
        const out = result.stdout + result.stderr
        expect(out).toContain("nightly: ok (completed)")
        const r = yield* Effect.promise(() => report(out))
        expect(r).toMatchObject({ status: "ok", reason: "completed", denied: [] })
        expect(r.steps).toBeGreaterThanOrEqual(1)
        const events = (yield* Effect.promise(() => fs.readFile(log, "utf8")))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        const audited = events.find((event) => event.event === "agent.run")
        expect(audited).toMatchObject({ agent: "nightly", status: "ok", reason: "completed" })
        expect(JSON.stringify(audited)).not.toContain("do the nightly job")
      }),
    120_000,
  )

  cliIt.live(
    "a prompt nobody can answer is refused, reported, and the agent carries on",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* setup(home)
        yield* llm.push(reply().tool("bash", { command: "touch made-by-bash", description: "make a file" }))
        yield* llm.text("I couldn't run bash, so I stopped there.")
        const result = yield* opencode.spawn(run())
        opencode.expectExit(result, 0, "agent run")
        const out = result.stdout + result.stderr
        expect(out).toContain("refused (nobody to approve): bash")
        const r = yield* Effect.promise(() => report(out))
        expect(r.denied.map((item) => item.permission)).toEqual(["bash"])
        expect(r.status).toBe("ok")
        // Refused means not run.
        expect(
          yield* Effect.promise(() =>
            fs.stat(path.join(home, "made-by-bash")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
      }),
    120_000,
  )

  cliIt.live(
    "the step limit stops a run that keeps going",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* setup(home)
        for (let i = 0; i < 6; i++) yield* llm.push(reply().tool("read", { filePath: path.join(home, "notes.txt") }))
        const result = yield* opencode.spawn(run(["--max-steps", "2"]))
        expect(result.exitCode).not.toBe(0)
        const r = yield* Effect.promise(() => report(result.stdout + result.stderr))
        expect(r).toMatchObject({ status: "stopped", reason: "steps" })
        expect(r.steps).toBe(2)
        // No step starts past the limit: the 2 steps plus the session title, at most.
        expect(yield* llm.calls).toBeLessThanOrEqual(3)
      }),
    120_000,
  )

  cliIt.live(
    "the spend limit stops a run at the first step past it",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* setup(home)
        // A priced model, and token usage on every step, so each step costs something.
        const config = testProviderConfig(llm.url)
        config.provider.test.models["test-model"].cost = { input: 1000, output: 1000 }
        for (let i = 0; i < 6; i++)
          yield* llm.push(
            reply()
              .tool("read", { filePath: path.join(home, "notes.txt") })
              .usage({ input: 1000, output: 1000 }),
          )
        const result = yield* opencode.spawn(run(["--max-cost", "0.003"]), {
          env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
        })
        expect(result.exitCode).not.toBe(0)
        const r = yield* Effect.promise(() => report(result.stdout + result.stderr))
        expect(r).toMatchObject({ status: "stopped", reason: "cost" })
        expect(r.cost).toBeGreaterThan(0.003)
        // It stops at the first step past the limit: the steps before it cost less than the limit.
        const perStep = r.cost / r.steps
        expect(perStep * (r.steps - 1)).toBeLessThanOrEqual(0.003)
        expect(r.steps).toBeLessThan(6)
        // And no step started after it: the crossing step, plus the session title at most.
        expect(yield* llm.calls).toBeLessThanOrEqual(r.steps + 1)
      }),
    120_000,
  )

  cliIt.live(
    "the time limit stops a run that hangs",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* setup(home)
        yield* llm.hang
        const started = Date.now()
        const result = yield* opencode.spawn(run(["--max-time", "3s"]))
        expect(result.exitCode).not.toBe(0)
        const r = yield* Effect.promise(() => report(result.stdout + result.stderr))
        expect(r).toMatchObject({ status: "stopped", reason: "time" })
        // SIGINT, then SIGKILL after the grace period at the latest.
        expect(Date.now() - started).toBeLessThan(60_000)
      }),
    120_000,
  )

  cliIt.live(
    "a subagent's steps count against the limit too",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* setup(home)
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(home, ".config", "opencode", "agents", "nightly.md"),
            AGENT.replace("  read: allow", "  read: allow\n  task: allow"),
          ),
        )
        yield* llm.push(
          reply().tool("task", { description: "check", prompt: "read the notes", subagent_type: "general" }),
        )
        for (let i = 0; i < 6; i++) yield* llm.push(reply().tool("read", { filePath: path.join(home, "notes.txt") }))
        const result = yield* opencode.spawn(run(["--max-steps", "3"]))
        const r = yield* Effect.promise(() => report(result.stdout + result.stderr))
        expect(r).toMatchObject({ status: "stopped", reason: "steps" })
        expect(r.steps).toBe(3)
        // The steps are taken from the same budget, so no subagent step starts past it either.
        expect(yield* llm.calls).toBeLessThanOrEqual(4)
      }),
    120_000,
  )

  cliIt.live(
    "--schedule --dry-run shows the job without installing it; unsupported cron is refused",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* setup(home)
        const dry = yield* opencode.spawn(run(["--schedule", "30 9 * * 1-5", "--dry-run"]))
        opencode.expectExit(dry, 0, "dry run")
        const out = dry.stdout + dry.stderr
        expect(out).toContain("nightly will run at 09:30 on Mon, Tue, Wed, Thu, Fri (local time)")
        expect(out).toContain("every permission prompt is refused")
        if (process.platform === "darwin") expect(out).toContain("<key>StartCalendarInterval</key>")
        const list = yield* opencode.spawn(["agent", "schedule", "list"])
        expect(list.stdout + list.stderr).toContain("No scheduled agents")

        const bad = yield* opencode.spawn(run(["--schedule", "0 9 1 * *"]))
        expect(bad.exitCode).not.toBe(0)
        expect(bad.stdout + bad.stderr).toContain("day-of-month and month")

        // From a source checkout the job would run bun from this tree, so it isn't installed.
        const source = yield* opencode.spawn(run(["--schedule", "30 9 * * *"]))
        expect(source.exitCode).not.toBe(0)
        expect(source.stdout + source.stderr).toContain("installed lunos")
      }),
    120_000,
  )

  cliIt.live(
    "a subagent can't be run unattended on its own, and a prompt is required",
    ({ opencode, home }) =>
      Effect.gen(function* () {
        yield* setup(home)
        const noPrompt = yield* opencode.spawn(["agent", "run", "nightly", "--no-sandbox"])
        expect(noPrompt.exitCode).not.toBe(0)
        expect(noPrompt.stdout + noPrompt.stderr).toContain("--prompt")
        const sub = yield* opencode.spawn(["agent", "run", "general", "--prompt", "x", "--no-sandbox"])
        expect(sub.exitCode).not.toBe(0)
        expect(sub.stdout + sub.stderr).toContain("subagent")
      }),
    60_000,
  )
})
