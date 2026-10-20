import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { FormatUnknownError } from "../../src/cli/error"
import { Failure } from "../../src/cli/failure"
import { Zip } from "../../src/util/zip"
import { issueURL } from "../../src/cli/cmd/logs"
import * as Pty from "./fixtures/tui-pty"

// XCOD-280: every failure ends with "Full log: <path>" and "Report it: lunos bug-report <id>"; the
// log has the full error; `lunos logs` and `lunos bug-report` find and pack it, redacted.

const TIMEOUT = 120_000
const homes: string[] = []
afterAll(async () => {
  for (const home of homes) await fs.rm(home, { recursive: true, force: true })
})

/** Runs `lunos` from source without a terminal, in a throwaway HOME (the pty fixture's isolation). */
async function lunos(args: string[], options: Pty.Options = {}) {
  const prepared = await Pty.prepare(options)
  homes.push(prepared.home)
  // The fixture's PATH is minimal; the docker CLI is linked in (its daemon is never reached: DOCKER_HOST).
  const docker = Bun.which("docker")
  if (docker) await fs.symlink(docker, path.join(prepared.dirs.bin, "docker")).catch(() => {})
  const child = Bun.spawn(
    [process.execPath, "run", "--cwd", path.resolve(import.meta.dir, "../.."), "src/index.ts", ...args],
    {
      cwd: prepared.dirs.project,
      env: prepared.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const logDir = path.join(prepared.dirs.data, "opencode", "log")
  return { stdout, stderr, code, logDir, ...prepared }
}

const footer = (stderr: string) => {
  const match = /Full log: (\S+)\n {2}Report it: lunos bug-report ([0-9a-f]+)/.exec(stderr)
  if (!match) throw new Error(`No log footer in:\n${stderr}`)
  return { file: match[1]!, id: match[2]! }
}

describe("FormatUnknownError", () => {
  test("a non-Error throw says what it was, with its value", () => {
    expect(FormatUnknownError("boom")).toBe("non-Error value thrown (string): boom")
    expect(FormatUnknownError(undefined)).toBe("non-Error value thrown (undefined): undefined")
    expect(FormatUnknownError({ code: 7 })).toContain('non-Error value thrown (object): {\n  "code": 7\n}')
  })
  test("an Error shows its cause chain, one line each; the stack is for the log", () => {
    const error = new Error("The sandbox couldn't start", {
      cause: new TypeError("fetch failed", { cause: "ECONNREFUSED" }),
    })
    expect(FormatUnknownError(error)).toBe(
      "Error: The sandbox couldn't start\ncaused by: TypeError: fetch failed\ncaused by: non-Error value thrown (string): ECONNREFUSED",
    )
  })
})

describe("the footer", () => {
  test("an OSC 8 file:// link where the terminal supports it, else the plain path", () => {
    const file = "/tmp/log dir/lunos-2026-10-20-1412-a3f9.log"
    expect(Failure.link(file, false)).toBe(file)
    expect(Failure.link(file, true)).toBe(
      `\x1b]8;;file:///tmp/log%20dir/lunos-2026-10-20-1412-a3f9.log\x1b\\${file}\x1b]8;;\x1b\\`,
    )
    expect(Failure.lines({ id: "a3f9", file }, "The sandbox couldn't start", false)).toEqual([
      "✗ The sandbox couldn't start",
      `  Full log: ${file}`,
      "  Report it: lunos bug-report a3f9",
    ])
  })
  test("which terminals get a link", () => {
    expect(Failure.hyperlinks({ WT_SESSION: "x" }, true)).toBe(true) // Windows Terminal
    expect(Failure.hyperlinks({ TERM_PROGRAM: "iTerm.app" }, true)).toBe(true)
    expect(Failure.hyperlinks({ VTE_VERSION: "7600" }, true)).toBe(true) // GNOME Terminal
    expect(Failure.hyperlinks({ TERM_PROGRAM: "Apple_Terminal" }, true)).toBe(false)
    expect(Failure.hyperlinks({ TERM_PROGRAM: "iTerm.app" }, false)).toBe(false) // not a terminal
    expect(Failure.hyperlinks({ TERM_PROGRAM: "iTerm.app", TMUX: "1" }, true)).toBe(false)
    expect(Failure.hyperlinks({ FORCE_HYPERLINK: "1" }, false)).toBe(true)
  })
  test("which commands get a run log", () => {
    expect(Failure.wanted([])).toBe(true)
    expect(Failure.wanted(["run", "hi"])).toBe(true)
    expect(Failure.wanted(["logs"])).toBe(false)
    expect(Failure.wanted(["bug-report", "a3f9"])).toBe(false)
    expect(Failure.wanted(["mcp", "bridge"])).toBe(false)
    expect(Failure.wanted(["--version"])).toBe(false)
  })
})

describe("retention config", () => {
  test("global config sets it; a managed lock wins outright", () => {
    expect(Failure.retention({ log: { retention_days: 3, max_mb: 5 } }, {})).toEqual({ days: 3, maxMb: 5 })
    expect(Failure.retention({ log: { retention_days: 3 } }, { log: { max_mb: 9 } })).toEqual({ days: 3, maxMb: 9 })
    expect(
      Failure.retention({ log: { retention_days: 3, max_mb: 5 } }, { log: { retention_days: 30 }, $locked: ["log"] }),
    ).toEqual({ days: 30, maxMb: undefined })
    expect(Failure.retention({ log: { max_mb: -1 } }, {})).toEqual({})
  })
})

describe("zip", () => {
  test("a stored zip that unzip reads back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-zip-"))
    homes.push(dir)
    const file = path.join(dir, "a.zip")
    await fs.writeFile(
      file,
      Zip.zip([
        { name: "a.txt", data: "hello" },
        { name: "b/ü.txt", data: "wörld\n".repeat(100) },
      ]),
    )
    const test = Bun.spawnSync(["unzip", "-t", file])
    expect(test.exitCode).toBe(0)
    expect(Bun.spawnSync(["unzip", "-p", file, "a.txt"]).stdout.toString()).toBe("hello")
  })
  test("the issue page carries the version, OS and id only", () => {
    const url = new URL(issueURL("a3f9"))
    expect(url.origin + url.pathname).toBe("https://github.com/AxsionDev/Lunos/issues/new")
    expect([...url.searchParams.keys()].sort()).toEqual(["lunos-version", "os", "reproduce", "template", "title"])
  })
})

// The seeded secrets: an API key held in an env var (no recognisable prefix), one as a literal in
// config, one behind {env:}, a header, a password flag and a GitHub token.
const SEEDS = {
  envKey: "ZqEnvKey0123456789abcdefABCDEF99",
  literal: "ZqLiteralKey0123456789abcdefXYZ7",
  referenced: "ZqReferencedKey0123456789abcdQRS",
  header: "ZqHeaderToken0123456789abcdefLMN",
  prompt: "SEEDED_PROMPT_TEXT_zq81",
}
const seededConfig = {
  model: "local/m",
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local",
      options: { baseURL: "http://127.0.0.1:9/v1", apiKey: SEEDS.literal },
      models: { m: { name: "m" } },
    },
    other: { options: { apiKey: "{env:ZQ_REFERENCED}" } },
  },
  mcp: {
    remote: {
      type: "remote",
      url: "http://127.0.0.1:9/mcp",
      enabled: false,
      headers: { Authorization: `Bearer ${SEEDS.header}` },
    },
  },
  sandbox: { enabled: true },
}
const seededEnv = {
  MY_SERVICE_API_KEY: SEEDS.envKey,
  ZQ_REFERENCED: SEEDS.referenced,
  // Unreachable daemon: the docker CLI is there and fails with real stderr; Docker Desktop is untouched.
  DOCKER_HOST: "unix:///nonexistent-lunos-test.sock",
  OPENCODE_CONFIG_CONTENT: JSON.stringify(seededConfig),
}
const hasDocker = !!Bun.which("docker")

describe("a failing sandboxed run (the reported case: Docker not running)", () => {
  test.skipIf(!hasDocker)(
    "prints the reason, Full log and the report command; the log has the docker command, exit code, stderr and stack",
    async () => {
      const result = await lunos(["run", "--sandbox", SEEDS.prompt], { env: seededEnv })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("Sandboxed runs need Docker or Podman")
      expect(result.stderr).toContain("Fix: ")
      const { file, id } = footer(result.stderr)
      expect(path.dirname(file)).toBe(result.logDir)
      expect(path.basename(file)).toMatch(new RegExp(`^lunos-\\d{4}-\\d{2}-\\d{2}-\\d{4}-${id}\\.log$`))
      const log = await fs.readFile(file, "utf8")
      expect(log).toMatch(/\$ docker info --format \S+ {2}→ exit 1/)
      expect(log).toContain("stderr:")
      expect(log).toContain("nonexistent-lunos-test.sock")
      expect(log).toMatch(/at available \(.*sandbox\/docker\.ts/)
      expect(log).toContain("--- docker version")
      expect(log).toContain("=== result: failed (exit 1)")
      for (const seed of Object.values(SEEDS)) expect(log).not.toContain(seed)

      // lunos logs: the list, one by id, --dir.
      const list = await lunos(["logs"], { env: seededEnv, home: result.home })
      expect(list.stdout).toContain(`${id}  `)
      expect(list.stdout).toContain("failed")
      const shown = await lunos(["logs", id], { env: seededEnv, home: result.home })
      expect(shown.stdout).toBe(log)
      const dir = await lunos(["logs", "--dir"], { env: seededEnv, home: result.home })
      expect(dir.stdout.trim()).toBe(result.logDir)
      // Looking at logs doesn't make logs of its own.
      expect((await fs.readdir(result.logDir)).filter((name) => name.endsWith(".log"))).toHaveLength(1)

      // lunos bug-report: a zip with no secret and no prompt, and nothing opened or uploaded.
      const report = await lunos(["bug-report", id], { env: seededEnv, home: result.home })
      expect(report.code).toBe(0)
      const zip = report.stdout.trim()
      expect(zip).toBe(path.join(result.logDir, `lunos-bug-report-${id}.zip`))
      expect(Bun.spawnSync(["unzip", "-t", zip]).exitCode).toBe(0)
      const names = Bun.spawnSync(["unzip", "-Z1", zip]).stdout.toString().trim().split("\n")
      expect(names).toEqual([path.basename(file), "version.txt", "config.json", "system.txt", "README.txt"])
      const contents = Bun.spawnSync(["unzip", "-p", zip]).stdout.toString()
      for (const seed of Object.values(SEEDS)) expect(contents).not.toContain(seed)
      expect(contents).toContain('"sandbox"')
      expect(await fs.readFile(report.opened, "utf8").catch(() => "")).toBe("")
      expect(report.stderr).toContain("nothing was uploaded")
    },
    TIMEOUT,
  )
})

describe("unexpected errors in a plain command", () => {
  for (const kind of ["exception", "rejection"])
    test(
      `an unhandled ${kind} ends with the log link; the log has the stack and the cause`,
      async () => {
        const result = await lunos(["debug", "crash", kind])
        expect(result.code).toBe(1)
        expect(result.stderr).toContain("✗ Lunos stopped because of an unexpected error: Error: Deliberate crash")
        expect(result.stderr).toContain("caused by: Error: the cause")
        const { file } = footer(result.stderr)
        const log = await fs.readFile(file, "utf8")
        expect(log).toContain(`=== FAILURE in an unhandled ${kind === "exception" ? "exception" : "promise rejection"}`)
        expect(log).toContain("caused by:\nError: the cause")
        expect(log).toMatch(/at .*debug\/index\.ts/)
      },
      TIMEOUT,
    )
})

describe("a background failure in the TUI (pty, 120x45)", () => {
  test(
    "an MCP server that doesn't start: an error toast with Open log, which shows this run's log; /logs lists it",
    async () => {
      const tui = await Pty.launch({
        config: { mcp: { broken: { type: "local", command: ["/nonexistent/lunos-test-mcp"] } } },
      })
      homes.push(tui.home)
      try {
        const screen = await tui.waitFor("Open log (/logs)", 60_000)
        expect(screen).toContain("MCP server failed")
        // The server's log lines reach the file in batches, within a second.
        await Bun.sleep(1500)
        // Click "Open log": SGR mouse press and release on its first cell.
        const lines = screen.split("\n")
        const row = lines.findIndex((line) => line.includes("Open log (/logs)"))
        const col = lines[row]!.indexOf("Open log (/logs)")
        tui.press(`\x1b[<0;${col + 2};${row + 1}M`)
        tui.press(`\x1b[<0;${col + 2};${row + 1}m`)
        const viewer = await tui.waitFor("To report it: lunos bug-report", 20_000)
        const id = /lunos bug-report ([0-9a-f]+)/.exec(viewer)![1]!
        const logs = await fs.readdir(path.join(tui.dirs.data, "opencode", "log"))
        const file = logs.find((name) => name.endsWith(`-${id}.log`))
        expect(file).toBeDefined()
        expect(await fs.readFile(path.join(tui.dirs.data, "opencode", "log", file!), "utf8")).toContain(
          "MCP server failed to start",
        )
        tui.press(Pty.KEY.escape)
        await Bun.sleep(300)
        await tui.type("/logs")
        await Bun.sleep(300)
        tui.press(Pty.KEY.enter)
        const list = await tui.waitFor("this run", 20_000)
        expect(list).toContain(id)
      } finally {
        await tui.stop()
      }
    },
    TIMEOUT,
  )
})

describe("crashes in the TUI (pty, 120x45)", () => {
  /** What was written after the TUI left the alternate screen for the last time. */
  const afterTui = (raw: string) => raw.slice(raw.lastIndexOf("\x1b[?1049l"))

  test(
    "a TUI crash shows the crash screen with the log; quitting restores the terminal, then prints the link",
    async () => {
      const tui = await Pty.launch({ env: { LUNOS_DEBUG_CRASH: "tui" } })
      homes.push(tui.home)
      try {
        const screen = await tui.waitFor("Lunos crashed", 60_000)
        // The path wraps on screen.
        expect(screen.replace(/\n\s*/g, "")).toMatch(/Full log: .*lunos-\d{4}-\d{2}-\d{2}-\d{4}-[0-9a-f]+\.log/)
        tui.press("q")
        const until = Date.now() + 20_000
        while (tui.exited() === undefined && Date.now() < until) await Bun.sleep(100)
        expect(tui.exited()).toBeDefined()
        const tail = afterTui(tui.raw())
        expect(tail).toContain("Full log: ")
        expect(tail).toMatch(/Report it: lunos bug-report [0-9a-f]+/)
        const file = /Full log: (?:\x1b\]8;;[^\x1b]*\x1b\\)?([^\x1b\r\n]+)/.exec(tail)![1]!
        const log = await fs.readFile(file, "utf8")
        expect(log).toContain("=== FAILURE in the TUI")
        expect(log).toContain("Deliberate crash (LUNOS_DEBUG_CRASH=tui)")
      } finally {
        await tui.stop()
      }
    },
    TIMEOUT,
  )

  test(
    "a worker crash restores the terminal and prints the link",
    async () => {
      const tui = await Pty.launch({ env: { LUNOS_DEBUG_CRASH: "worker" } })
      homes.push(tui.home)
      try {
        const until = Date.now() + 60_000
        while (tui.exited() === undefined && Date.now() < until) await Bun.sleep(100)
        expect(tui.exited()).toBe(1)
        const tail = afterTui(tui.raw())
        expect(tail).toContain("✗ Lunos's background worker stopped unexpectedly.")
        expect(tail).toContain("Full log: ")
        // Restored: mouse tracking off and the cursor shown, before the message.
        expect(tui.raw()).toContain("\x1b[?1000l")
        expect(tui.raw()).toContain("\x1b[?25h")
      } finally {
        await tui.stop()
      }
    },
    TIMEOUT,
  )
})
