export * as ExternalDetect from "./detect"

import { spawn } from "child_process"
import { which } from "@opencode-ai/core/util/which"

/**
 * XCOD-204: which external coding CLIs are installed here, their versions and login state.
 * Uses the user's own install and login; nothing here reads or copies a credential, and the
 * account e-mail a tool reports is not kept.
 */

export type Tool = "claude" | "codex"

export const TOOLS: Record<Tool, { label: string; provider: string; install: string; flags: string[] }> = {
  claude: {
    label: "Claude Code",
    provider: "anthropic",
    install: "npm install -g @anthropic-ai/claude-code (https://docs.anthropic.com/en/docs/claude-code)",
    // The headless host protocol the adapter speaks; older releases don't have it.
    flags: ["--input-format", "--output-format", "--permission-prompts"],
  },
  codex: {
    label: "Codex CLI",
    provider: "openai",
    install: "npm install -g @openai/codex (https://developers.openai.com/codex/cli)",
    flags: ["exec"],
  },
}

export interface Status {
  tool: Tool
  label: string
  installed: boolean
  path?: string
  version?: string
  /** true / false when the tool can tell us; undefined when it can't. */
  loggedIn?: boolean
  authMethod?: string
  /** Installed, but missing something the adapter needs. */
  outdated?: string
  /** What to do when it isn't usable. */
  hint?: string
}

/** The environment a tool runs with: the user's, minus what a parent Claude Code session injects. */
export function environment(base: NodeJS.ProcessEnv = process.env) {
  const env = { ...base }
  for (const key of Object.keys(env))
    if (key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_") || key === "CLAUDE_PID") delete env[key]
  return env
}

/**
 * How to start `file` on this platform. A script (.js/.ts, like the tests' fake tool) runs with
 * this Bun; a Windows .cmd/.bat (npm's shim for a global install) needs a shell, so every argument
 * passed to it must be a fixed flag or a validated id, never user text (prompts go over stdin).
 */
export function command(file: string, args: string[]) {
  if (/\.(m?[jt]s)$/i.test(file)) return { file: process.execPath, args: [file, ...args], shell: false }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) return { file, args, shell: true }
  return { file, args, shell: false }
}

export function run(file: string, args: string[], timeoutMs = 15_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const cmd = command(file, args)
    const child = spawn(cmd.file, cmd.args, { env: environment(), shell: cmd.shell, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on("error", () => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export function locate(tool: Tool, configured?: string) {
  return configured ?? which(tool) ?? undefined
}

export async function detect(tool: Tool, configured?: string): Promise<Status> {
  const spec = TOOLS[tool]
  const base = { tool, label: spec.label }
  const file = locate(tool, configured)
  if (!file)
    return { ...base, installed: false, hint: `${spec.label} isn't installed. Install it with: ${spec.install}` }
  const version = await run(file, ["--version"])
  if (version.code !== 0)
    return {
      ...base,
      installed: false,
      path: file,
      hint: `${file} didn't run (${version.stderr.trim() || "no output"})`,
    }
  const help = await run(file, ["--help"])
  const missing = spec.flags.filter((flag) => !help.stdout.includes(flag))
  const status: Status = {
    ...base,
    installed: true,
    path: file,
    // "2.1.295 (Claude Code)" and "codex-cli 0.160.1": the number isn't always first.
    version: /\d+\.\d+\.\d+\S*/.exec(version.stdout)?.[0] ?? version.stdout.trim().split(/\s+/)[0],
    ...(missing.length
      ? { outdated: `missing ${missing.join(", ")}`, hint: `Update ${spec.label}: ${spec.install}` }
      : {}),
  }
  if (tool === "claude") {
    const auth = await run(file, ["auth", "status"])
    try {
      const parsed = JSON.parse(auth.stdout) as { loggedIn?: boolean; authMethod?: string }
      status.loggedIn = parsed.loggedIn === true
      status.authMethod = parsed.authMethod
    } catch {
      status.loggedIn = undefined
    }
  }
  if (tool === "codex") {
    const auth = await run(file, ["login", "status"])
    status.loggedIn = auth.code === 0 ? true : auth.code === null ? undefined : false
  }
  if (status.loggedIn === false && !status.hint)
    status.hint = `Log in to ${spec.label} first: run \`${tool} ${tool === "claude" ? "auth login" : "login"}\` in a terminal`
  return status
}
