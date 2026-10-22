// XCOD-294: signing in to Claude Code / Codex from /claude and /codex with the tool's own login.
//
// The TUI has no terminal pane of its own, so it does what it does for $EDITOR: it suspends, hands
// this terminal to the tool's login command, and comes back when the command exits. The command's
// stdin, stdout and stderr are the terminal itself (always "inherit", there's no option to pipe them),
// so whatever the user types or the tool prints, codes and keys included, never passes through Lunos.
import type { CliRenderer } from "@opentui/core"
import { spawn as nodeSpawn } from "node:child_process"
import { existsSync } from "node:fs"
import { which } from "@opencode-ai/core/util/which"
import type { ExternalTool } from "./external"

/**
 * The tool's own sign-in as its `--help` lists it: Claude Code 2.1.304 `claude auth login`, Codex 0.160.1
 * `codex login` (the same as the server's ExternalDetect.LOGIN). Fixed here, not sent by the server, and
 * never the flags that read a key or token from stdin (`--with-api-key`, `--with-access-token`).
 */
export const LOGIN_ARGS: Record<ExternalTool, readonly string[]> = { claude: ["auth", "login"], codex: ["login"] }

export function loginLine(tool: ExternalTool) {
  return [tool, ...LOGIN_ARGS[tool]].join(" ")
}

/** The tool this machine runs: `external.<tool>.path` from the config, else the one on PATH. */
export function loginExecutable(tool: ExternalTool, configured?: string) {
  return configured ?? which(tool) ?? undefined
}

/** As the server starts it (ExternalDetect.command): a .js/.ts script with this Bun, a Windows shim in a shell. */
export function loginCommand(tool: ExternalTool, file: string) {
  const args = [...LOGIN_ARGS[tool]]
  if (/\.(m?[jt]s)$/i.test(file)) return { file: process.execPath, args: [file, ...args], shell: false }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) return { file, args, shell: true }
  return { file, args, shell: false }
}

/** The user's environment minus what a parent Claude Code session injects (as ExternalDetect.environment). */
export function loginEnvironment(base: NodeJS.ProcessEnv = process.env) {
  const env = { ...base }
  for (const key of Object.keys(env))
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_PID") delete env[key]
  return env
}

/**
 * The login lands where the server's tool reads it only when the server runs as this user on this
 * machine: not in a sandbox container, and with the same home (which `lunos attach` to another machine,
 * or to a server running as someone else, doesn't have).
 */
export function loginIsLocal(input: { sandbox: boolean; serverHome: string | undefined; home: string }) {
  return !input.sandbox && !!input.serverHome && input.serverHome === input.home
}

type Renderer = Pick<CliRenderer, "suspend" | "resume" | "requestRender"> & {
  currentRenderBuffer: { clear(): void }
}

/**
 * Runs the tool's login on this terminal and resolves with its exit code (null when it couldn't start).
 * `spawn` is only for tests to watch what was started.
 */
export async function runLogin(input: {
  tool: ExternalTool
  file: string
  renderer: Renderer
  cwd?: string
  spawn?: typeof nodeSpawn
}) {
  const cmd = loginCommand(input.tool, input.file)
  input.renderer.suspend()
  input.renderer.currentRenderBuffer.clear()
  process.stdout.write(`\nSigning in with ${loginLine(input.tool)}. Lunos resumes when it finishes.\n\n`)
  // Ctrl+C reaches every process on the terminal: it's meant for the login, and Lunos only waits.
  const ignore = () => {}
  process.on("SIGINT", ignore)
  try {
    return await new Promise<number | null>((resolve) => {
      const child = (input.spawn ?? nodeSpawn)(cmd.file, cmd.args, {
        cwd: input.cwd && existsSync(input.cwd) ? input.cwd : process.cwd(),
        env: loginEnvironment(),
        stdio: "inherit",
        shell: cmd.shell,
      })
      child.on("error", () => resolve(null))
      child.on("exit", (code) => resolve(code))
    })
  } finally {
    process.off("SIGINT", ignore)
    input.renderer.currentRenderBuffer.clear()
    input.renderer.resume()
    input.renderer.requestRender()
  }
}
