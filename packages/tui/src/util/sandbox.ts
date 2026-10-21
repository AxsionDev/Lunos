// XCOD-281: the sandbox starts behind the TUI. The command that started the TUI owns it and reports
// where it is; the TUI shows it (a line at the bottom, a toast, a banner) and holds prompts until
// it's ready.

/** Why the sandbox couldn't start, as the user sees it. */
export type SandboxFailure = {
  /** A known cause, never "Unexpected error". */
  reason: string
  /** What to do about it, when known. */
  fix?: string
  /** ISO time of the failure. */
  time: string
  /** The run log that has the full error. */
  log?: { id: string; file: string }
  /** Set when nothing may run without it: sandbox.required (managed or config), or `--sandbox=strict`. */
  requiredBy?: "managed" | "config" | "flag"
}

export type SandboxState =
  /** Being created or started; `detail` is its latest step ("copying …", "image …"). */
  | { status: "starting"; detail?: string }
  | { status: "ready"; id: string }
  /** sandbox.required and it failed: nothing runs until Retry works. */
  | { status: "blocked"; failure: SandboxFailure }
  /** It failed: Lunos restarts without it, handing over the unsent prompt. */
  | { status: "failed"; failure: SandboxFailure }
  /**
   * Lunos runs on this computer because the sandbox was turned off after a failure. `announce` is
   * set right after the failure (the toast); later starts only show the badge.
   */
  | { status: "off"; failure: SandboxFailure; announce?: boolean; queued?: boolean }

/** What the command that started the TUI offers for its sandbox. */
export type SandboxHost = {
  state: () => SandboxState
  subscribe: (listener: (state: SandboxState) => void) => () => void
  /** Under sandbox.required: start it again here. */
  retry: () => void
  /** Clear the "turned off after a failure" state: the next start uses the sandbox again. */
  reenable: () => void
  /** `lunos sandbox doctor`'s checks, as it prints them. */
  doctor: () => Promise<string>
}

/** Whether prompts wait: the sandbox is still starting, or required and not running. */
export function holds(state: SandboxState | undefined) {
  return state?.status === "starting" || state?.status === "blocked" || state?.status === "failed"
}

const day = (time: string) => {
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? time : date.toLocaleDateString(undefined, { day: "numeric", month: "short" })
}

/** The line at the bottom of the screen, or undefined when there is nothing to say. */
export function statusLine(state: SandboxState | undefined) {
  if (!state) return undefined
  switch (state.status) {
    case "starting":
      return `Sandbox starting…${state.detail ? ` (${state.detail})` : ""}`
    case "ready":
      return `Sandbox ready · ${state.id}`
    case "blocked":
      return `Sandbox required but not running: ${state.failure.reason}`
    case "failed":
      return "Sandbox off: failed to start"
    case "off":
      return `no sandbox · sandbox off after a failure on ${day(state.failure.time)}`
  }
}

/** The sticky toast after a failure: the known cause and its fix when there is one (XCOD-279's wording). */
export function failureToast(failure: SandboxFailure) {
  return [
    `⚠ The sandbox couldn't start: ${failure.fix ?? failure.reason}`,
    "Lunos is running WITHOUT the sandbox.",
  ].join("\n")
}

/** The banner under sandbox.required. */
export function requiredBanner(failure: SandboxFailure) {
  const by =
    failure.requiredBy === "managed"
      ? "Your organisation requires the sandbox"
      : failure.requiredBy === "flag"
        ? "You started Lunos with --sandbox=strict"
        : "The sandbox is required here"
  return [
    `${by}, and it couldn't start: ${failure.reason}`,
    failure.fix ? `Fix: ${failure.fix}` : "Fix: run `lunos sandbox doctor` to see what's wrong.",
    "Prompts can't run until it starts. Nothing runs on this computer.",
    ...(failure.log ? [`Log: ${failure.log.file}`] : []),
  ].join("\n")
}

/** The question for a prompt that was waiting for the sandbox when it failed. */
export const SEND_QUESTION = "Send the queued prompt to the host (no sandbox)?"
