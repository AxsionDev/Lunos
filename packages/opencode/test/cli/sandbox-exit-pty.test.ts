import { afterAll, afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { $ } from "bun"
import * as Pty from "./fixtures/tui-pty"

// XCOD-301: quitting a sandboxed TUI, in the real TUI (from source) in a pty at 120x45, against a real
// container runtime: the shell is back in under a second while a detached helper hands the results
// back; a failed handoff is announced at the next start, and its Retry saves them. Needs Docker and
// the locally built image (`bun run script/sandbox-image.ts`), so it only runs with
// LUNOS_SANDBOX_DOCKER_TESTS=1. Isolated as the other pty tests are; no model is ever asked anything.

const TIMEOUT = 240_000
const IMAGE = process.env.LUNOS_SANDBOX_IMAGE ?? "lunos-sandbox:local"
const docker = Bun.which("docker")
const enabled = process.env.LUNOS_SANDBOX_DOCKER_TESTS === "1" && !!docker && process.platform !== "win32"
const { KEY } = Pty

let run: Awaited<ReturnType<typeof Pty.launch>> | undefined
const homes: string[] = []
afterEach(async () => {
  await run?.stop()
  run = undefined
})
afterAll(async () => {
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})

/** A home whose project is a repository with one commit, docker on PATH, and the sandbox on. */
async function home(sandbox: Record<string, unknown> = {}) {
  const prepared = await Pty.prepare({
    config: { sandbox: { enabled: true, image: IMAGE, network: "open", ...sandbox } },
  })
  homes.push(prepared.home)
  await fs.writeFile(path.join(prepared.dirs.project, "a.txt"), "one\n")
  await $`git add -A && git -c user.email=t@lunos -c user.name=t commit -qm init`.cwd(prepared.dirs.project).quiet()
  return {
    ...prepared,
    env: { PATH: `${path.dirname(docker!)}:${prepared.env.PATH}` },
    conclude: path.join(prepared.dirs.state, "opencode", "sandbox", "conclude"),
  }
}

async function states(dir: string) {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  return Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as Record<string, any>),
  )
}

async function settled(dir: string, timeout = 120_000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const all = await states(dir)
    if (all.length && all.every((item) => item.state !== "running")) return all
    await Bun.sleep(250)
  }
  return states(dir)
}

const exists = async (id: string) =>
  (await $`${docker!} container inspect lunos-sandbox-${id}`.nothrow().quiet()).exitCode === 0

/** Quit from the home screen; how long until the process has exited (the shell is back). */
async function quit(current: NonNullable<typeof run>) {
  const pressed = Date.now()
  current.press(KEY.ctrlC)
  while (current.exited() === undefined && Date.now() - pressed < 30_000) await Bun.sleep(10)
  return Date.now() - pressed
}

/** Click a toast action ("[Retry]") where the screen shows it (SGR mouse, 1-based). */
function click(current: NonNullable<typeof run>, label: string) {
  const lines = current.screen.text().split("\n")
  const row = lines.findIndex((line) => line.includes(label))
  if (row < 0) throw new Error(`no ${label} on screen`)
  const col = lines[row].indexOf(label) + 2
  current.press(`\x1b[<0;${col};${row + 1}M\x1b[<0;${col};${row + 1}m`)
}

describe.skipIf(!enabled)("quitting a sandboxed TUI", () => {
  test(
    "the shell is back in under 1s; nothing changed: no handoff, the container removed in the background",
    async () => {
      const h = await home()
      run = await Pty.launch({ home: h.home, env: h.env })
      await run.waitFor("Sandbox ready", 120_000)
      await run.waitFor("Ask anything")
      const took = await quit(run)
      const raw = run.raw()
      expect(raw).toContain("No changes in the sandbox. Removing it in the background.")
      expect(raw).not.toContain("sandbox server http")
      console.log(`quit to shell: ${took} ms`)
      expect(took).toBeLessThan(1000)
      const [state] = await settled(h.conclude)
      expect(state?.state).toBe("done")
      expect(state?.outcome).toBe("destroyed")
      expect(state?.steps.map((step: { detail?: string }) => step.detail)).toContain("skipped: no changes")
      expect(await exists(state!.id)).toBe(false)
      const branches = await $`git branch --list ${"lunos/sandbox/*"}`.cwd(h.dirs.project).quiet().text()
      expect(branches.trim()).toBe("")
    },
    TIMEOUT,
  )

  test(
    "a failed handoff keeps the sandbox; the next start says so, with Retry, Open log and Attach; Retry saves",
    async () => {
      const h = await home()
      // The results directory can't be made: the handoff fails, as it would with Docker stopped.
      await fs.mkdir(path.join(h.dirs.project, ".opencode"), { recursive: true })
      await fs.writeFile(path.join(h.dirs.project, ".opencode", "sandbox"), "in the way\n")
      run = await Pty.launch({ home: h.home, env: h.env })
      await run.waitFor("Sandbox ready", 120_000)
      await run.waitFor("Ask anything")
      expect(await quit(run)).toBeLessThan(1000)
      const [state] = await settled(h.conclude)
      expect(state?.state).toBe("failed")
      const id = state!.id as string
      expect(await exists(id)).toBe(true)

      // The next start, without the sandbox this time: the toast.
      await fs.rm(path.join(h.dirs.project, ".opencode", "sandbox"))
      run = await Pty.launch({ home: h.home, env: h.env, extraArgs: ["--no-sandbox"] })
      const screen = await run.waitFor(`Results from sandbox ${id} weren't saved`, 60_000)
      for (const action of ["[Retry]", "[Open log]", "[Attach]"]) expect(screen).toContain(action)
      click(run, "[Retry]")
      await run.waitFor(`Saved the results from sandbox ${id}`, 120_000)
      const [after] = await states(h.conclude)
      expect(after?.state).toBe("done")
      expect(await exists(id)).toBe(false)
    },
    TIMEOUT,
  )

  test(
    "Attach on the toast reopens the kept sandbox in this terminal; leaving it keeps it",
    async () => {
      const h = await home()
      await fs.mkdir(path.join(h.dirs.project, ".opencode"), { recursive: true })
      await fs.writeFile(path.join(h.dirs.project, ".opencode", "sandbox"), "in the way\n")
      run = await Pty.launch({ home: h.home, env: h.env })
      await run.waitFor("Sandbox ready", 120_000)
      await run.waitFor("Ask anything")
      await quit(run)
      const [state] = await settled(h.conclude)
      expect(state?.state).toBe("failed")
      const id = state!.id as string
      await fs.rm(path.join(h.dirs.project, ".opencode", "sandbox"))
      run = await Pty.launch({ home: h.home, env: h.env, extraArgs: ["--no-sandbox"] })
      await run.waitFor(`Results from sandbox ${id} weren't saved`, 60_000)
      click(run, "[Attach]")
      await run.waitFor(`${id}: server http`, 120_000)
      await run.waitFor("Ask anything", 60_000)
      await quit(run)
      expect(run.raw()).toContain("Stopping it in the background")
      const [after] = await settled(h.conclude)
      expect(after?.state).toBe("done")
      expect(after?.outcome).toBe("retained")
      expect(await exists(id)).toBe(true)
      await $`${docker!} rm -f lunos-sandbox-${id}`.nothrow().quiet()
      await $`${docker!} volume rm -f lunos-sandbox-${id} lunos-sandbox-${id}-policy`.nothrow().quiet()
    },
    TIMEOUT,
  )

  test(
    'on_exit "wait": a line per step with its time, then the shell',
    async () => {
      const h = await home({ on_exit: "wait" })
      run = await Pty.launch({ home: h.home, env: h.env })
      await run.waitFor("Sandbox ready", 120_000)
      await run.waitFor("Ask anything")
      await quit(run)
      const raw = run.raw()
      expect(raw).toMatch(/Checking for changes… none · \d+\.\d s/)
      expect(raw).toMatch(/Saving the transcript… skipped: no changes · \d+\.\d s/)
      expect(raw).toMatch(/Removing the container… · \d+\.\d s/)
      expect(raw).toContain("destroyed")
      const [state] = await states(h.conclude)
      expect(state?.state).toBe("done")
    },
    TIMEOUT,
  )
})
