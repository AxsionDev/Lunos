// XCOD-279: a sandbox that can't start says why and how to fix it, never "Unexpected error", and
// never locks Lunos out: settings are checked before they're saved, a failed /restart is undone, and
// the user can start without it. The Docker side is a fake `docker` script on PATH, so this runs
// without a daemon; the Windows parts are pure functions given the platform.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { Global } from "@opencode-ai/core/global"
import { FormatError } from "../../src/cli/error"
import { Restart } from "../../src/cli/restart"
import { ConfigSettings } from "../../src/config/settings"
import { SandboxDocker } from "../../src/sandbox/docker"
import { SandboxError, SandboxFailure } from "../../src/sandbox/error"
import { SandboxExec } from "../../src/sandbox/exec"
import { SandboxGit } from "../../src/sandbox/git"
import { SandboxPreflight } from "../../src/sandbox/preflight"
import { SandboxRollback } from "../../src/sandbox/rollback"
import { checkLines, fallback } from "../../src/cli/cmd/sandbox"
import { tmpdir } from "../fixture/fixture"

const STOPPED =
  'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/info": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'

/**
 * A fake `docker` on a PATH holding nothing else that matters. `mode` picks its answers: Docker
 * Desktop stopped, Windows containers, a denied pull, or everything working.
 */
async function fakeDocker(mode: "stopped" | "windows" | "denied" | "ok") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-fake-docker-"))
  const script = `#!/bin/sh
case "$1" in
  --version) echo "Docker version 27.3.1, build ce12230"; exit 0 ;;
  info)
    ${mode === "stopped" ? `echo '${STOPPED}' >&2; exit 1` : `echo "27.3.1|${mode === "windows" ? "windows" : "linux"}"; exit 0`} ;;
  image) ${mode === "ok" ? 'echo "sha256:feed|[]"; exit 0' : 'echo "Error: No such image" >&2; exit 1'} ;;
  manifest) echo "unauthorized: authentication required" >&2; exit 1 ;;
  pull) echo "Error response from daemon: denied: requested access to the resource is denied" >&2; exit 1 ;;
  run) exit 0 ;;
esac
echo "unexpected: $*" >&2
exit 2
`
  await Bun.write(path.join(dir, "docker"), script)
  await fs.chmod(path.join(dir, "docker"), 0o755)
  return dir
}

// The fake docker is a shell script, and some cases use sh and sleep: not on a Windows runner.
const posixOnly = process.platform === "win32"

let savedPath: string | undefined
beforeEach(() => {
  savedPath = process.env.PATH
})
afterEach(() => {
  process.env.PATH = savedPath
})
/** Only the fake docker and the system's own tools: no real docker or podman. */
const usePath = (dir: string) => {
  process.env.PATH = [dir, "/usr/bin", "/bin"].join(path.delimiter)
}

describe("the error says what failed", () => {
  test("an Error with no message, a non-Error and null all describe themselves", () => {
    expect(SandboxFailure.describe(new Error(""))).toContain("Error with no message")
    expect(SandboxFailure.describe({ code: 7 })).toBe('a non-error Object was thrown: {"code":7}')
    expect(SandboxFailure.describe("boom")).toBe("a string was thrown: boom")
    expect(SandboxFailure.describe(undefined)).toBe("undefined was thrown instead of an error")
    for (const thrown of [new Error(""), { code: 7 }, "boom", undefined, null, 42]) {
      const error = SandboxFailure.wrap("create", thrown)
      const printed = FormatError(error)
      expect(printed).toStartWith("The sandbox couldn't start (create): ")
      expect(printed).not.toContain("Unexpected error")
    }
  })

  test("the step, the command (secrets redacted), the exit code, the stderr tail and the fix", () => {
    const error = new SandboxError({
      step: "start",
      reason: "docker start failed",
      command: ["docker", "run", "--env", "OPENAI_API_KEY=sk-live", "--env", "HOME=/sandbox", "https://u:pw@host/x"],
      code: 125,
      stderr: "line1\nBind for 127.0.0.1:4096 failed: port is already allocated",
    })
    expect(error.message).toContain("The sandbox couldn't start (start): docker start failed")
    expect(error.message).toContain(
      "command: docker run --env OPENAI_API_KEY=*** --env HOME=/sandbox https://***@host/x",
    )
    expect(error.message).not.toContain("sk-live")
    expect(error.message).not.toContain(":pw@")
    expect(error.message).toContain("exit code: 125")
    expect(error.message).toContain("| Bind for 127.0.0.1:4096 failed")
    expect(error.message).toContain("Fix: A port the sandbox needs is in use")
    // A step already named survives wrapping by an outer one.
    expect(SandboxFailure.wrap("create", error).step).toBe("start")
    expect(FormatError(error)).toBe(error.message)
  })

  test("the known failures have a fix", () => {
    const fix = (text: string, platform: NodeJS.Platform = "win32") => SandboxFailure.diagnose(text, platform)
    expect(fix(STOPPED)).toBe("Docker Desktop isn't running — start it and try again.")
    expect(fix("Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "linux")).toContain(
      "systemctl start docker",
    )
    expect(fix("OSType: windows")).toContain("Switch to Linux containers")
    expect(fix("no matching manifest for windows/amd64 10.0.22631 in the manifest list entries")).toContain(
      "Switch to Linux containers",
    )
    expect(fix("Docker Desktop requires WSL 2. wsl --install")).toContain("wsl --install")
    expect(fix("the docker command wasn't found on PATH")).toContain("Install Docker Desktop")
    expect(fix("denied: requested access to the resource is denied")).toContain("docker login ghcr.io")
    expect(fix("dial tcp: lookup ghcr.io: no such host")).toContain("couldn't reach the image registry")
    expect(fix('sandbox.workspace "mount" isn\'t supported with rootless Docker yet')).toContain('"copy"')
    expect(fix("something nobody has seen")).toBeUndefined()
  })
})

describe("running commands", () => {
  test.skipIf(posixOnly)("a command that isn't installed, or fails, is a SandboxError with its output", async () => {
    const missing = await SandboxExec.run(["lunos-no-such-command-xyz", "--version"]).catch((error) => error)
    expect(missing).toBeInstanceOf(SandboxError)
    expect(missing.message).toContain("the lunos-no-such-command-xyz command wasn't found on PATH")
    const failed = await SandboxExec.check(["sh", "-c", "echo boom >&2; exit 3"]).catch((error) => error)
    expect(failed).toBeInstanceOf(SandboxError)
    expect(failed.code).toBe(3)
    expect(failed.message).toContain("sh -c echo boom >&2; exit 3 failed: boom")
    expect(failed.message).toContain("| boom")
  })

  test.skipIf(posixOnly)("a command that doesn't answer is stopped", async () => {
    const result = await SandboxExec.run(["sleep", "5"], { timeout: 200 })
    expect(result.timedOut).toBe(true)
    expect(result.stderr).toContain("no answer within 0.2s")
  })

  test("Windows: docker resolves to docker.exe, or Docker Desktop's own copy when PATH lacks it", () => {
    const env = { Path: "C:\\Windows\\system32", ProgramFiles: "C:\\Program Files" }
    const which = (name: string, options: { PATH: string }) =>
      name === "docker" && options.PATH.includes("Docker") ? "C:\\Docker\\docker.exe" : null
    const host = (exists: (file: string) => boolean, path = env) => ({
      platform: "win32" as const,
      env: path,
      which,
      exists,
    })
    expect(
      SandboxExec.resolve(
        "docker",
        host(() => false, { ...env, Path: "C:\\Docker" }),
      ),
    ).toBe("C:\\Docker\\docker.exe")
    const desktop = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe"
    expect(
      SandboxExec.resolve(
        "docker",
        host((file) => file === desktop),
      ),
    ).toBe(desktop)
    expect(
      SandboxExec.resolve(
        "docker",
        host(() => false),
      ),
    ).toBeUndefined()
    expect(
      SandboxExec.resolve(
        "C:\\tools\\docker.exe",
        host(() => false),
      ),
    ).toBe("C:\\tools\\docker.exe")
    // Not Windows: PATH only.
    expect(SandboxExec.resolve("docker", { ...host(() => true), platform: "linux" })).toBeUndefined()
  })

  test("Windows: environment names are case-insensitive, and a merge keeps one PATH", () => {
    expect(SandboxExec.envGet({ Path: "C:\\x" }, "PATH", "win32")).toBe("C:\\x")
    expect(SandboxExec.envGet({ Path: "C:\\x" }, "PATH", "linux")).toBeUndefined()
    expect(SandboxExec.mergeEnv({ Path: "old", A: "1" }, { PATH: "new" }, "win32")).toEqual({ A: "1", PATH: "new" })
    expect(SandboxExec.mergeEnv({ Path: "old" }, { PATH: "new" }, "linux")).toEqual({ Path: "old", PATH: "new" })
  })

  test("Windows: a .cmd shim runs through cmd.exe with each argument quoted for it", () => {
    expect(SandboxExec.spawnable("C:\\bin\\docker.exe", ["info", "--format", "{{.OSType}}"], "win32")).toEqual({
      argv: ["C:\\bin\\docker.exe", "info", "--format", "{{.OSType}}"],
      verbatim: false,
    })
    const shim = SandboxExec.spawnable("C:\\bin\\docker.cmd", ["info", "--format", "{{.A}}|{{json .B}}"], "win32")
    expect(shim.verbatim).toBe(true)
    expect(shim.argv.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"])
    // The pipe and the space reach docker inside quotes, escaped for cmd: not a pipeline.
    expect(shim.argv[4]).toBe('"C:\\bin\\docker.cmd ^"info^" ^"--format^" ^"{{.A}}^|{{json^ .B}}^""')
    expect(SandboxExec.cmdQuote('say "hi"\\')).toBe('^"say^ \\^"hi\\^"\\\\^"')
  })
})

describe.skipIf(posixOnly)("finding Docker", () => {
  test("Docker Desktop stopped: the reason, the command and the fix", async () => {
    usePath(await fakeDocker("stopped"))
    const error = await SandboxDocker.available().catch((error) => error)
    expect(error).toBeInstanceOf(SandboxError)
    expect(error.step).toBe("detect")
    expect(error.message).toContain("docker is installed but its engine isn't running: error during connect")
    expect(error.message).toContain("command: docker info --format")
    expect(error.message).toContain("exit code: 1")
    expect(error.fix).toContain("isn't running — start it")
    expect(FormatError(error)).not.toContain("Unexpected error")
  })

  test("Windows-containers mode is caught at detection, not at the pull", async () => {
    usePath(await fakeDocker("windows"))
    const error = await SandboxDocker.available().catch((error) => error)
    expect(error.message).toContain("docker runs windows containers, and the sandbox is a Linux container")
    expect(error.fix).toContain("Switch to Linux containers")
  })

  test("a denied pull says the image can't be pulled, and how to get one", async () => {
    usePath(await fakeDocker("denied"))
    await SandboxDocker.available()
    const error = await SandboxDocker.image("ghcr.io/axsiondev/lunos:1.0.0").catch((error) => error)
    expect(error.step).toBe("image")
    expect(error.message).toContain("command: docker pull ghcr.io/axsiondev/lunos:1.0.0")
    expect(error.fix).toContain("docker login ghcr.io")
  })
})

describe("Windows paths", () => {
  test("drive-letter mounts are converted for Docker Desktop and for Podman's WSL machine", () => {
    expect(SandboxDocker.hostPath("D:\\development\\axsion-web", "win32", "docker")).toBe("D:/development/axsion-web")
    expect(SandboxDocker.hostPath("d:\\development\\axsion-web\\", "win32", "podman")).toBe(
      "/mnt/d/development/axsion-web",
    )
    expect(SandboxDocker.hostPath("D:\\", "win32", "podman")).toBe("/mnt/d")
    expect(SandboxDocker.hostPath("/home/me/repo", "linux", "docker")).toBe("/home/me/repo")
    const mounts = SandboxDocker.bindArgs(
      { root: "D:\\development\\axsion-web", protect: [".git"], outside: [], extra: [] },
      "win32",
      "docker",
    ).filter((arg) => arg !== "--mount")
    expect(mounts).toEqual([
      `type=bind,source=D:/development/axsion-web,target=${SandboxDocker.WORKSPACE}`,
      `type=bind,source=D:/development/axsion-web/.git,target=${SandboxDocker.WORKSPACE}/.git,readonly`,
    ])
  })

  test("copy mode fetches the repository by a file URL git reads on Windows", () => {
    expect(SandboxGit.fileUrl("D:/development/axsion-web", "win32")).toBe("file:///D:/development/axsion-web")
    expect(SandboxGit.fileUrl("D:\\development\\axsion-web", "win32")).toBe("file:///D:/development/axsion-web")
    expect(SandboxGit.fileUrl("/home/me/repo", "linux")).toBe("file:///home/me/repo")
  })

  test.skipIf(posixOnly)("without getuid (Windows) the sandbox runs as its default user", async () => {
    usePath(await fakeDocker("ok"))
    await SandboxDocker.available()
    const identity = await SandboxDocker.mountIdentity("docker", { platform: "win32", uid: undefined, gid: undefined })
    expect(identity).toEqual(SandboxDocker.DEFAULT_IDENTITY)
  })
})

describe.skipIf(posixOnly)("preflight and doctor", () => {
  test("Docker Desktop stopped: the check fails with the fix, and later ones are skipped", async () => {
    await using project = await tmpdir({ git: true })
    usePath(await fakeDocker("stopped"))
    const checks = await SandboxPreflight.run({ directory: project.path, full: false })
    const byName = Object.fromEntries(checks.map((check) => [check.name, check]))
    expect(byName["container runtime installed"].status).toBe("pass")
    expect(byName["container engine running"].status).toBe("fail")
    expect(byName["container engine running"].fix).toContain("isn't running — start it")
    expect(byName["Linux containers"].status).toBe("skip")
    expect(byName["test container"].status).toBe("skip")
    const printed = checks.flatMap(checkLines).join("\n")
    expect(printed).toContain("FAIL  container engine running:")
    expect(printed).toContain("fix: ")
    const refusal = await SandboxPreflight.refusal(project.path)
    expect(refusal).toStartWith("Docker Desktop isn't running — start it and try again.")
    expect(refusal).not.toContain("pipe")
    expect(refusal).toContain("lunos sandbox doctor")
  })

  test("a private image fails the quick check without downloading anything", async () => {
    await using project = await tmpdir({ git: true })
    usePath(await fakeDocker("denied"))
    const checks = await SandboxPreflight.run({ directory: project.path, full: false })
    const image = checks.find((check) => check.name.startsWith("image "))!
    expect(image.status).toBe("fail")
    expect(image.fix).toContain("docker login ghcr.io")
  })

  test("everything working: every check passes", async () => {
    await using project = await tmpdir({ git: true })
    usePath(await fakeDocker("ok"))
    const checks = await SandboxPreflight.run({ directory: project.path, full: true })
    expect(checks.filter((check) => check.status !== "pass")).toEqual([])
    expect(await SandboxPreflight.refusal(project.path)).toBeUndefined()
  })
})

describe("turning the sandbox on in settings", () => {
  let root: string
  let previous: string
  const original = { ...ConfigSettings.sandboxPreflight }
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-settings-"))
    previous = Global.Path.config
    ;(Global.Path as { config: string }).config = path.join(root, "user")
    await fs.mkdir(path.join(root, "project"), { recursive: true })
    SandboxRollback.take()
  })
  afterEach(async () => {
    Object.assign(ConfigSettings.sandboxPreflight, original)
    ;(Global.Path as { config: string }).config = previous
    await fs.rm(root, { recursive: true, force: true })
    SandboxRollback.take()
  })
  const ctx = () => ({ directory: path.join(root, "project") })

  test("is refused, and nothing is written, when the preflight fails", async () => {
    ConfigSettings.sandboxPreflight.refusal = async () => "container engine running: Docker Desktop isn't running"
    await expect(
      ConfigSettings.set({ key: "sandbox.enabled", value: "true", scope: "user", ctx: ctx(), locked: [] }),
    ).rejects.toThrow("The sandbox wasn't turned on: container engine running")
    expect(existsSync(path.join(root, "user", "opencode.json"))).toBe(false)
    // Turning it off is never checked.
    ConfigSettings.sandboxPreflight.refusal = async () => {
      throw new Error("not called")
    }
    await ConfigSettings.set({ key: "sandbox.enabled", value: "false", scope: "user", ctx: ctx(), locked: [] })
  })

  test("is saved when it passes, with what it replaced kept for the restart", async () => {
    ConfigSettings.sandboxPreflight.refusal = async () => undefined
    const result = await ConfigSettings.set({
      key: "sandbox.enabled",
      value: "true",
      scope: "user",
      ctx: ctx(),
      locked: [],
    })
    expect(JSON.parse(readFileSync(result.file, "utf8")).sandbox.enabled).toBe(true)
    const changes = SandboxRollback.take()
    expect(changes).toEqual([
      { key: "sandbox.enabled", file: result.file, path: ["sandbox", "enabled"], had: false, value: true },
    ])
    // Undone: the key is gone again, and the rest of the file stays.
    expect(SandboxRollback.revert(changes)).toEqual(["sandbox.enabled"])
    expect(JSON.parse(readFileSync(result.file, "utf8")).sandbox).toBeUndefined()
  })

  test("which values turn it on", () => {
    expect(ConfigSettings.turnsSandboxOn("sandbox.enabled", true)).toBe(true)
    expect(ConfigSettings.turnsSandboxOn("sandbox.enabled", false)).toBe(false)
    expect(ConfigSettings.turnsSandboxOn("sandbox.required", true)).toBe(true)
    expect(ConfigSettings.turnsSandboxOn("sandbox", { enabled: true })).toBe(true)
    expect(ConfigSettings.turnsSandboxOn("sandbox.image", "x")).toBe(false)
  })
})

describe("never locked out", () => {
  const failure = new SandboxError({ step: "detect", reason: "docker is installed but its engine isn't running" })
  const exit = process.exitCode
  afterEach(() => {
    process.exitCode = exit
  })

  async function project(sandbox: Record<string, unknown>) {
    const dir = await tmpdir({ git: true })
    const file = path.join(dir.path, "opencode.json")
    await Bun.write(file, JSON.stringify({ sandbox }, null, 2))
    return { dir, file }
  }

  test("after /restart, the sandbox change is undone and Lunos starts as before", async () => {
    let paused = 0
    const { dir, file } = await project({ enabled: true })
    await using _ = dir
    const changes = [
      { key: "sandbox.enabled", file, path: ["sandbox", "enabled"], had: true, previous: false, value: true },
    ]
    const ask = async () => {
      throw new Error("not asked: the rollback decides")
    }
    expect(
      await fallback(failure, dir.path, changes, ask, true, async () => {
        paused++
      }),
    ).toBe("host")
    expect(paused).toBe(1)
    expect(JSON.parse(readFileSync(file, "utf8")).sandbox.enabled).toBe(false)
  })

  test("a change edited since isn't touched", () => {
    const file = path.join(os.tmpdir(), `lunos-rollback-${process.pid}.json`)
    require("node:fs").writeFileSync(file, JSON.stringify({ sandbox: { enabled: "edited" } }))
    expect(
      SandboxRollback.revert([{ key: "sandbox.enabled", file, path: ["sandbox", "enabled"], had: false, value: true }]),
    ).toEqual([])
  })

  test("interactive: Yes starts without the sandbox, Quit doesn't start", async () => {
    const { dir } = await project({ enabled: true })
    await using _ = dir
    expect(await fallback(failure, dir.path, [], async () => "yes", true)).toBe("host")
    expect(await fallback(failure, dir.path, [], async () => "quit", true)).toBe("quit")
    expect(process.exitCode).toBe(1)
  })

  test("non-interactive: the error stands (exit 1 with the reason)", async () => {
    const { dir } = await project({ enabled: true })
    await using _ = dir
    await expect(fallback(failure, dir.path, [], async () => "yes", false)).rejects.toBe(failure)
  })

  test("sandbox.required: no fallback, no rollback", async () => {
    const { dir, file } = await project({ required: true })
    await using _ = dir
    const changes = [{ key: "sandbox.required", file, path: ["sandbox", "required"], had: false, value: true }]
    await expect(fallback(failure, dir.path, changes, async () => "yes", true)).rejects.toBe(failure)
    expect(JSON.parse(readFileSync(file, "utf8")).sandbox.required).toBe(true)
  })
})

describe("restart", () => {
  test("the relaunch keeps one PATH on Windows", () => {
    expect(Restart.relaunchEnv({ Path: "C:\\a", PATH: "C:\\b", X: "1" }, "win32")).toEqual({ PATH: "C:\\b", X: "1" })
    expect(Restart.relaunchEnv({ Path: "a", PATH: "b" }, "linux")).toEqual({ Path: "a", PATH: "b" })
  })

  test("the manual command runs in PowerShell when the path needs quotes", () => {
    expect(Restart.manualCommand({ file: "C:\\Program Files\\lunos.exe", base: [], args: ["-s", "x"] }, "win32")).toBe(
      '& "C:\\Program Files\\lunos.exe" -s x\n  (in cmd.exe: "C:\\Program Files\\lunos.exe" -s x)',
    )
    expect(Restart.manualCommand({ file: "C:\\lunos\\lunos.exe", base: [], args: [] }, "win32")).toBe(
      "C:\\lunos\\lunos.exe",
    )
  })

  test("the handoff carries the sandbox changes saved for this restart", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "restart-"))
    const handoff = path.join(dir, "h.json")
    const changes = [{ key: "sandbox.enabled", file: "/x.json", path: ["sandbox", "enabled"], had: false, value: true }]
    await Restart.relaunch(
      { sessionID: "ses_1", fresh: false, cancelled: [] },
      {
        platform: "linux",
        execve: () => {},
        spawn: async () => 0,
        preflight: () => ({ ok: true, version: "1" }),
        write: () => {},
        error: () => {},
        exit: () => {},
      },
      {
        execPath: "/opt/lunos",
        argv: ["/opt/lunos", "/$bunfs/root/lunos"],
        execArgv: [],
        env: {},
        cwd: dir,
        handoff,
        changes,
      },
    )
    expect(JSON.parse(readFileSync(handoff, "utf8")).changes).toEqual(changes)
  })
})

test.skipIf(posixOnly)("the fake docker is what ran", async () => {
  // A positive control for the tests above: with the fake first on PATH, `docker` is the fake.
  usePath(await fakeDocker("ok"))
  expect((await $`docker --version`.text()).trim()).toBe("Docker version 27.3.1, build ce12230")
})
