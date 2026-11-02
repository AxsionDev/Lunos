export * as Browser from "."

import { ConfigBrowser } from "@opencode-ai/core/config/browser"
import { Control } from "@/control"
import { SandboxConfig } from "@/sandbox/config"
import { BrowserBridge } from "./bridge"
import { BrowserDriver } from "./driver"
import { BrowserLaunch } from "./launch"

// XCOD-327: the one browser this Lunos controls, started on first use. "lunos" mode starts the
// Lunos browser; "extension" mode waits for the user's own browser to connect. A closed browser or
// a changed mode starts afresh on the next action.

let active: { key: string; driver: Promise<BrowserDriver.Driver> } | undefined

export class SandboxedError extends Error {
  constructor() {
    super(
      'Inside a sandbox the agent can only use the Lunos browser, headless, in the sandbox. Your own browser (browser.mode "extension") is on the host and is refused.',
    )
    this.name = "BrowserSandboxedError"
  }
}

export function mode(config: ConfigBrowser.Info | undefined) {
  return config?.mode ?? "lunos"
}

export function get(config: ConfigBrowser.Info | undefined) {
  const sandboxed = SandboxConfig.inside()
  if (sandboxed && mode(config) === "extension") throw new SandboxedError()
  const headless = sandboxed || config?.headless === true
  const key = JSON.stringify([mode(config), headless, config?.executable, config?.port, config?.stop_key])
  if (active?.key === key) return active.driver
  const previous = active
  void previous?.driver.then((driver) => driver.dispose()).catch(() => {})
  const driver = open(config, headless)
  const entry = { key, driver }
  active = entry
  driver
    .then((item) =>
      item.browser.onClose(() => {
        if (active === entry) active = undefined
      }),
    )
    .catch(() => {
      if (active === entry) active = undefined
    })
  return driver
}

async function open(config: ConfigBrowser.Info | undefined, headless: boolean) {
  const options = {
    stopKey: Control.parseKey(config?.stop_key),
    downloadsDir: BrowserLaunch.downloadsDir(),
    onMessage: (message: BrowserDriver.Message) =>
      message.kind === "stop" ? Control.stop("browser", message.origin) : Control.pause("browser", message.origin),
  }
  if (mode(config) === "extension") {
    const bridge = await BrowserBridge.serve({
      port: config?.port,
      onStop: (origin) => Control.stop("browser", origin),
    })
    await bridge.ready(5_000).catch((error) => {
      bridge.browser.dispose()
      throw error
    })
    return new BrowserDriver.Driver(bridge.browser, options)
  }
  const browser = await BrowserLaunch.start({ executable: config?.executable, headless })
  return new BrowserDriver.Driver(browser, options)
}

/** Closes the browser connection (the Lunos browser itself closes with it). */
export async function close() {
  const current = active
  active = undefined
  await current?.driver.then((driver) => driver.dispose()).catch(() => {})
}
