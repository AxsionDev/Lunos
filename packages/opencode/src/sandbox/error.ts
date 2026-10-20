// XCOD-279: every way a sandbox can fail to start, as one error that always says which step failed,
// what ran (secrets redacted), its exit code and stderr, and for the known cases what to do about it.
// The CLI prints its message as is (see cli/error.ts), so a sandbox failure never ends in the
// generic "Unexpected error".

export type Step = "detect" | "image" | "create" | "start" | "connect"

/** How much of a failing command's stderr is shown. */
const TAIL = 8

/** Environment variable names whose values never appear in a printed command. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|COOKIE/i

/** The command as it can be printed: `--env NAME=value` with a secret-looking NAME, and URL credentials, hidden. */
export function redact(argv: readonly string[]) {
  return argv.map((arg, index) => {
    const previous = argv[index - 1]
    const masked = arg.replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, "//***@")
    if ((previous === "--env" || previous === "-e") && /^[^=]+=/.test(masked)) {
      const name = masked.slice(0, masked.indexOf("="))
      return SECRET_NAME.test(name) ? `${name}=***` : masked
    }
    return masked
  })
}

/** Quote an argument for display only (never executed). */
const shown = (arg: string) => (/^[\w@%+=:,./\\{}|*-]+$/.test(arg) ? arg : JSON.stringify(arg))

export const commandLine = (argv: readonly string[]) => redact(argv).map(shown).join(" ")

/** The last lines of a command's error output, trimmed. */
export const tail = (text: string, lines = TAIL) => text.trim().split(/\r?\n/).slice(-lines).join("\n")

const desktop = (platform: NodeJS.Platform) => platform === "win32" || platform === "darwin"

/**
 * The fix line for the failures people actually hit, from what the runtime printed. Undefined when
 * the text matches none of them: a wrong guess is worse than none.
 */
export function diagnose(text: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (
    /OSType:?\s*windows|no matching manifest for windows|cannot be used on this platform|Windows-containers mode/i.test(
      text,
    )
  )
    return (
      "Docker is in Windows-containers mode, and the sandbox needs Linux containers: right-click the Docker Desktop " +
      'icon in the notification area, choose "Switch to Linux containers…", then try again.'
    )
  if (
    /WSL ?2? (is not installed|isn't installed|installation is incomplete)|wsl --install|requires WSL ?2|WSL kernel/i.test(
      text,
    )
  )
    return "Docker Desktop needs WSL 2: run `wsl --install` in an administrator PowerShell, restart Windows, start Docker Desktop, then try again."
  if (/command was not found|is not recognized|ENOENT|executable file not found|wasn't found on PATH/i.test(text))
    return platform === "win32"
      ? "Install Docker Desktop (https://docs.docker.com/desktop/setup/install/windows-install/) and start it. If it's already installed, open a new terminal so it's on PATH."
      : "Install Docker (Docker Desktop, Docker Engine) or Podman and start it, then try again."
  if (/permission denied while trying to connect to the Docker daemon/i.test(text))
    return "Your user isn't allowed to use Docker: add it to the docker group (`sudo usermod -aG docker $USER`), log in again, then try again."
  if (/podman.*(machine|socket)|Cannot connect to Podman/i.test(text))
    return "Podman isn't running — start it with `podman machine start` and try again."
  if (
    /Cannot connect to the Docker daemon|error during connect|\/\/\.\/pipe\/docker|docker_engine|dockerDesktopLinuxEngine|The system cannot find the file specified|Is the docker daemon running|docker\.sock: connect/i.test(
      text,
    )
  )
    return desktop(platform)
      ? "Docker Desktop isn't running — start it and try again."
      : "Docker isn't running — start it (`sudo systemctl start docker`) and try again."
  if (/port is already allocated|address already in use|Only one usage of each socket address/i.test(text))
    return "A port the sandbox needs is in use: stop what holds it, or remove sandboxes you don't need (`lunos sandbox list`, `lunos sandbox destroy <id>`)."
  if (
    /pull access denied|denied|unauthorized|authentication required|403 Forbidden|manifest unknown|not found: manifest|requested access to the resource/i.test(
      text,
    )
  )
    return (
      "The sandbox image can't be pulled from here. If you have access, log in (`docker login ghcr.io`); otherwise build " +
      'one locally (`bun run packages/opencode/script/sandbox-image.ts`) and set "sandbox": { "image": "lunos-sandbox:local" } ' +
      "in your global config."
    )
  if (
    /dial tcp|no such host|i\/o timeout|TLS handshake timeout|network is unreachable|Temporary failure in name resolution|Client.Timeout/i.test(
      text,
    )
  )
    return "The container runtime couldn't reach the image registry: check your connection or proxy (Docker Desktop: Settings → Resources → Proxies), then try again."
  if (/sandbox\.workspace "mount"/.test(text)) return 'Use "sandbox": { "workspace": "copy" } in your global config.'
  if (/isn't in one|has none yet/.test(text))
    return "Run Lunos from a git repository with at least one commit, or start it without the sandbox (`lunos --no-sandbox`)."
  return undefined
}

/** A meaningful one-line description of anything thrown, including non-Errors and empty messages. */
export function describe(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.trim()) return error.message.trim()
    const type = error.name || error.constructor?.name || "Error"
    const where = error.stack?.split("\n").find((line) => line.trim().startsWith("at "))
    return `${type} with no message${where ? ` (${where.trim()})` : ""}`
  }
  if (error === undefined || error === null) return `${error} was thrown instead of an error`
  if (typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message.trim()
    let text: string
    try {
      text = JSON.stringify(error)
    } catch {
      text = Object.prototype.toString.call(error)
    }
    return `a non-error ${error.constructor?.name ?? "object"} was thrown: ${text}`
  }
  return `a ${typeof error} was thrown: ${String(error)}`
}

export type Fields = {
  step?: Step
  /** What went wrong, in one line. */
  reason: string
  /** The command that ran, as an argv (redacted when printed), or another SandboxError's already printable one. */
  command?: readonly string[] | string
  code?: number
  stderr?: string
  fix?: string
}

export class SandboxError extends Error {
  readonly _tag = "SandboxError"
  step?: Step
  readonly reason: string
  readonly command?: string
  readonly code?: number
  readonly stderr?: string
  readonly fix?: string

  constructor(fields: Fields, options?: { cause?: unknown }) {
    super(fields.reason, options)
    this.name = "SandboxError"
    this.step = fields.step
    this.reason = fields.reason.trim() || "the sandbox failed without saying why"
    this.command = typeof fields.command === "string" ? fields.command : fields.command && commandLine(fields.command)
    this.code = fields.code
    this.stderr = fields.stderr?.trim() ? tail(fields.stderr) : undefined
    this.fix = fields.fix ?? diagnose([fields.reason, fields.stderr ?? ""].join("\n"))
    this.message = this.render()
  }

  /** The reason and the fix, without the command's output: for prompts and toasts. */
  get summary() {
    return this.fix ? `${this.reason}\n${this.fix}` : this.reason
  }

  render() {
    return [
      `The sandbox couldn't start${this.step ? ` (${this.step})` : ""}: ${this.reason}`,
      ...(this.command ? [`  command: ${this.command}`] : []),
      ...(this.code !== undefined ? [`  exit code: ${this.code}`] : []),
      ...(this.stderr ? this.stderr.split("\n").map((line) => `  | ${line}`) : []),
      ...(this.fix ? [`Fix: ${this.fix}`] : []),
    ].join("\n")
  }
}

/** Anything thrown during `step`, as a SandboxError. One that already names its step keeps it. */
export function wrap(step: Step, error: unknown): SandboxError {
  if (error instanceof SandboxError) {
    if (!error.step) {
      error.step = step
      error.message = error.render()
    }
    return error
  }
  return new SandboxError({ step, reason: describe(error) }, { cause: error })
}

/** Run `fn`, turning whatever it throws into a SandboxError for `step`. */
export async function at<A>(step: Step, fn: () => Promise<A>): Promise<A> {
  try {
    return await fn()
  } catch (error) {
    throw wrap(step, error)
  }
}

export const isSandboxError = (error: unknown): error is SandboxError =>
  error instanceof SandboxError ||
  (!!error && typeof error === "object" && (error as { _tag?: unknown })._tag === "SandboxError")

export * as SandboxFailure from "./error"
