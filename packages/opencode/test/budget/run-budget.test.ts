import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { cliIt } from "../lib/cli-process"
import { reply } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// XCOD-298: project budgets on the live path. `lunos run` against the mock model, a priced model
// (every step costs $2: 1000 input and 1000 output tokens at $1000 per million each), a named project
// holding the run's folder with a budget, as `lunos budget set` stores it. Nobody can answer a
// question in `lunos run`, so "ask" stops there too, and the run exits with code 3.

const STEP_USD = 2

async function project(home: string, budget: Record<string, unknown>) {
  // The run's folder as given and as the server may see it (on macOS /var/… is /private/var/…).
  const folders = [...new Set([home, await fs.realpath(home)])]
  const file = path.join(home, ".local", "share", "opencode", "project-groups.json")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      groups: [{ id: "pgrp_budgettest", name: "Axsion web", folders, time: { created: 1, updated: 1 } }],
      sessions: {},
      budgets: { pgrp_budgettest: budget },
    }),
  )
}

function config(url: string, extra: Record<string, unknown> = {}) {
  const value = testProviderConfig(url)
  value.provider.test.models["test-model"].cost = { input: 1000, output: 1000 }
  return { ...value, permission: { read: "allow" }, ...extra }
}

const steps = (home: string, count: number) =>
  Array.from({ length: count }, () =>
    reply().tool("read", { filePath: "notes.txt" }).usage({ input: 1000, output: 1000 }),
  )

const run = ["run", "--model", "test/test-model", "read the notes again and again"]

describe("project budgets (lunos run)", () => {
  cliIt.live(
    "on_limit stop: the step that crosses the budget finishes, no step starts after it, exit code 3",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(home, "notes.txt"), "hello\n"))
        // €3 at 0.9 €/$: two $2 steps (€3.60) pass it.
        yield* Effect.promise(() => project(home, { amount: 3, period: "monthly", on_limit: "stop" }))
        for (const item of steps(home, 6)) yield* llm.push(item)
        const result = yield* opencode.spawn(run, { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config(llm.url)) } })
        expect(result.exitCode, result.stderr.slice(-2000)).toBe(3)
        expect(result.stderr).toContain("budget exceeded")
        expect(result.stderr).toContain("Axsion web has used its")
        expect(result.stderr).toContain("lunos budget set")
        // Two steps ran (the second crossed it); the third never started. The title may take one call.
        const calls = yield* llm.calls
        expect(calls).toBeGreaterThanOrEqual(2)
        expect(calls).toBeLessThanOrEqual(3)
      }),
    120_000,
  )

  cliIt.live(
    "on_limit ask (the default) acts as stop when nobody can answer",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(home, "notes.txt"), "hello\n"))
        yield* Effect.promise(() => project(home, { amount: 3 }))
        for (const item of steps(home, 6)) yield* llm.push(item)
        const result = yield* opencode.spawn(run, { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config(llm.url)) } })
        expect(result.exitCode, result.stderr.slice(-2000)).toBe(3)
        expect(result.stderr).toContain("budget exceeded")
        expect(yield* llm.calls).toBeLessThanOrEqual(3)
      }),
    120_000,
  )

  cliIt.live(
    "on_limit warn: the run goes on past the budget",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(home, "notes.txt"), "hello\n"))
        yield* Effect.promise(() => project(home, { amount: 3, on_limit: "warn" }))
        for (const item of steps(home, 4)) yield* llm.push(item)
        yield* llm.text("done", { usage: { input: 10, output: 10 } })
        const result = yield* opencode.spawn(run, { env: { OPENCODE_CONFIG_CONTENT: JSON.stringify(config(llm.url)) } })
        expect(result.exitCode, result.stderr.slice(-2000)).toBe(0)
        expect(yield* llm.calls).toBeGreaterThanOrEqual(5)
      }),
    120_000,
  )

  cliIt.live(
    "a subagent's steps are checked against the same budget",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(home, "notes.txt"), "hello\n"))
        yield* Effect.promise(() => project(home, { amount: 3, on_limit: "stop" }))
        // The parent delegates; the subagent then reads, step after step.
        yield* llm.push(
          reply()
            .tool("task", { description: "check", prompt: "read the notes", subagent_type: "general" })
            .usage({ input: 1000, output: 1000 }),
        )
        for (const item of steps(home, 6)) yield* llm.push(item)
        const result = yield* opencode.spawn(run, {
          env: {
            // In the foreground, so which step comes when is fixed.
            OPENCODE_CONFIG_CONTENT: JSON.stringify(
              config(llm.url, { permission: { read: "allow", task: "allow" }, subagent: { background: false } }),
            ),
          },
        })
        expect(result.exitCode, result.stderr.slice(-2000)).toBe(3)
        // The parent's step is paid for when it ends, after its tool call (the subagent) returns: so
        // the subagent's first two steps run (€3.60), its third doesn't start, and the parent stops
        // too. The title calls and these: never all seven replies.
        expect(result.stdout + result.stderr).toContain("Subagent failed")
        expect(result.stdout + result.stderr).toContain("Axsion web has used its")
        expect(yield* llm.calls).toBeLessThanOrEqual(5)
      }),
    120_000,
  )

  cliIt.live(
    "an organisation budget is enforced only when managed config locks it",
    ({ opencode, home, llm }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(home, "notes.txt"), "hello\n"))
        const managed = path.join(home, "managed")
        yield* Effect.promise(() => fs.mkdir(managed, { recursive: true }))
        const write = (doc: unknown) => fs.writeFile(path.join(managed, "managed.json"), JSON.stringify(doc))
        const organisation = { amount: 3, on_limit: "stop" }

        // Unlocked: a member's own config could have set it, so it isn't the organisation's.
        yield* Effect.promise(() => write({ budget: { organisation } }))
        for (const item of steps(home, 3)) yield* llm.push(item)
        yield* llm.text("done", { usage: { input: 10, output: 10 } })
        const env = {
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config(llm.url)),
          OPENCODE_TEST_MANAGED_CONFIG_DIR: managed,
        }
        const free = yield* opencode.spawn(run, { env })
        expect(free.exitCode, free.stderr.slice(-2000)).toBe(0)

        // Locked: enforced, and a member's config can't raise it.
        yield* Effect.promise(() => write({ budget: { organisation }, $locked: ["budget.organisation"] }))
        for (const item of steps(home, 6)) yield* llm.push(item)
        const raised = config(llm.url, { budget: { organisation: { amount: 1000 } } })
        const before = yield* llm.calls
        const result = yield* opencode.spawn(run, {
          env: { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify(raised) },
        })
        expect(result.exitCode, result.stderr.slice(-2000)).toBe(3)
        expect(result.stderr).toContain("Your organisation")
        // Two steps pass €3 (each run has its own database here); the third doesn't start.
        expect((yield* llm.calls) - before).toBeLessThanOrEqual(3)
      }),
    180_000,
  )
})

void STEP_USD
