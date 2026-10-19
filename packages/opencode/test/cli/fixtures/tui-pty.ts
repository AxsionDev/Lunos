// XCOD-273: runs the TUI from source in a pseudo-terminal at 120x45, with a throwaway HOME and XDG
// directories, and keeps a screen from its output (a small emulator: enough of VT100 for OpenTUI's
// frames). Every outbound request that isn't to 127.0.0.1 goes through a recording proxy that answers
// 403, so a test can assert which hosts the TUI tried to reach without any of them being contacted.

import fs from "fs/promises"
import net from "net"
import os from "os"
import path from "path"
import { spawn } from "@opencode-ai/core/pty/pty.bun"

export const COLS = 120
export const ROWS = 45

/** A screen of ROWS x COLS cells, written to by the TUI's output. */
export class Screen {
  private cells: string[][] = []
  private row = 0
  private col = 0
  constructor(
    readonly cols = COLS,
    readonly rows = ROWS,
  ) {
    this.clear()
  }
  private clear() {
    this.cells = Array.from({ length: this.rows }, () => Array(this.cols).fill(" "))
  }
  private put(char: string) {
    if (this.col >= this.cols) return
    if (this.row >= 0 && this.row < this.rows) this.cells[this.row]![this.col] = char
    this.col++
  }
  // An escape sequence split across two writes waits here for its end.
  private pending = ""
  write(chunk: string) {
    const data = this.pending + chunk
    this.pending = ""
    let i = 0
    while (i < data.length) {
      const ch = data[i]!
      if (ch === "\x1b") {
        const next = data[i + 1]
        if (next === undefined) {
          this.pending = data.slice(i)
          return
        }
        if (next === "[") {
          let j = i + 2
          while (j < data.length && !/[@-~]/.test(data[j]!)) j++
          if (j >= data.length) {
            this.pending = data.slice(i)
            return
          }
          this.csi(data.slice(i + 2, j), data[j]!)
          i = j + 1
          continue
        }
        if (next === "]" || next === "P" || next === "_" || next === "^") {
          // OSC / DCS / APC / PM: up to BEL or ST.
          let j = i + 2
          while (j < data.length && data[j] !== "\x07" && !(data[j] === "\x1b" && data[j + 1] === "\\")) j++
          if (j >= data.length) {
            this.pending = data.slice(i)
            return
          }
          i = data[j] === "\x07" ? j + 1 : j + 2
          continue
        }
        i += 2
        continue
      }
      if (ch === "\r") this.col = 0
      else if (ch === "\n") this.row = Math.min(this.rows - 1, this.row + 1)
      else if (ch === "\b") this.col = Math.max(0, this.col - 1)
      else if (ch >= " ") this.put(ch)
      i++
    }
  }
  private csi(params: string, final: string) {
    if (params.startsWith("?") || params.startsWith(">") || params.startsWith("<") || params.startsWith("=")) return
    const nums = params.split(";").map((value) => (value === "" ? undefined : Number(value)))
    const n = (index: number, fallback: number) => nums[index] ?? fallback
    switch (final) {
      case "H":
      case "f":
        this.row = n(0, 1) - 1
        this.col = n(1, 1) - 1
        return
      case "A":
        this.row = Math.max(0, this.row - n(0, 1))
        return
      case "B":
        this.row = Math.min(this.rows - 1, this.row + n(0, 1))
        return
      case "C":
        this.col = Math.min(this.cols, this.col + n(0, 1))
        return
      case "D":
        this.col = Math.max(0, this.col - n(0, 1))
        return
      case "G":
        this.col = n(0, 1) - 1
        return
      case "d":
        this.row = n(0, 1) - 1
        return
      case "K": {
        const mode = n(0, 0)
        const line = this.cells[this.row]
        if (!line) return
        const [from, to] = mode === 1 ? [0, this.col + 1] : mode === 2 ? [0, this.cols] : [this.col, this.cols]
        for (let c = from; c < to; c++) line[c] = " "
        return
      }
      case "J":
        if (n(0, 0) === 2 || n(0, 0) === 3) this.clear()
        return
      case "X": {
        const line = this.cells[this.row]
        for (let c = this.col; c < Math.min(this.cols, this.col + n(0, 1)); c++) if (line) line[c] = " "
        return
      }
    }
  }
  text() {
    return this.cells.map((line) => line.join("").trimEnd()).join("\n")
  }
}

/** A proxy that records where requests were going (CONNECT host:port, or the absolute URL) and refuses them. */
export async function recordingProxy() {
  const seen: string[] = []
  const server = net.createServer((socket) => {
    socket.on("error", () => {})
    socket.once("data", (buffer) => {
      const [, target] = buffer.toString("latin1").split("\r\n")[0]!.split(" ")
      if (target) seen.push(target)
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    /** The Lunos hosts in `seen`: auth.lunos.tech, cloud.lunos.tech, … */
    lunos: () => seen.filter((target) => /(^|\/\/|\.)lunos\.tech(:\d+)?(\/|$)/.test(target)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export type Options = {
  /** The user's global config (opencode.json). */
  config?: Record<string, unknown>
  /** Managed config (the system directory's managed.json). */
  managed?: Record<string, unknown>
  env?: Record<string, string>
  args?: string[]
  /** After the project directory: `--mini`, say. */
  extraArgs?: string[]
  /** Reuse a HOME from an earlier run (a second start after /logout, say). */
  home?: string
}

const opencode = path.resolve(import.meta.dir, "../../..")

/** Runs `lunos` (the TUI) from source in a pty, isolated: HOME, XDG, managed config, the keychain. */
export async function launch(options: Options = {}) {
  const home = options.home ?? (await fs.mkdtemp(path.join(os.tmpdir(), "lunos-tui-pty-")))
  const dirs = {
    config: path.join(home, ".config"),
    data: path.join(home, ".local/share"),
    cache: path.join(home, ".cache"),
    state: path.join(home, ".local/state"),
    managed: path.join(home, "managed"),
    project: path.join(home, "project"),
    bin: path.join(home, "bin"),
  }
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(path.join(dirs.config, "opencode"), { recursive: true })
  if (options.config)
    await fs.writeFile(path.join(dirs.config, "opencode", "opencode.json"), JSON.stringify(options.config))
  if (options.managed) await fs.writeFile(path.join(dirs.managed, "managed.json"), JSON.stringify(options.managed))
  // The browser: a fake `open` / `xdg-open` that writes down the link instead of opening it.
  const opened = path.join(home, "opened.txt")
  for (const name of ["open", "xdg-open"]) {
    const file = path.join(dirs.bin, name)
    await fs.writeFile(file, `#!/bin/sh\necho "$@" >> "${opened}"\n`)
    await fs.chmod(file, 0o755)
  }
  const env: Record<string, string> = {
    PATH: `${dirs.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    OPENCODE_TEST_HOME: home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: dirs.managed,
    // Never the real keychain: the stand-in one under the data directory.
    LUNOS_CLOUD_STORE: "test-keychain",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_MODELS_PATH: path.join(opencode, "test/tool/fixtures/models-api.json"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    // A local model nobody calls, so nothing hosted is configured.
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "local/m",
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local",
          options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "unused" },
          models: { m: { name: "m" } },
        },
      },
    }),
    NO_PROXY: "127.0.0.1,localhost,.invalid",
    ...options.env,
  }
  await Bun.$`git init -q .`.cwd(dirs.project).quiet()
  const screen = new Screen()
  let raw = ""
  let exited: number | undefined
  const pty = spawn(
    process.execPath,
    ["run", "--cwd", opencode, "src/index.ts", ...(options.args ?? [dirs.project]), ...(options.extraArgs ?? [])],
    {
      name: "xterm-256color",
      cols: COLS,
      rows: ROWS,
      cwd: dirs.project,
      env,
    },
  )
  pty.onData((data) => {
    raw += data
    screen.write(data)
  })
  pty.onExit((event) => (exited = event.exitCode))

  async function waitFor(match: string | RegExp, timeout = 30_000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      const text = screen.text()
      if (typeof match === "string" ? text.includes(match) : match.test(text)) return text
      if (exited !== undefined) break
      await Bun.sleep(100)
    }
    throw new Error(`Timed out waiting for ${match}. Screen:\n${screen.text()}`)
  }

  return {
    home,
    dirs,
    screen,
    raw: () => raw,
    exited: () => exited,
    waitFor,
    /** Sends keys in one write, so an escape sequence isn't read as a bare Esc. */
    press: (keys: string) => pty.write(keys),
    async type(text: string) {
      for (const char of text) {
        pty.write(char)
        await Bun.sleep(15)
      }
    },
    opened: () => fs.readFile(opened, "utf8").catch(() => ""),
    keychain: () =>
      fs.readFile(path.join(dirs.data, "opencode", "cloud", "test-keychain.json"), "utf8").catch(() => ""),
    async stop() {
      if (exited === undefined) pty.kill()
      const until = Date.now() + 5_000
      while (exited === undefined && Date.now() < until) await Bun.sleep(50)
    },
  }
}

export const KEY = {
  enter: "\r",
  down: "\x1b[B",
  up: "\x1b[A",
  right: "\x1b[C",
  left: "\x1b[D",
  space: " ",
  tab: "\t",
  escape: "\x1b",
  ctrlC: "\x03",
}
