// XCOD-317: "Try Lunos Cloud", once after sign-in: the TUI steps aside for `lunos cloud quickstart` on
// this terminal (as it does for $EDITOR and /claude's login) and comes back when it finishes. The
// offer is dismissed for good when it's run or hidden, kept in kv on this machine only.
import type { CliRenderer } from "@opentui/core"
import { spawn as nodeSpawn } from "node:child_process"
import { existsSync } from "node:fs"
import type { TerminalCommand } from "./account"

/** The kv key: true once the offer was run or hidden. */
export const DISMISSED = "cloud_try_dismissed"

/** Whether the home screen offers it: signed in, not dismissed, and the host can run it here. */
export function offered(input: { signedIn: boolean; dismissed: boolean; local: boolean; command: boolean }) {
  return input.signedIn && !input.dismissed && input.local && input.command
}

type Renderer = Pick<CliRenderer, "suspend" | "resume" | "requestRender"> & {
  currentRenderBuffer: { clear(): void }
}

/** "Press enter": until a line (or the end of input) arrives on this terminal. */
async function pause() {
  const { createInterface } = await import("node:readline/promises")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await rl
    .question("\nPress enter to go back to Lunos. ")
    .catch(() => undefined)
    .finally(() => rl.close())
}

/** Runs `command` on this terminal and resolves with its exit code (null when it couldn't start). */
export async function runOnTerminal(input: {
  command: TerminalCommand
  renderer: Renderer
  cwd: string
  spawn?: typeof nodeSpawn
  pause?: () => Promise<void>
}) {
  input.renderer.suspend()
  input.renderer.currentRenderBuffer.clear()
  process.stdout.write("\nLunos Cloud quickstart. Lunos resumes when it finishes.\n\n")
  // Ctrl+C is for the quickstart (it ends its run's worker); the TUI only waits.
  const ignore = () => {}
  process.on("SIGINT", ignore)
  try {
    return await new Promise<number | null>((resolve) => {
      const [file, ...args] = input.command.argv
      const child = (input.spawn ?? nodeSpawn)(file!, args, {
        cwd: existsSync(input.cwd) ? input.cwd : process.cwd(),
        env: input.command.env,
        stdio: "inherit",
        windowsVerbatimArguments: input.command.verbatim,
      })
      child.on("error", () => resolve(null))
      child.on("exit", (code) => resolve(code))
    }).then(async (code) => {
      // Its last lines are the results branch: kept on screen until the person goes back.
      await (input.pause ?? pause)()
      return code
    })
  } finally {
    process.off("SIGINT", ignore)
    input.renderer.currentRenderBuffer.clear()
    input.renderer.resume()
    input.renderer.requestRender()
  }
}
