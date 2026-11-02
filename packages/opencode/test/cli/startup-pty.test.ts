import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { StartupTrace } from "@opencode-ai/core/startup-trace"
import * as Pty from "./fixtures/tui-pty"

// XCOD-276: the TUI's first frame doesn't wait for the server. Run from source in a pty at 120x45,
// isolated (throwaway HOME/XDG, the stand-in keychain, a local model nobody calls), with every
// outbound request sent to a recording proxy that refuses it.

const TIMEOUT = 120_000
const { KEY } = Pty

let proxy: Awaited<ReturnType<typeof Pty.recordingProxy>>
let run: Awaited<ReturnType<typeof Pty.launch>> | undefined
const homes: string[] = []

beforeAll(async () => {
  proxy = await Pty.recordingProxy()
})
afterAll(async () => {
  await proxy.close()
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})
afterEach(async () => {
  await run?.stop()
  if (run) homes.push(run.home)
  run = undefined
})

async function waitExit(timeout = 60_000) {
  const until = Date.now() + timeout
  while (run!.exited() === undefined && Date.now() < until) await Bun.sleep(50)
  return run!.exited()
}

/** `lunos debug startup` in a pty: the TUI starts, quits after its first frame, and prints the timeline. */
async function startupTrace(file: string, env: Record<string, string> = {}) {
  run = await Pty.launch({
    args: ["debug", "startup", "--settle", "200"],
    env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, LUNOS_STARTUP_TRACE: file, ...env },
    answerColors: true,
  })
  // The project is the pty's working directory, as for `lunos`.
  expect(await waitExit()).toBe(0)
  const trace = JSON.parse(await fs.readFile(file, "utf8")) as { firstFrame?: number; phases: StartupTrace.Phase[] }
  homes.push(run.home)
  run = undefined
  return trace
}

describe("start-up", () => {
  test(
    "`lunos debug startup` prints the phase timeline, ending at the first frame",
    async () => {
      run = await Pty.launch({
        args: ["debug", "startup", "--settle", "200"],
        env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url },
      })
      expect(await waitExit()).toBe(0)
      const out = run.raw()
      for (const phase of ["load cli modules", "tui command", "tui config", "sign-in gate", "first frame"])
        expect(out).toContain(phase)
      expect(out).toMatch(/first frame at [\d.]+ ms/)
      // The overlay is gone: what's still loading is a line under the app, never "Loading plugins…".
      expect(out).not.toContain("Loading plugins")
      expect(out).not.toContain("Finishing startup")
    },
    TIMEOUT,
  )

  test(
    "the first frame doesn't wait for the server: a slow server plugin starts after it",
    async () => {
      const home = await Pty.prepare()
      homes.push(home.home)
      const file = path.join(home.home, "trace.json")
      await slowServerPlugin(home.dirs.project, 3000)
      run = await Pty.launch({
        home: home.home,
        args: ["debug", "startup", "--settle", "200"],
        env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, LUNOS_STARTUP_TRACE: file },
      })
      expect(await waitExit()).toBe(0)
      const trace = JSON.parse(await fs.readFile(file, "utf8")) as { firstFrame: number; phases: StartupTrace.Phase[] }
      const loaded = trace.phases.find((phase) => phase.name === "load session data")
      expect(loaded?.blocking).toBe(false)
      // The server's data arrived (or would have) after the frame; the frame didn't wait for it.
      expect(trace.firstFrame).toBeLessThan(loaded!.start + loaded!.duration)
    },
    TIMEOUT,
  )

  test(
    "a prompt sent before the server is ready is queued, then sent as soon as it is",
    async () => {
      const home = await Pty.prepare()
      homes.push(home.home)
      await slowServerPlugin(home.dirs.project, 4000)
      run = await Pty.launch({ home: home.home, env: { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url } })
      await run.waitFor("Starting…")
      await run.type("queued hello")
      run.press(KEY.enter)
      await run.waitFor("your prompt is sent once ready")
      // Nothing is lost: the text stays in the box while it waits…
      expect(run.screen.text()).toContain("queued hello")
      // …and is sent once the server answers: the session opens with it.
      const until = Date.now() + 60_000
      while (run.screen.text().includes("your prompt is sent once ready") && Date.now() < until) await Bun.sleep(100)
      expect(run.screen.text()).not.toContain("your prompt is sent once ready")
      // The session view: the prompt went out as the session's first message, and the box is empty.
      await run.waitFor("queued hello", 30_000)
      expect(await sessionMessages(run.dirs.data)).toContain("queued hello")
    },
    TIMEOUT,
  )
})

// The start-up budget (XCOD-276): the work the first frame waits for, module loading aside, stays
// under BUDGET ms. From source, module loading is mostly transpiling, so it's left out; a compiled
// build is timed with `lunos debug startup` (see CONTRIBUTING.md). Opt-in, so a loaded machine running
// the whole suite can't fail it: CI's unit job runs it on its own with LUNOS_STARTUP_BUDGET=1.
const BUDGET = Number(process.env.LUNOS_STARTUP_BUDGET_MS ?? 150)
describe.skipIf(!["1", "true"].includes(process.env.LUNOS_STARTUP_BUDGET ?? "") || process.platform === "win32")(
  "start-up budget",
  () => {
    test(
      `the start path before the first frame stays under ${BUDGET} ms`,
      async () => {
        // CI keeps the traces as an artifact.
        const out = process.env.LUNOS_STARTUP_TRACE_DIR
        if (out) await fs.mkdir(out, { recursive: true })
        const results: number[] = []
        // The first run warms Bun's transpiler cache; the best of the rest is the warm start.
        for (const attempt of [0, 1, 2]) {
          const dir = out ?? (await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "lunos-startup-")))
          const file = path.join(dir, `startup-${attempt}.json`)
          const trace = await startupTrace(file)
          const ms = StartupTrace.startPathMs(trace.phases, trace.firstFrame)
          expect(ms).toBeDefined()
          if (attempt > 0) results.push(ms!)
        }
        const best = Math.min(...results)
        console.log(`start path before the first frame: ${results.map((ms) => ms.toFixed(1)).join(", ")} ms`)
        expect(best).toBeLessThanOrEqual(BUDGET)
      },
      TIMEOUT * 2,
    )
  },
)

/** The text of every user message stored so far (the session database under the data directory). */
async function sessionMessages(data: string) {
  const { Database } = await import("bun:sqlite")
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    const name = (await fs.readdir(path.join(data, "opencode")).catch(() => [] as string[])).find((item) =>
      /^opencode.*\.db$/.test(item),
    )
    const file = path.join(data, "opencode", name ?? "missing.db")
    const found = await fs.stat(file).then(
      () => {
        const db = new Database(file, { readonly: true })
        try {
          return db
            .query("select data from part")
            .all()
            .map((row) => String((row as { data: string }).data))
            .join("\n")
        } catch {
          return ""
        } finally {
          db.close()
        }
      },
      () => "",
    )
    if (found) return found
    await Bun.sleep(200)
  }
  return ""
}

/** A project-local server plugin whose init takes `ms`: the server answers nothing until it's done. */
async function slowServerPlugin(project: string, ms: number) {
  const dir = path.join(project, ".opencode", "plugin")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, "slow.js"),
    `export const Slow = async () => {\n  await new Promise((resolve) => setTimeout(resolve, ${ms}))\n  return {}\n}\n`,
  )
}
