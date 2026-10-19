import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { lines, manifest, replay, ROOT } from "./harness"
import { SCENARIOS, VERSIONS } from "./scenarios"

// XCOD-270: the recorder and the replay harness, proven on the test fakes (fake-claude.ts,
// fake-codex.ts) recorded by the same recorder into test/fixtures/external/fake-*. Nothing here
// runs the real Claude Code or Codex: the guard tests put tripwire `claude` and `codex` on PATH.

const PACKAGE = path.join(import.meta.dir, "..", "..", "..")
const SCRIPT = path.join(PACKAGE, "script", "record-external-fixtures.ts")
const FAKES = path.join(PACKAGE, "test", "external", "fixtures")
const FAKE_KEY = "sk-ant-api03-FakeKeyForTheRecorderTest_0123456789"

async function recorder(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    cwd: PACKAGE,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

/** `claude` and `codex` that only leave a marker behind, first on PATH. */
async function tripwire() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-tripwire-"))
  const marker = path.join(dir, "ran")
  for (const tool of ["claude", "codex"]) {
    await fs.writeFile(path.join(dir, tool), `#!/bin/sh\necho "${tool} $*" >> "${marker}"\n`, { mode: 0o755 })
  }
  return { dir, marker, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` }
}

describe("external-fixture recorder guards (XCOD-270)", () => {
  test("refuses without LUNOS_RECORD_EXTERNAL=1, without a key variable, and runs nothing", async () => {
    const wire = await tripwire()
    try {
      const unconfirmed = await recorder(["--claude-key-env", "K", "--codex-key-env", "K"], {
        PATH: wire.PATH,
        K: FAKE_KEY,
      })
      expect(unconfirmed.code).toBe(2)
      expect(unconfirmed.stderr).toContain("LUNOS_RECORD_EXTERNAL=1")
      const keyless = await recorder(["--codex-key-env", "K"], {
        PATH: wire.PATH,
        K: FAKE_KEY,
        LUNOS_RECORD_EXTERNAL: "1",
      })
      expect(keyless.code).toBe(2)
      expect(keyless.stderr).toContain("--claude-key-env")
      const empty = await recorder(["--claude-key-env", "UNSET_KEY", "--tool", "claude"], {
        PATH: wire.PATH,
        LUNOS_RECORD_EXTERNAL: "1",
      })
      expect(empty.code).toBe(2)
      expect(empty.stderr).toContain("$UNSET_KEY is empty")
      expect(existsSync(wire.marker)).toBe(false)
    } finally {
      await fs.rm(wire.dir, { recursive: true, force: true })
    }
  })

  test("--dry-run prints the commands and the environment, and runs nothing (not even --version)", async () => {
    const wire = await tripwire()
    try {
      const run = await recorder(["--dry-run", "--claude-key-env", "K", "--codex-key-env", "K"], {
        PATH: wire.PATH,
        K: FAKE_KEY,
        LUNOS_RECORD_EXTERNAL: "1",
      })
      expect(run.code).toBe(0)
      expect(existsSync(wire.marker)).toBe(false)
      expect(run.stdout).not.toContain(FAKE_KEY)
      expect(run.stdout).toContain(`${path.join(wire.dir, "claude")} -p --input-format stream-json`)
      expect(run.stdout).toContain(`${path.join(wire.dir, "codex")} login --with-api-key   (stdin: the value of $K)`)
      expect(run.stdout).toContain("ANTHROPIC_API_KEY=<value of $K>")
      expect(run.stdout).toContain("HOME=<scratch>/home")
      for (const scenario of SCENARIOS) expect(run.stdout).toContain(`[${scenario.name} 1/`)
    } finally {
      await fs.rm(wire.dir, { recursive: true, force: true })
    }
  })
})

describe("external-fixture recorder and replay, on the fakes (XCOD-270)", () => {
  for (const tool of ["claude", "codex"] as const) {
    const dir = path.join(ROOT, `fake-${tool}-${VERSIONS[tool]}`)

    test(`recording fake ${tool} again gives the committed fake-${tool} fixtures`, async () => {
      const out = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-record-test-"))
      try {
        const run = await recorder(
          [
            "--fake",
            "--tool",
            tool,
            "--binary",
            `${tool}=${path.join(FAKES, `fake-${tool}.ts`)}`,
            `--${tool}-key-env`,
            "K",
            "--out",
            out,
          ],
          { K: FAKE_KEY, LUNOS_RECORD_EXTERNAL: "1" },
        )
        expect(run.stderr).toBe("")
        expect(run.code).toBe(0)
        const fresh = path.join(out, `fake-${tool}-${VERSIONS[tool]}`)
        expect(manifest(fresh)).toEqual(manifest(dir)!)
        expect(readdirSync(fresh).sort()).toEqual(readdirSync(dir).sort())
        // Host and tool lines are compared each in order: the two directions may interleave differently.
        const by = (entries: any[], from: string) => entries.filter((entry) => entry.from === from)
        for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl")))
          for (const from of ["argv", "host", "tool", "exit"])
            expect({ file, from, lines: by(lines(path.join(fresh, file)), from) }).toEqual({
              file,
              from,
              lines: by(lines(path.join(dir, file)), from),
            })
      } finally {
        await fs.rm(out, { recursive: true, force: true })
      }
    }, 120_000)

    for (const scenario of SCENARIOS)
      test(`replays fake ${tool} ${scenario.name} to the adapter`, async () => {
        const steps = await replay(dir, scenario.name)
        expect(steps.length).toBe(scenario.steps.length)
        for (const step of steps) {
          expect(step.problems).toEqual([])
          if (step.step.kind === "models") expect(step.models!.length).toBeGreaterThan(1)
          else expect(step.result).toMatchObject({ type: "result" })
        }
      }, 60_000)
  }

  test("replay notices a host line the recording didn't expect", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-replay-mismatch-"))
    try {
      const source = path.join(ROOT, `fake-claude-${VERSIONS.claude}`)
      const recorded = manifest(source)!
      const step = recorded.scenarios["native-approval"]!.steps[0]!
      // The recording says the host allowed the Write; replay it with a host that refuses instead.
      await fs.copyFile(path.join(source, step.file), path.join(dir, step.file))
      await fs.writeFile(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          ...recorded,
          scenarios: { "native-approval": { steps: [{ ...step, decide: "hook-deny" }] } },
        }),
      )
      const [result] = await replay(dir, "native-approval")
      expect(result!.problems.some((problem) => problem.match === false)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
