// XCOD-144: the one place the sandbox shells out (docker, git, tar). Arguments are always passed as
// an argv array, never through a shell.

export type Result = { code: number; stdout: string; stderr: string }

export type Options = {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Bytes or text written to stdin, then closed. */
  input?: string
  /** Pipe another process's stdout into this one's stdin. */
  stdin?: ReadableStream<Uint8Array>
}

export async function run(cmd: string[], options: Options = {}): Promise<Result> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: options.stdin ?? (options.input !== undefined ? new Blob([options.input]) : "ignore"),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/** Like `run`, but throws with the command's stderr when it fails. */
export async function check(cmd: string[], options: Options = {}): Promise<string> {
  const result = await run(cmd, options)
  if (result.code !== 0)
    throw new Error(
      `${cmd.slice(0, 3).join(" ")} failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    )
  return result.stdout
}

/** Run `from | to` and fail if either side fails. */
export async function pipe(from: string[], to: string[], options: { from?: Options; to?: Options } = {}) {
  const source = Bun.spawn(from, {
    cwd: options.from?.cwd,
    env: options.from?.env ? { ...process.env, ...options.from.env } : process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [sink, sourceErr, sourceCode] = await Promise.all([
    run(to, { ...options.to, stdin: source.stdout }),
    new Response(source.stderr).text(),
    source.exited,
  ])
  if (sourceCode !== 0)
    throw new Error(`${from.slice(0, 3).join(" ")} failed (exit ${sourceCode}): ${sourceErr.trim()}`)
  if (sink.code !== 0)
    throw new Error(
      `${to.slice(0, 3).join(" ")} failed (exit ${sink.code}): ${sink.stderr.trim() || sink.stdout.trim()}`,
    )
  return sink.stdout
}

export * as SandboxExec from "./exec"
