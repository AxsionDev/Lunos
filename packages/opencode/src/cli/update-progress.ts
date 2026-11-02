import {
  UPGRADE_SLOW_MS,
  upgradeProgressText,
  upgradeStepText,
  type UpgradeStep,
} from "@opencode-ai/core/installation/version"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const CLEAR_LINE = "\r\x1b[2K"

/**
 * XCOD-247: how `lunos update` shows its progress.
 * - `animated`: a terminal, one line rewritten in place with a spinner and the elapsed time.
 * - `static`: a terminal that asked for no motion (`NO_COLOR`, `TERM=dumb`), "Updating… (step)" lines.
 * - `plain`: not a terminal (pipes, CI), one plain line per step and no control characters at all.
 */
export type UpdateProgressMode = "animated" | "static" | "plain"

export function updateProgressMode(
  isTTY: boolean | undefined,
  env: Record<string, string | undefined> = process.env,
): UpdateProgressMode {
  if (!isTTY) return "plain"
  if (env.NO_COLOR || env.TERM === "dumb") return "static"
  return "animated"
}

export function createUpdateProgress(input: {
  mode: UpdateProgressMode
  write: (text: string) => void
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const started = now()
  let current: { step: UpgradeStep; version?: string; since: number; slowNoted: boolean } | undefined
  let frame = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const prefix = (text: string) => (input.mode === "static" ? `Updating… (${text})` : text)

  const render = () => {
    if (!current) return
    if (input.mode === "animated") {
      const text = upgradeProgressText(current.step, current.version, now() - current.since, now() - started)
      input.write(`${CLEAR_LINE}${FRAMES[frame++ % FRAMES.length]} ${text}`)
      return
    }
    // Without animation the slow hint is one extra line, written once per step.
    if (!current.slowNoted && now() - current.since >= UPGRADE_SLOW_MS) {
      current.slowNoted = true
      input.write(prefix("still working — package managers can be slow on first install") + "\n")
    }
  }

  return {
    get step() {
      return current?.step
    },
    set(step: UpgradeStep, version?: string) {
      if (current?.step === step) return
      current = { step, version, since: now(), slowNoted: false }
      if (input.mode !== "animated") input.write(prefix(upgradeStepText(step, version)) + "\n")
      render()
      timer ??= setInterval(render, input.mode === "animated" ? 80 : 1000)
    },
    /** A line of its own above the progress, which then carries on. */
    note(text: string) {
      if (input.mode === "animated") input.write(CLEAR_LINE)
      input.write(text + "\n")
      render()
    },
    /** Ends the progress and leaves nothing of it on the line. */
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
      if (input.mode === "animated" && current) input.write(CLEAR_LINE)
      current = undefined
    },
  }
}
