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

/**
 * XCOD-297: the sandbox setting as it really is on this computer: what the next start does, and
 * the config layers that decide it. One answer for /settings, the badge and startup.
 */
export type SandboxSetting = {
  /** Whether the next plain `lunos` start here uses the sandbox. */
  on: boolean
  /** Short, for the list: "on", "off", "off (after a failure)", "on (required)". */
  display: string
  /** One line saying why: "on · set in ~/repo/opencode.json (project)". */
  detail: string
  /** The highest layer that turns it on, and its file. */
  layer?: "user" | "project" | "env" | "managed"
  file?: string
  /** Why it can't be turned off here (an organisation lock, sandbox.required), and who set it. */
  fixed?: string
  /** Who fixed it: the organisation (shown locked), or sandbox.required in a config file. */
  fixedBy?: "managed" | "config"
  /** Off only because it failed to start here (XCOD-281); the config still turns it on. */
  disabled?: boolean
}

/** XCOD-297: a setting saved on this computer by the host, as PATCH /config/settings answers. */
export type SandboxSaved =
  | {
      ok: true
      key: string
      value?: unknown
      file: string
      scope: "user" | "project"
      restart: boolean
      changed: boolean
    }
  | { ok: false; error: string }

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
  /**
   * XCOD-297: set while the TUI is attached to a sandboxed server. The server's /settings writes
   * land in the container's copy of the config, which this computer never reads; `sandbox.*` is
   * read here, at start-up, so it's read and written here, by this process.
   */
  settings?: {
    sandbox: () => SandboxSetting
    set: (input: { key: string; value: string; scope: "user" | "project"; unset?: boolean }) => Promise<SandboxSaved>
  }
}

/** XCOD-301: a sandbox whose results a background handoff couldn't save; it's kept, stopped. */
export type SandboxUnsaved = {
  id: string
  reason: string
  /** The helper's run log, with the full error. */
  log?: { id: string; file: string }
}

/**
 * XCOD-301: what the command that started the TUI offers for results that weren't saved: the toast
 * at start, and its Retry, Open log and Attach.
 */
export type SandboxHandback = {
  unsaved: () => SandboxUnsaved[]
  /** Hand the results back again, in the background; settles once that has finished. */
  retry: (id: string) => Promise<{ ok: true; detail: string } | { ok: false; reason: string }>
  /** Reopen it (`lunos sandbox attach <id>`) once the TUI has exited. */
  attach: (id: string) => void
}

/** The toast's text for results that weren't saved. */
export function unsavedToast(item: SandboxUnsaved, more = 0) {
  return [
    `⚠ Results from sandbox ${item.id} weren't saved: ${item.reason}`,
    "The sandbox is kept (stopped), with the agent's work in it.",
    // The actions are mouse-only; the same from the shell.
    `\`lunos sandbox conclude ${item.id}\` tries again; \`lunos sandbox destroy ${item.id}\` gives them up.`,
    ...(more ? [`${more} more: \`lunos sandbox status <id>\``] : []),
  ].join("\n")
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
