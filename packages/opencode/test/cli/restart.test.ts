import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Restart } from "../../src/cli/restart"
import type { RelaunchDeps } from "../../src/cli/restart"

const compiled = ["bun", "/$bunfs/root/lunos"]
const windowsCompiled = ["bun", "B:/~BUN/root/lunos.exe"]
const source = ["/usr/local/bin/bun", "/repo/packages/opencode/src/index.ts"]

describe("relaunchArgs (XCOD-129)", () => {
  test("adds --session to the original arguments", () => {
    expect(Restart.relaunchArgs(["--model", "fake/m", "proj"], { sessionID: "ses_1", fresh: false })).toEqual([
      "--model",
      "fake/m",
      "proj",
      "--session",
      "ses_1",
    ])
  })

  test("replaces the session, continue, fork and prompt options in every spelling", () => {
    const args = ["-s", "old", "--session=old2", "-c", "--continue", "--fork", "--prompt", "hi", "--prompt=x", "proj"]
    expect(Restart.relaunchArgs(args, { sessionID: "ses_new", fresh: false })).toEqual(["proj", "--session", "ses_new"])
  })

  test("--fresh starts without a session", () => {
    expect(Restart.relaunchArgs(["-s", "old", "--mode", "plan"], { sessionID: "ses_1", fresh: true })).toEqual([
      "--mode",
      "plan",
    ])
  })

  test("keeps the attach URL and other options", () => {
    expect(
      Restart.relaunchArgs(["attach", "http://127.0.0.1:4096", "--dir", "/p", "-s", "x"], {
        sessionID: "ses_2",
        fresh: false,
      }),
    ).toEqual(["attach", "http://127.0.0.1:4096", "--dir", "/p", "--session", "ses_2"])
  })

  test("never touches what follows --", () => {
    expect(Restart.relaunchArgs(["proj", "--", "-s", "literal"], { sessionID: "ses_3", fresh: false })).toEqual([
      "proj",
      "--session",
      "ses_3",
      "--",
      "-s",
      "literal",
    ])
  })
})

describe("resolveCommand (XCOD-129)", () => {
  const base = {
    execPath: "/old/lunos",
    execArgv: [] as string[],
    args: ["--session", "ses_1"],
    platform: "darwin" as const,
    which: () => "/new/bin/lunos",
    exists: () => true,
  }

  test("a compiled binary relaunches the same executable, without the embedded entry", () => {
    expect(Restart.resolveCommand({ ...base, argv: compiled, upgraded: false })).toEqual({
      file: "/old/lunos",
      base: [],
      args: ["--session", "ses_1"],
    })
  })

  test("after /update the new install is found on PATH, not at the old execPath", () => {
    expect(Restart.resolveCommand({ ...base, argv: compiled, upgraded: true })).toMatchObject({
      file: "/new/bin/lunos",
      base: [],
    })
  })

  test("a vanished executable is looked up on PATH too", () => {
    expect(Restart.resolveCommand({ ...base, argv: compiled, upgraded: false, exists: () => false }).file).toBe(
      "/new/bin/lunos",
    )
  })

  test("without lunos on PATH it falls back to the old executable", () => {
    expect(Restart.resolveCommand({ ...base, argv: compiled, upgraded: true, which: () => null }).file).toBe(
      "/old/lunos",
    )
  })

  test("from source it reruns bun with its flags and the entry script, and ignores PATH", () => {
    expect(
      Restart.resolveCommand({
        ...base,
        execPath: "/usr/local/bin/bun",
        execArgv: ["--conditions=browser"],
        argv: source,
        upgraded: true,
      }),
    ).toEqual({
      file: "/usr/local/bin/bun",
      base: ["--conditions=browser", "/repo/packages/opencode/src/index.ts"],
      args: ["--session", "ses_1"],
    })
  })

  test("recognises Windows compiled binaries", () => {
    expect(Restart.isCompiled(windowsCompiled[1])).toBe(true)
    expect(Restart.isCompiled("C:\\repo\\src\\index.ts")).toBe(false)
  })
})

describe("Windows (XCOD-129)", () => {
  test("an npm .cmd shim runs through cmd.exe, verbatim", () => {
    const command = Restart.resolveCommand({
      execPath: "C:\\old\\lunos.exe",
      execArgv: [],
      argv: windowsCompiled,
      args: ["--session", "ses_1", "C:\\My Project"],
      upgraded: true,
      platform: "win32",
      which: () => "C:\\Users\\me\\AppData\\Roaming\\npm\\lunos.cmd",
      exists: () => true,
    })
    expect(command.shim).toBe(true)
    expect(Restart.spawnArgv(command, "win32", "C:\\Windows\\system32\\cmd.exe")).toEqual({
      argv: [
        "C:\\Windows\\system32\\cmd.exe",
        "/d",
        "/s",
        "/c",
        `"C:\\Users\\me\\AppData\\Roaming\\npm\\lunos.cmd --session ses_1 "C:\\My Project""`,
      ],
      verbatim: true,
    })
  })

  test("an .exe is spawned directly", () => {
    const command = { file: "C:\\lunos\\lunos.exe", base: [], args: ["--session", "ses_1"] }
    expect(Restart.spawnArgv(command, "win32")).toEqual({
      argv: ["C:\\lunos\\lunos.exe", "--session", "ses_1"],
      verbatim: false,
    })
  })

  test("spawns attached to the console, waits, and exits with the new process's code", async () => {
    const calls: string[] = []
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "restart-"))
    const deps: RelaunchDeps = {
      platform: "win32",
      execve: () => {
        calls.push("execve")
      },
      spawn: async (argv, options) => {
        calls.push(`spawn ${argv.join(" ")} in ${options.cwd}`)
        expect(options.env[Restart.HANDOFF_ENV]).toBeString()
        expect(fs.existsSync(options.env[Restart.HANDOFF_ENV]!)).toBe(true)
        return 7
      },
      preflight: () => ({ ok: true, version: "1.2.3" }),
      write: () => {},
      error: (text) => calls.push(`error ${text}`),
      exit: (code) => {
        calls.push(`exit ${code}`)
      },
    }
    await Restart.relaunch({ sessionID: "ses_1", fresh: false, cancelled: [] }, deps, {
      execPath: "C:\\lunos\\lunos.exe",
      argv: windowsCompiled,
      execArgv: [],
      env: { PATH: "" },
      cwd: "C:\\work",
      handoff: path.join(dir, "h.json"),
    })
    expect(calls).toEqual(["spawn C:\\lunos\\lunos.exe --session ses_1 in C:\\work", "exit 7"])
  })
})

describe("relaunch (XCOD-129)", () => {
  function harness(overrides: Partial<RelaunchDeps> = {}) {
    const calls: { execve?: { file: string; argv: string[]; env: Record<string, string | undefined> } } & {
      errors: string[]
      exits: number[]
      writes: string[]
    } = { errors: [], exits: [], writes: [] }
    const deps: RelaunchDeps = {
      platform: "darwin",
      execve: (file, argv, env) => {
        calls.execve = { file, argv, env }
      },
      spawn: async () => 0,
      preflight: () => ({ ok: true, version: "1.2.3" }),
      write: (text) => calls.writes.push(text),
      error: (text) => calls.errors.push(text),
      exit: (code) => {
        calls.exits.push(code)
      },
      ...overrides,
    }
    return { calls, deps }
  }
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "restart-"))

  test("execs the same binary in place with the same env, plus the handoff", async () => {
    const { calls, deps } = harness()
    const handoff = path.join(dir(), "h.json")
    await Restart.relaunch(
      {
        sessionID: "ses_1",
        fresh: false,
        cancelled: ["job A"],
        draft: { input: "half-typed", parts: [] },
      },
      deps,
      {
        execPath: "/opt/lunos",
        argv: [...compiled, "--model", "fake/m", "-s", "old"],
        execArgv: [],
        env: { PATH: "/usr/bin", KEEP: "1" },
        cwd: "/work",
        handoff,
      },
    )
    expect(calls.execve?.argv).toEqual(["/opt/lunos", "--model", "fake/m", "--session", "ses_1"])
    expect(calls.execve?.env.KEEP).toBe("1")
    expect(calls.execve?.env[Restart.HANDOFF_ENV]).toBe(handoff)
    expect(calls.writes).toEqual([Restart.TERMINAL_RESET])
    const saved = JSON.parse(fs.readFileSync(handoff, "utf8"))
    expect(saved).toMatchObject({
      v: 1,
      sessionID: "ses_1",
      fresh: false,
      cancelled: ["job A"],
      draft: { input: "half-typed", parts: [] },
      manual: "/opt/lunos --model fake/m --session ses_1",
    })
    expect(fs.statSync(handoff).mode & 0o777).toBe(0o600)
  })

  test("a new binary that won't start prints the error and the manual command, once", async () => {
    let preflights = 0
    const { calls, deps } = harness({
      preflight: () => {
        preflights++
        return { ok: false, error: "the new Lunos exited with code 1" }
      },
    })
    await Restart.relaunch({ sessionID: "ses_1", fresh: false, cancelled: [] }, deps, {
      execPath: "/opt/lunos",
      argv: compiled,
      execArgv: [],
      env: {},
      cwd: "/work",
      handoff: path.join(dir(), "h.json"),
    })
    expect(preflights).toBe(1)
    expect(calls.execve).toBeUndefined()
    expect(calls.exits).toEqual([1])
    expect(calls.errors.join("")).toContain("Start it yourself with:\n  /opt/lunos --session ses_1")
  })

  test("a failing exec removes the handoff and reports, without retrying", async () => {
    const handoff = path.join(dir(), "h.json")
    const { calls, deps } = harness({
      execve: () => {
        throw new Error("EACCES")
      },
    })
    await Restart.relaunch({ sessionID: "ses_1", fresh: false, cancelled: [] }, deps, {
      execPath: "/opt/lunos",
      argv: compiled,
      execArgv: [],
      env: {},
      cwd: "/work",
      handoff,
    })
    expect(fs.existsSync(handoff)).toBe(false)
    expect(calls.exits).toEqual([1])
    expect(calls.errors.join("")).toContain("EACCES")
  })
})

describe("handoff (XCOD-129)", () => {
  test("is read once, deleted, and taken out of the environment", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "restart-")), "h.json")
    Restart.writeHandoff(file, {
      v: 1,
      from: "1.0.0",
      sessionID: "ses_1",
      fresh: false,
      cancelled: [],
      manual: "lunos --session ses_1",
    })
    const env: Record<string, string | undefined> = { [Restart.HANDOFF_ENV]: file }
    expect(Restart.takeHandoff(env)?.sessionID).toBe("ses_1")
    expect(env[Restart.HANDOFF_ENV]).toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)

    const out: string[] = []
    expect(Restart.reportFailedStart((text) => out.push(text))).toBe(true)
    expect(out.join("")).toContain("lunos --session ses_1")
    // Said once: a second failure path doesn't print it again.
    expect(Restart.reportFailedStart((text) => out.push(text))).toBe(false)
  })

  test("a missing handoff is ignored", () => {
    expect(Restart.takeHandoff({ [Restart.HANDOFF_ENV]: "/nonexistent/h.json" })).toBeUndefined()
  })
})

describe("manualCommand (XCOD-129)", () => {
  test("quotes for the shell", () => {
    expect(Restart.manualCommand({ file: "/opt/my lunos", base: [], args: ["--prompt", "it's"] }, "linux")).toBe(
      `'/opt/my lunos' --prompt 'it'\\''s'`,
    )
    expect(Restart.manualCommand({ file: "C:\\Program Files\\lunos.exe", base: [], args: ["-s", "x"] }, "win32")).toBe(
      `"C:\\Program Files\\lunos.exe" -s x`,
    )
  })
})
