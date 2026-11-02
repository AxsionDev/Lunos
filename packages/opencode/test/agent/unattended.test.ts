import { describe, expect, test } from "bun:test"
import os from "node:os"
import { AgentUnattended } from "../../src/agent/unattended"

// XCOD-211: how `lunos agent run` judges a run once a limit is reached, with a stand-in child
// (a bun script) in place of `lunos run`.

const limits = { time: 60, cost: 2, steps: 1 }
const step = JSON.stringify({ type: "step_finish", sessionID: "ses_1", part: { cost: 0 } })

function child(script: string): AgentUnattended.Spawn {
  // `run(...)` appends `run --format json …` to `base`; the script ignores its arguments.
  return { file: process.execPath, base: ["-e", script] }
}

describe("AgentUnattended.run (XCOD-211)", () => {
  test("a child that stops by itself at a limit and hands back its results is a success", async () => {
    const report = await AgentUnattended.run({
      command: child(
        `console.log(${JSON.stringify(step)}); console.error("sandbox results on branch \\x1b[1mlunos/sandbox/abc123\\x1b[0m (0123456789ab)")`,
      ),
      agent: "nightly",
      prompt: "go",
      cwd: os.tmpdir(),
      limits,
      sandbox: true,
    })
    expect(report).toMatchObject({ status: "ok", reason: "steps", exitCode: 0, results: "lunos/sandbox/abc123" })
    expect(report.error).toBeUndefined()
  })

  test("a child that doesn't stop after reaching a limit is interrupted and the run failed", async () => {
    const started = Date.now()
    const report = await AgentUnattended.run({
      command: child(`console.log(${JSON.stringify(step)}); setInterval(() => {}, 1000)`),
      agent: "nightly",
      prompt: "go",
      cwd: os.tmpdir(),
      limits,
      sandbox: false,
      windDown: 500,
      grace: 500,
    })
    expect(report).toMatchObject({ status: "failed", reason: "steps" })
    expect(report.error).toContain("didn't stop within")
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  test("a child that fails to hand back after a limit failed", async () => {
    const report = await AgentUnattended.run({
      command: child(
        `console.log(${JSON.stringify(step)}); console.error("Couldn't hand the results back"); process.exit(1)`,
      ),
      agent: "nightly",
      prompt: "go",
      cwd: os.tmpdir(),
      limits,
      sandbox: true,
    })
    expect(report).toMatchObject({ status: "failed", reason: "steps", exitCode: 1 })
    expect(report.error).toContain("Couldn't hand the results back")
  })
})
