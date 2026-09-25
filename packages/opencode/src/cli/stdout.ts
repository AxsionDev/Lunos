import { Effect } from "effect"

/**
 * Write command output to stdout and wait until it has actually been written (XCOD-77).
 *
 * `process.stdout.write` doesn't block on a pipe. A command that writes more than the pipe
 * buffer (64 KiB on macOS, 128 KiB elsewhere) and then exits loses everything past it: the
 * output is cut mid-string, silently, whenever the reader is slower than the process. Debug
 * commands exist to be piped into jq, grep and scripts, so every one of them writes through here.
 */
export function writeStdout(text: string) {
  // Resolves when the whole chunk has been handed to the OS. Not `Bun.write(Bun.stdout, …)`: on a
  // slow reader that writes the first pipe-buffer's worth and then restarts from the beginning,
  // duplicating output (measured: 65536 + 246652 bytes for a 246652-byte config).
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()))
  })
}

/** `writeStdout` as an Effect, for command handlers written as generators. */
export function writeStdoutEffect(text: string) {
  return Effect.promise(() => writeStdout(text))
}
