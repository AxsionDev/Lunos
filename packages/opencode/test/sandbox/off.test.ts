// XCOD-297: turning the sandbox off sticks. Before, /settings wrote `sandbox.enabled: false` to one
// file while startup turns the sandbox on when any file says true (config.json, a project's
// opencode.json), so the next start was sandboxed again; from inside a sandbox the write landed in
// the container's copy; and the XCOD-279 rollback could put a turn-off back. No Docker here: there
// is none on PATH for the CLI cases, and nothing below starts a sandbox.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { ConfigSettings } from "../../src/config/settings"
import { Restart } from "../../src/cli/restart"
import { SandboxConfig } from "../../src/sandbox/config"
import { SandboxDisabled } from "../../src/sandbox/disabled"
import { SandboxEffective } from "../../src/sandbox/effective"
import { SandboxError } from "../../src/sandbox/error"
import { SandboxRollback } from "../../src/sandbox/rollback"
import { failed, hostSettings, sandboxOff, startsSandboxed, wanted } from "../../src/cli/cmd/sandbox"
import { relaunchFor } from "../../src/cli/cmd/tui"
import * as Pty from "../cli/fixtures/tui-pty"

let root: string
let user: string
let project: string
let managed: string
const saved = { config: Global.Path.config, managed: process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR }

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-off-"))
  user = path.join(root, "user")
  project = path.join(root, "project")
  managed = path.join(root, "managed")
  for (const dir of [user, project, managed, path.join(project, ".git")]) await fs.mkdir(dir, { recursive: true })
  ;(Global.Path as { config: string }).config = user
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managed
  SandboxRollback.take()
})
afterEach(async () => {
  SandboxDisabled.clear(project)
  ;(Global.Path as { config: string }).config = saved.config
  process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = saved.managed
  SandboxRollback.take()
  await fs.rm(root, { recursive: true, force: true })
})

const write = (file: string, doc: unknown) => Bun.write(file, JSON.stringify(doc, null, 2))
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"))
const ctx = () => ({ directory: project, worktree: project })
const off = (scope: "user" | "project" = "user") =>
  ConfigSettings.set({ key: "sandbox.enabled", value: "false", scope, ctx: ctx(), locked: [] })

describe("off in /settings stays off", () => {
  test("when another file of yours turns it on (config.json beside opencode.json)", async () => {
    await write(path.join(user, "config.json"), { sandbox: { enabled: true } })
    await write(path.join(user, "opencode.json"), { $schema: "https://lunos.tech/config.json" })
    expect(wanted({}, project)).toBe(true)
    const result = await off()
    expect(read(path.join(user, "config.json")).sandbox.enabled).toBe(false)
    expect(result.file).toBe(path.join(user, "config.json"))
    expect(result.restart).toBe(true)
    // The next start, with no restart handoff: off.
    expect(SandboxConfig.load(project).enabled).toBe(false)
    expect(wanted({}, project)).toBe(false)
  })

  test("only the project's opencode.json turns it on: the row says so, and off changes that file", async () => {
    const file = path.join(project, "opencode.json")
    await write(file, { sandbox: { enabled: true } })
    const view = SandboxEffective.view(SandboxEffective.resolve(project))
    expect(view).toMatchObject({ on: true, display: "on", layer: "project", file })
    expect(view.detail).toBe(`on · set in ${file} (project)`)
    // The user tab is what /settings opens on: it still turns off the file that turns it on.
    await off("user")
    expect(read(file).sandbox.enabled).toBe(false)
    expect(SandboxEffective.resolve(project).on).toBe(false)
    expect(wanted({}, project)).toBe(false)
  })

  test("the /settings row shows the effective value and where it comes from", async () => {
    await write(path.join(user, "config.json"), { sandbox: { enabled: true } })
    await write(path.join(user, "opencode.json"), { sandbox: { enabled: false } })
    const rows = await ConfigSettings.list({
      // The merged config says false (opencode.json wins over config.json), which isn't what starts.
      config: { sandbox: { enabled: false } },
      origins: { sandbox: { layer: "global", source: path.join(user, "opencode.json") } },
      locked: [],
      ctx: ctx(),
    })
    const row = rows.find((item) => item.key === "sandbox.enabled")!
    expect(row).toMatchObject({ value: true, display: "on", source: "user", from: path.join(user, "config.json") })
    expect(row.override).toBe(`on · set in ${path.join(user, "config.json")} (user)`)
  })

  test("comments and the rest of the file survive; no file is created", async () => {
    const file = path.join(user, "opencode.jsonc")
    await Bun.write(file, `{\n  // mine\n  "sandbox": { "enabled": true, "network": "none" }\n}\n`)
    const turned = SandboxEffective.turnOff(project)
    expect(turned).toMatchObject({ ok: true, files: [file] })
    const text = readFileSync(file, "utf8")
    expect(text).toContain("// mine")
    expect(text).toContain('"network": "none"')
    expect(text).toContain('"enabled": false')
    expect(await Bun.file(path.join(user, "opencode.json")).exists()).toBe(false)
  })

  test("--project and --user turn off only their own files, and say where it's still on", async () => {
    await write(path.join(user, "opencode.json"), { sandbox: { enabled: true } })
    await write(path.join(project, "opencode.json"), { sandbox: { enabled: true } })
    const turned = SandboxEffective.turnOff(project, "project")
    expect(turned.ok && turned.files).toEqual([path.join(project, "opencode.json")])
    expect(turned.ok && turned.still).toContain(`still on: set in ${path.join(user, "opencode.json")} (user)`)
    expect(SandboxEffective.resolve(project).on).toBe(true)
    const rest = SandboxEffective.turnOff(project, "user")
    expect(rest.ok && rest.still).toBeUndefined()
    expect(SandboxEffective.resolve(project).on).toBe(false)
  })
})

describe("fixed: an organisation lock or sandbox.required", () => {
  test("managed sandbox.required: the row is fixed with the reason, and off is refused with it", async () => {
    await write(path.join(managed, "managed.json"), { sandbox: { required: true } })
    const state = SandboxEffective.resolve(project)
    expect(state.on).toBe(true)
    expect(state.fixed).toContain("sandbox.required is set by your organisation's managed config")
    expect(SandboxEffective.view(state)).toMatchObject({ display: "on (required)", fixed: state.fixed })
    expect(SandboxEffective.turnOff(project)).toMatchObject({ ok: false, reason: state.fixed })
    await expect(off()).rejects.toThrow(state.fixed!)
  })

  test("sandbox.required in a project file names the file", async () => {
    const file = path.join(project, ".opencode", "opencode.json")
    await write(file, { sandbox: { required: true } })
    const turned = SandboxEffective.turnOff(project)
    expect(turned).toMatchObject({ ok: false })
    expect(!turned.ok && turned.reason).toBe(
      `sandbox.required is set in ${file}, so the sandbox can't be turned off: remove sandbox.required there first.`,
    )
    expect(read(file).sandbox.required).toBe(true)
  })

  test("a managed $locked sandbox: refused with the policy message", async () => {
    await write(path.join(managed, "managed.json"), { $locked: ["sandbox"], sandbox: { enabled: true } })
    await write(path.join(user, "opencode.json"), { sandbox: { enabled: true } })
    const turned = SandboxEffective.turnOff(project)
    expect(!turned.ok && turned.reason).toBe(
      "sandbox.enabled is set by your organisation's policy and can't be changed here",
    )
    expect(read(path.join(user, "opencode.json")).sandbox.enabled).toBe(true)
  })
})

describe("after XCOD-281 turned it off following a failure", () => {
  const failure = {
    reason: "docker info failed",
    fix: "Docker Desktop isn't running — start it and try again.",
    time: "2026-10-21T09:00:00.000Z",
  }

  test("/settings and the badge agree, and Off keeps it off for good", async () => {
    await write(path.join(user, "opencode.json"), { sandbox: { enabled: true } })
    SandboxDisabled.set(project, failure)
    const view = SandboxEffective.view(SandboxEffective.resolve(project))
    expect(view).toMatchObject({ on: false, display: "off (after a failure)", disabled: true })
    expect(view.detail).toContain("Docker Desktop isn't running")
    // The badge's state comes from the same place.
    expect(sandboxOff(project)?.state()).toMatchObject({ status: "off", failure: { reason: failure.reason } })
    expect(wanted({}, project)).toBe(false)
    // Off: written to the config, and nothing left in local state for Re-enable to undo.
    expect(SandboxEffective.turnOff(project)).toMatchObject({ ok: true })
    expect(read(path.join(user, "opencode.json")).sandbox.enabled).toBe(false)
    expect(SandboxDisabled.get(project)).toBeUndefined()
    expect(sandboxOff(project)).toBeUndefined()
    expect(SandboxEffective.view(SandboxEffective.resolve(project)).display).toBe("off")
  })

  test("Re-enable turns it on again", async () => {
    await write(path.join(user, "opencode.json"), { sandbox: { enabled: true } })
    SandboxDisabled.set(project, failure)
    sandboxOff(project)!.reenable()
    expect(SandboxEffective.resolve(project).on).toBe(true)
    expect(wanted({}, project)).toBe(true)
  })
})

describe("the restart after turning it off", () => {
  test("a turn-off is never undone by the rollback", async () => {
    const file = path.join(user, "opencode.json")
    await write(file, { sandbox: { enabled: true } })
    // On, then off, in one session: the journal still holds the turn-on.
    SandboxRollback.record({ key: "sandbox.enabled", file, path: ["sandbox", "enabled"], had: false, value: true })
    await off()
    const changes = SandboxRollback.take()
    // A sandbox that then fails to start (--sandbox, say) doesn't bring the old value back.
    failed(new SandboxError({ step: "detect", reason: "docker info failed" }), project, changes)
    expect(read(file).sandbox.enabled).toBe(false)
    // Nor does a journalled turn-off (`lunos settings set` writing one file) get undone.
    const turnOff = {
      key: "sandbox.enabled",
      file,
      path: ["sandbox", "enabled"],
      had: true,
      previous: true,
      value: false,
    }
    failed(new SandboxError({ step: "detect", reason: "docker info failed" }), project, [turnOff])
    expect(read(file).sandbox.enabled).toBe(false)
    expect(SandboxRollback.undoable(turnOff)).toBe(false)
    expect(SandboxRollback.undoable({ ...turnOff, key: "sandbox", path: ["sandbox"], value: { enabled: false } })).toBe(
      false,
    )
    // What makes a start fail still is.
    expect(SandboxRollback.undoable({ ...turnOff, value: true })).toBe(true)
    expect(
      SandboxRollback.undoable({ ...turnOff, key: "sandbox.network", path: ["sandbox", "network"], value: "none" }),
    ).toBe(true)
  })

  test("relaunches without --sandbox, and starts without it", async () => {
    const handoff = path.join(root, "h.json")
    let argv: string[] = []
    await Restart.relaunch(
      { fresh: true, cancelled: [], sandbox: "off" },
      {
        platform: "linux",
        execve: (_file, args) => void (argv = args),
        spawn: async () => 0,
        preflight: () => ({ ok: true, version: "1" }),
        write: () => {},
        error: () => {},
        exit: () => {},
      },
      {
        execPath: "/opt/lunos",
        argv: ["/opt/lunos", "/$bunfs/root/lunos", "--sandbox=strict", "--keep", "."],
        execArgv: [],
        env: {},
        cwd: root,
        handoff,
        changes: [],
        sandbox: { off: true },
      },
    )
    expect(argv).toEqual(["/opt/lunos", "--keep", "."])
    expect(read(handoff).sandbox).toEqual({ off: true })
    expect(startsSandboxed({ sandbox: true }, project, { off: true })).toBe(false)
  })

  test("a sandboxed session asks for the off restart; required still wins", async () => {
    const request = { sessionID: "ses_1", fresh: false, cancelled: [], sandbox: "off" as const }
    expect(relaunchFor(request, { status: "ready", id: "x" })).toEqual([
      { ...request, sessionID: undefined, fresh: true },
      undefined,
      { sandbox: { off: true } },
    ])
    expect(relaunchFor(request, undefined)).toEqual([request, undefined, { sandbox: { off: true } }])
    await write(path.join(managed, "managed.json"), { sandbox: { required: true } })
    expect(startsSandboxed({}, project, { off: true })).toBe(true)
  })
})

describe("from inside a sandbox", () => {
  // The TUI runs on this computer and its server in the container; the container's PATCH
  // /config/settings would write the container's copy. The host side writes the host's files.
  test("off is written to this computer's config by the host, not the container's", async () => {
    const file = path.join(user, "opencode.json")
    await write(file, { sandbox: { enabled: true } })
    const host = hostSettings(project)
    expect(host.sandbox()).toMatchObject({ on: true, display: "on", layer: "user", file })
    const saved = await host.set({ key: "sandbox.enabled", value: "false", scope: "user" })
    expect(saved).toMatchObject({ ok: true, file, restart: true, changed: true })
    expect(read(file).sandbox.enabled).toBe(false)
    expect(host.sandbox()).toMatchObject({ on: false, display: "off" })
    expect(wanted({}, project)).toBe(false)
  })

  test("other sandbox settings go to this computer too, with their checks", async () => {
    const host = hostSettings(project)
    expect(await host.set({ key: "sandbox.network", value: "none", scope: "user" })).toMatchObject({ ok: true })
    expect(read(path.join(user, "opencode.json")).sandbox.network).toBe("none")
    // A repository can't open the network: refused, as on the host.
    const refused = await host.set({ key: "sandbox.network", value: "open", scope: "project" })
    expect(refused.ok).toBe(false)
    expect(await host.set({ key: "model", value: "x/y", scope: "user" })).toMatchObject({ ok: false })
  })
})

describe("lunos sandbox status | off", () => {
  // Pure Bun, no shell and no Docker: what works when the TUI can't start (Windows PowerShell).
  const TIMEOUT = 60_000
  async function lunos(args: string[], setup: (dirs: { config: string; project: string }) => Promise<void>) {
    const prepared = await Pty.prepare()
    // As a shell sets it: `bun run --cwd` moves the process, and Lunos works in $PWD.
    prepared.env.PWD = prepared.dirs.project
    const config = path.join(prepared.dirs.config, "opencode")
    await setup({ config, project: prepared.dirs.project })
    const child = Bun.spawn(
      [process.execPath, "run", "--cwd", path.resolve(import.meta.dir, "../.."), "src/index.ts", ...args],
      // No docker on this PATH: the commands must not need it.
      { cwd: prepared.dirs.project, env: prepared.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, code, config, project: prepared.dirs.project, home: prepared.home }
  }

  test(
    "status shows where it's on; off writes false there; status then says off",
    async () => {
      let file = ""
      const status = await lunos(["sandbox", "status"], async (dirs) => {
        file = path.join(dirs.project, "opencode.json")
        await write(file, { sandbox: { enabled: true } })
      })
      try {
        expect(status.code).toBe(0)
        expect(status.stdout).toContain(`on · set in ${file} (project)`)
        const env = { ...(await Pty.prepare({ home: status.home })).env, PWD: status.project }
        const run = (args: string[]) =>
          Bun.spawnSync(
            [process.execPath, "run", "--cwd", path.resolve(import.meta.dir, "../.."), "src/index.ts", ...args],
            {
              cwd: status.project,
              env,
            },
          )
        const turned = run(["sandbox", "off"])
        expect(turned.exitCode).toBe(0)
        expect(turned.stdout.toString()).toContain(`sandbox.enabled is now false in ${file}`)
        expect(read(file).sandbox.enabled).toBe(false)
        expect(run(["sandbox", "status"]).stdout.toString()).toContain("Sandbox: off")
      } finally {
        await fs.rm(status.home, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  test(
    "off refuses with the reason when it's required",
    async () => {
      const result = await lunos(["sandbox", "off"], async (dirs) => {
        await write(path.join(dirs.config, "opencode.json"), { sandbox: { required: true } })
      })
      try {
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain("sandbox.required is set in")
        expect(read(path.join(result.config, "opencode.json")).sandbox.required).toBe(true)
      } finally {
        await fs.rm(result.home, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
