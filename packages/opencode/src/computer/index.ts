export * as Computer from "."

import { Control } from "@/control"
import { SandboxConfig } from "@/sandbox/config"
import { ConfigComputer } from "@opencode-ai/core/config/computer"
import { Desktop } from "./desktop"

// XCOD-339: the desktop this Lunos controls. The platform backend is loaded on first use, never at
// start-up: macOS and Windows bind to system libraries that don't exist elsewhere.
//
// While the agent is in control (from its first action until a minute without one), a watcher:
// - polls the stop key every 40 ms, anywhere on the computer, and stops browser and computer
//   control at once when it's held;
// - pauses control when the mouse moves without Lunos moving it: the user took over;
// - shows "Lunos is controlling your computer · Stop" on screen.

export class UnsupportedError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = "ComputerUnsupportedError"
  }
}

let loaded: Promise<Desktop.Desktop> | undefined
let override: Desktop.Desktop | undefined

/** Test hook: control this desktop instead of the real one (undefined to go back). */
export function use(desktop: Desktop.Desktop | undefined) {
  override = desktop
  end()
}

export function get(): Promise<Desktop.Desktop> {
  if (override) return Promise.resolve(override)
  loaded ??= load().catch((error) => {
    loaded = undefined
    throw error
  })
  return loaded
}

async function load(): Promise<Desktop.Desktop> {
  if (process.platform === "darwin") {
    const { MacDesktop } = await import("./macos")
    return new MacDesktop()
  }
  if (process.platform === "win32") {
    const { WindowsDesktop } = await import("./windows")
    return new WindowsDesktop()
  }
  if (process.platform === "linux") {
    const { LinuxDesktop } = await import("./linux")
    throw new UnsupportedError(LinuxDesktop.reason())
  }
  throw new UnsupportedError(`Computer control isn't available on ${process.platform}.`)
}

/** Why host control is refused here, or undefined: never from inside a sandbox. */
export function sandboxed(inside = SandboxConfig.inside()) {
  if (!inside) return undefined
  return "Refused: this session runs in a sandbox, and computer control would act on your computer outside it. Host control is refused while the sandbox is on. Use the browser tool (it runs inside the sandbox) or turn the sandbox off for this task."
}

// ---------------------------------------------------------------------------------------------
// The watcher

const TICK_MS = 40
const IDLE_MS = 60_000
/** Mouse input this long after Lunos's own last event is the user's. */
const OWN_EVENT_SLACK_MS = 250

type Watch = {
  desktop: Desktop.Desktop
  stop: Desktop.Combo
  timer: ReturnType<typeof setInterval>
  indicator?: { close(): void }
  deadline: number
  posted: number
}
let watch: Watch | undefined

Control.onStop((kind) => {
  if (kind === "computer") end()
})

/** Control is active: start (or extend) the watcher. */
export function active(desktop: Desktop.Desktop, config: ConfigComputer.Info | undefined) {
  const now = Date.now()
  if (watch?.desktop === desktop) {
    watch.deadline = now + IDLE_MS
    return watch
  }
  end()
  const stopKey = config?.stop_key ?? ConfigComputer.DEFAULT_STOP_KEY
  const created: Watch = {
    desktop,
    stop: Desktop.parse(stopKey),
    deadline: now + IDLE_MS,
    posted: now,
    timer: setInterval(() => tick(created), TICK_MS),
  }
  created.timer.unref?.()
  watch = created
  created.indicator = desktop.indicator({ stopKey, onStop: () => Control.stopAll("indicator") })
  return created
}

let asking = 0

/** A prompt to the user opened (+1) or closed (-1): no pause for mouse input while one is open. */
export function prompting(delta: 1 | -1) {
  asking = Math.max(0, asking + delta)
}

/** Lunos just sent input: mouse movement until shortly after is its own. */
export function posted() {
  if (watch) watch.posted = Date.now()
}

/** The stop key, as parsed for this desktop session. */
export function stopKey(config: ConfigComputer.Info | undefined) {
  return Desktop.parse(config?.stop_key ?? ConfigComputer.DEFAULT_STOP_KEY)
}

function tick(current: Watch) {
  if (watch !== current) return
  if (current.desktop.held(current.stop)) {
    Control.stopAll("stop key")
    return
  }
  const last = current.desktop.lastMouseInput()
  if (asking === 0 && last !== undefined && last > current.posted + OWN_EVENT_SLACK_MS && !Control.held("computer")) {
    Control.pause("computer", "mouse")
  }
  if (Date.now() > current.deadline) end()
}

export function end() {
  const current = watch
  watch = undefined
  if (!current) return
  clearInterval(current.timer)
  current.indicator?.close()
}

/** Whether the watcher is running (tests). */
export function watching() {
  return watch !== undefined
}
