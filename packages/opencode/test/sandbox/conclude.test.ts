import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Config } from "@opencode-ai/core/config"
import { Global } from "@opencode-ai/core/global"
import { SandboxConclude } from "../../src/sandbox/conclude"
import { SandboxConfig } from "../../src/sandbox/config"
import { Sandbox } from "../../src/sandbox"
import { concludeArgs, reportLines, statusLines } from "../../src/cli/cmd/sandbox"
import { Restart } from "../../src/cli/restart"
import { tmpdir } from "../fixture/fixture"

// XCOD-301: what the detached helper writes, and everything that reads it: `lunos sandbox status
// <id>`, the next start (waits on a running one, announces a failed one), and prune (leaves both
// alone). The helper itself, on a real container runtime, is covered by script/sandbox-e2e.ts
// (`--only fastexit`) and test/cli/sandbox-exit-pty.test.ts.

const ids: string[] = []
afterEach(async () => {
  for (const id of ids.splice(0)) {
    await fs.rm(SandboxConclude.file(id), { force: true })
    await fs.rm(path.join(Global.Path.state, "sandbox", `${id}.json`), { force: true })
  }
})

const state = (input: Partial<SandboxConclude.State> & { id: string; root: string }): SandboxConclude.State => {
  ids.push(input.id)
  return { state: "running", started: new Date().toISOString(), steps: [], lines: [], ...input }
}

/** A pid that isn't running: a child that has already exited. */
async function deadPid() {
  const child = Bun.spawn(["true"])
  await child.exited
  return child.pid
}

describe("sandbox.on_exit", () => {
  test("decodes through both schemas; anything else is rejected", () => {
    expect(Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: { on_exit: "wait" } }).sandbox?.on_exit).toBe("wait")
    expect(Schema.decodeUnknownSync(Config.Info)({ sandbox: { on_exit: "background" } }).sandbox?.on_exit).toBe(
      "background",
    )
    expect(() => Schema.decodeUnknownSync(ConfigV1.Info)({ sandbox: { on_exit: "later" } })).toThrow()
  })

  test("background by default; `lunos run` waits in CI and when piped; a config value always wins", () => {
    const unset = SandboxConfig.resolve({})
    expect(unset.on_exit).toBeUndefined()
    expect(SandboxConfig.exitMode(unset, "tui", {}, true)).toBe("background")
    expect(SandboxConfig.exitMode(unset, "tui", { CI: "true" }, false)).toBe("background")
    expect(SandboxConfig.exitMode(unset, "run", {}, true)).toBe("background")
    expect(SandboxConfig.exitMode(unset, "run", { CI: "true" }, true)).toBe("wait")
    expect(SandboxConfig.exitMode(unset, "run", { CI: "false" }, true)).toBe("background")
    expect(SandboxConfig.exitMode(unset, "run", {}, false)).toBe("wait")
    expect(SandboxConfig.exitMode({ on_exit: "background" }, "run", { CI: "1" }, false)).toBe("background")
    expect(SandboxConfig.exitMode({ on_exit: "wait" }, "tui", {}, true)).toBe("wait")
  })
})

describe("the helper's state", () => {
  test("written whole and read back; nothing there is undefined", () => {
    const item = state({ id: "x301rw", root: "/tmp/p" })
    expect(SandboxConclude.read(item.id)).toBeUndefined()
    SandboxConclude.write(item)
    expect(SandboxConclude.read(item.id)).toEqual(item)
  })

  test("a running helper whose process is gone is failed from then on, and the file says so", async () => {
    const item = state({ id: "x301gone", root: "/tmp/p", pid: await deadPid() })
    SandboxConclude.write(item)
    const now = SandboxConclude.current(item.id)
    expect(now?.state).toBe("failed")
    expect(now?.reason).toContain("stopped before it finished")
    expect(SandboxConclude.read(item.id)?.state).toBe("failed")
  })

  test("one that never started counts as running for a grace period, then failed", () => {
    const item = state({ id: "x301never", root: "/tmp/p" })
    SandboxConclude.write(item)
    const started = Date.parse(item.started)
    expect(SandboxConclude.current(item.id, started + 1000)?.state).toBe("running")
    const late = SandboxConclude.current(item.id, started + SandboxConclude.SPAWN_GRACE + 1)
    expect(late?.state).toBe("failed")
    expect(late?.reason).toContain("never started")
  })

  test("a live one is running and busy", () => {
    const item = state({ id: "x301live", root: "/tmp/p", pid: process.pid })
    SandboxConclude.write(item)
    expect(SandboxConclude.busy(item.id)).toBe(true)
    expect(SandboxConclude.held(item.id)).toBe(true)
  })

  test("unsaved: this project's failed ones whose sandbox still exists, newest first", async () => {
    await using tmp = await tmpdir({ git: true })
    const old = state({ id: "x301old", root: tmp.path, state: "failed", started: "2026-01-01T00:00:00.000Z" })
    const recent = state({ id: "x301new", root: tmp.path, state: "failed", started: "2026-02-01T00:00:00.000Z" })
    const gone = state({ id: "x301gone2", root: tmp.path, state: "failed" })
    const elsewhere = state({ id: "x301else", root: "/somewhere/else", state: "failed" })
    const done = state({ id: "x301done", root: tmp.path, state: "done" })
    for (const item of [old, recent, gone, elsewhere, done]) SandboxConclude.write(item)
    const found = SandboxConclude.unsaved(path.join(tmp.path), (id) => id !== gone.id).map((item) => item.id)
    expect(found).toEqual([recent.id, old.id])
  })

  test("settle waits for this project's running helper, saying so, and returns once it's done", async () => {
    await using tmp = await tmpdir({ git: true })
    const item = state({ id: "x301wait", root: tmp.path, pid: process.pid })
    SandboxConclude.write(item)
    const lines: string[] = []
    setTimeout(() => SandboxConclude.write({ ...item, state: "done" }), 400)
    const started = Date.now()
    const settled = await SandboxConclude.settle(tmp.path, (line) => lines.push(line))
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(lines[0]).toContain(`waiting for sandbox ${item.id} to finish saving its results`)
    expect(settled.map((entry) => entry.state)).toEqual(["done"])
    // Nothing running: no wait, no line.
    const none: string[] = []
    expect(await SandboxConclude.settle(tmp.path, (line) => none.push(line))).toEqual([])
    expect(none).toEqual([])
  })

  test("prune leaves a sandbox alone while its results are being handed back, or weren't", async () => {
    const dir = path.join(Global.Path.state, "sandbox")
    await fs.mkdir(dir, { recursive: true })
    const expired = "2026-01-01T00:00:00.000Z"
    for (const [id, conclude] of [
      ["x301prf", { state: "failed" as const }],
      ["x301prr", { state: "running" as const, pid: process.pid }],
    ] as const) {
      await Bun.write(path.join(dir, `${id}.json`), JSON.stringify({ id, expires: expired }))
      SandboxConclude.write(state({ id, root: "/tmp/p", ...conclude }))
    }
    expect(await Sandbox.prune(Date.parse("2026-09-30T00:00:00Z"))).toEqual([])
    expect(await Bun.file(path.join(dir, "x301prf.json")).exists()).toBe(true)
    expect(await Bun.file(path.join(dir, "x301prr.json")).exists()).toBe(true)
  })
})

describe("what the helper reports", () => {
  test("a progress line per step, with its detail and time", () => {
    const line = SandboxConclude.stepLine({
      label: "Handing back results",
      started: "2026-10-23T10:00:00.000Z",
      finished: "2026-10-23T10:00:02.100Z",
      detail: "3 files, 1 commit",
    })
    expect(line).toBe("Handing back results… 3 files, 1 commit · 2.1 s")
  })

  test("`lunos sandbox status <id>`: running, done or failed with the reason and the log", () => {
    const step = { label: "Handing back results", started: "2026-10-23T10:00:00.000Z" }
    const base = { id: "a1b2", root: "/p", started: step.started, lines: ["results on branch x"] }
    const running = statusLines({ ...base, state: "running", steps: [step] }, Date.parse("2026-10-23T10:00:01.000Z"))
    expect(running[0]).toBe("Sandbox a1b2: saving its results in the background")
    expect(running[1]).toBe("  … Handing back results… · 1.0 s")
    expect(running.join("\n")).not.toContain("results on branch")
    const done = statusLines({
      ...base,
      state: "done",
      outcome: "destroyed",
      steps: [{ ...step, finished: "2026-10-23T10:00:02.000Z" }],
    })
    expect(done[0]).toBe("Sandbox a1b2: done, results saved and the sandbox removed")
    expect(done).toContain("  results on branch x")
    const failed = statusLines({
      ...base,
      state: "failed",
      reason: "Docker isn't running",
      log: { id: "l1", file: "/logs/lunos-l1.log" },
      steps: [step],
    })
    expect(failed[0]).toBe("Sandbox a1b2: failed, the results weren't saved: Docker isn't running")
    expect(failed[1]).toStartWith("  ✗ Handing back results")
    expect(failed.at(-1)).toBe("  log: /logs/lunos-l1.log")
  })

  test("nothing changed: no branch line, says nothing was handed back", () => {
    const lines = reportLines({
      mode: "branch",
      files: [],
      results: "/p/.opencode/sandbox/a1b2",
      failed: false,
      unchanged: true,
      id: "a1b2",
      root: "/p",
    })
    expect(lines[0]).toBe("no changes in the workspace, so nothing was handed back")
    expect(lines.join("\n")).not.toContain("results on branch")
  })

  test("the helper is `lunos sandbox conclude <id> --background` with the outcome and policy", () => {
    expect(concludeArgs("a1b2", { failed: true, label: "failed" }, "destroy_on_success")).toEqual([
      "sandbox",
      "conclude",
      "a1b2",
      "--background",
      "--label",
      "failed",
      "--policy",
      "destroy_on_success",
      "--failed",
    ])
  })

  test("it starts with the same Lunos, without this run's log or handoff", () => {
    const self = Restart.selfCommand(["sandbox", "conclude", "a1b2"], "linux")
    expect(self.argv.slice(-3)).toEqual(["sandbox", "conclude", "a1b2"])
    expect(self.argv[0]).toBe(process.execPath)
    expect(self.env.LUNOS_RUN_LOG).toBeUndefined()
    expect(self.env[Restart.HANDOFF_ENV]).toBeUndefined()
  })
})
