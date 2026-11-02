import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { RunLog } from "../../src/observability/run-log"

// XCOD-280: the per-run log behind "Full log: <path>".

const dirs: string[] = []
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lunos-run-log-"))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  RunLog.reset()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("names", () => {
  test("lunos-<date>-<time>-<id>.log, and the id comes back out", () => {
    const name = RunLog.fileName("a3f9", new Date(2026, 9, 20, 14, 12))
    expect(name).toBe("lunos-2026-10-20-1412-a3f9.log")
    expect(RunLog.idOf(`/x/${name}`)).toBe("a3f9")
    expect(RunLog.idOf("/x/opencode.log")).toBeUndefined()
  })
})

describe("flags", () => {
  test("keeps the command and options, never typed text", () => {
    expect(RunLog.flags(["run", "--sandbox", "fix the secret bug"])).toBe("run --sandbox <arg>")
    expect(RunLog.flags(["run", "--model", "local/m", "hello"])).toBe("run --model local/m <arg>")
    expect(RunLog.flags(["--prompt", "hello there"])).toBe("--prompt <arg>")
    expect(RunLog.flags(["--prompt=hello"])).toBe("--prompt=<arg>")
    expect(RunLog.flags(["/some/project", "--continue"])).toBe("<arg> --continue")
    expect(RunLog.flags(["run", "--", "x"])).toBe("run -- <arg>")
  })
})

describe("describe", () => {
  test("the cause chain with stacks, structured fields, and what a non-Error throw was", () => {
    const inner = Object.assign(new Error("docker info failed"), {
      command: "docker info",
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon",
    })
    const outer = new Error("The sandbox couldn't start", { cause: inner })
    const text = RunLog.describe(outer)
    expect(text).toContain("Error: The sandbox couldn't start")
    expect(text).toContain("caused by:")
    expect(text).toContain("Error: docker info failed")
    expect(text).toContain("exitCode: 1")
    expect(text).toContain("stderr:\nCannot connect to the Docker daemon")
    expect(text).toContain("run-log.test.ts") // a stack frame
    expect(RunLog.describe("boom")).toBe("non-Error value thrown (string): boom")
    expect(RunLog.describe({ code: 7 })).toContain("non-Error value thrown (object):")
    expect(RunLog.describe(new Error("x", { cause: 42 }))).toContain("non-Error value thrown (number): 42")
  })
})

describe("a run's log", () => {
  test("header, failures, commands with the last 200 lines of output, and the result", () => {
    const dir = tmp()
    // A worker adopts its parent's log through the environment; so does this test, in a temp dir.
    const file = path.join(dir, RunLog.fileName("beef"))
    process.env[RunLog.ENV] = file
    expect(RunLog.current()).toEqual({ id: "beef", file })
    expect(process.env[RunLog.ENV]).toBeUndefined()
    RunLog.setPhases(() => "config 12ms\nsandbox 40ms")
    RunLog.command({ cmd: ["docker", "--version"], code: 0, stdout: "Docker 29" })
    const stderr = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n")
    RunLog.command({ cmd: ["docker", "info"], code: 1, stdout: "", stderr })
    expect(RunLog.failed()).toBeUndefined()
    RunLog.failure("sandbox", new Error("no daemon"), { headline: "The sandbox couldn't start" })
    expect(RunLog.failed()).toEqual({ headline: "The sandbox couldn't start" })
    expect(RunLog.ran("docker")).toBe(true)
    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain("$ docker --version  → exit 0")
    expect(text).not.toContain("Docker 29") // a command that worked: one line
    expect(text).toContain("$ docker info  → exit 1")
    expect(text).toContain("… (100 earlier lines)")
    expect(text).toContain("line 299")
    expect(text).not.toContain("line 99\n")
    expect(text).toContain("=== FAILURE in sandbox")
    expect(text).toContain("startup phases:\nconfig 12ms")
  })

  test("finish writes the result line that list() reads", () => {
    const dir = tmp()
    const ok = path.join(dir, RunLog.fileName("0001", new Date(2026, 0, 1)))
    const bad = path.join(dir, RunLog.fileName("0002", new Date(2026, 0, 2)))
    const open = path.join(dir, RunLog.fileName("0003", new Date(2026, 0, 3)))
    fs.writeFileSync(ok, "x\n=== result: ok (exit 0) at t\n")
    fs.writeFileSync(bad, "x\n=== result: failed (exit 1) at t\n")
    fs.writeFileSync(open, "x\n")
    const results = Object.fromEntries(RunLog.list(dir).map((entry) => [entry.id, entry.result]))
    expect(results).toEqual({ "0001": "ok", "0002": "failed", "0003": "incomplete" })
    expect(RunLog.find("00", dir)).toBeDefined()
    expect(RunLog.find("0002", dir)?.file).toBe(bad)
    expect(RunLog.find("ffff", dir)).toBeUndefined()
  })
})

describe("redaction", () => {
  test("the credential scanner's patterns and every known secret value", () => {
    RunLog.secret("bare-secret-value-1234567890")
    const text = RunLog.redact(
      [
        "Authorization: Bearer abcdefghijklmnop",
        "OPENAI_API_KEY=sk-live-1234567890abcdefghij",
        "token: ghp_abcdefghijklmnopqrstuvwxyz0123",
        "--password hunter22",
        "key is bare-secret-value-1234567890 here",
      ].join("\n"),
    )
    for (const secret of [
      "abcdefghijklmnop",
      "sk-live-1234567890abcdefghij",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "hunter22",
      "bare-secret-value-1234567890",
    ])
      expect(text).not.toContain(secret)
    expect(text).toContain("[redacted]")
  })
})

describe("prune", () => {
  const day = 86_400_000
  const now = new Date(2026, 9, 20, 12).getTime()
  function seed(dir: string, count: number, result: (i: number) => string, size = 10) {
    for (let i = 0; i < count; i++) {
      const time = new Date(now - i * day)
      const file = path.join(dir, RunLog.fileName(i.toString(16).padStart(4, "0"), time))
      fs.writeFileSync(file, "x".repeat(size) + `\n=== result: ${result(i)} (exit 0) at t\n`)
      fs.utimesSync(file, time, time)
    }
  }

  test("keeps the newest 10, plus failed or unfinished runs within the retention days", () => {
    const dir = tmp()
    seed(dir, 30, (i) => (i % 3 === 0 ? "failed" : i === 11 ? "running" : "ok"))
    RunLog.prune({}, dir, now)
    const kept = RunLog.list(dir).map((entry) => parseInt(entry.id, 16))
    // 0-9 newest; 12 is failed and 13 days old; 11 never finished (another Lunos may still be running).
    expect(kept.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12])
  })

  test("retention days and size are configurable; the oldest go first", () => {
    const dir = tmp()
    seed(dir, 20, () => "failed", 110 * 1024)
    RunLog.prune({ keep: 10, days: 30, maxMb: 1 }, dir, now)
    const kept = RunLog.list(dir).map((entry) => parseInt(entry.id, 16))
    expect(kept.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(RunLog.list(dir).reduce((sum, entry) => sum + entry.size, 0)).toBeLessThanOrEqual(1024 * 1024)
  })
})
