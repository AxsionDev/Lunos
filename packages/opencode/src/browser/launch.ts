export * as BrowserLaunch from "./launch"

import { existsSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { BrowserCdp } from "./cdp"

// XCOD-327: the Lunos browser. A Chrome-family browser already on this machine, started with a
// profile Lunos owns (cookies and logins persist between sessions, and never mix with the user's
// own profile). Its DevTools endpoint listens on 127.0.0.1 only, on a port the OS picks.

export function profileDir() {
  return path.join(Global.Path.data, "browser", "profile")
}

export function downloadsDir() {
  return path.join(Global.Path.data, "browser", "downloads")
}

/** Chrome, Chromium, Edge and Brave, in that order, where each OS installs them. */
export function candidates(platform = process.platform, env = process.env): string[] {
  if (platform === "darwin")
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    ]
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]].filter(
      (root): root is string => !!root,
    )
    return roots.flatMap((root) => [
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(root, "Chromium", "Application", "chrome.exe"),
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ])
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ]
}

export function find(configured?: string) {
  if (configured) return existsSync(configured) ? configured : undefined
  return candidates().find((item) => existsSync(item))
}

export class NotFoundError extends Error {
  constructor() {
    super(
      "No Chrome, Chromium, Edge or Brave was found for the Lunos browser. Install one, or set browser.executable in /settings › Permissions › Browser & computer.",
    )
    this.name = "BrowserNotFoundError"
  }
}

/** Starts the Lunos browser and connects to it. */
export async function start(input: { executable?: string; headless: boolean; profile?: string }) {
  const executable = find(input.executable)
  if (!executable) throw new NotFoundError()
  const profile = input.profile ?? profileDir()
  await fs.mkdir(profile, { recursive: true, mode: 0o700 })
  const portFile = path.join(profile, "DevToolsActivePort")
  await fs.rm(portFile, { force: true })
  const child = Bun.spawn(
    [
      executable,
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
      "--disable-background-networking",
      ...(input.headless ? ["--headless=new"] : []),
      // Inside a container there's no user namespace for Chrome's own sandbox.
      ...(process.platform === "linux" && input.headless ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  )
  const kill = () => {
    if (child.exitCode === null) child.kill()
  }
  process.once("exit", kill)
  const endpoint = await waitForPort(portFile, child).catch((error) => {
    kill()
    throw error
  })
  const connection = await BrowserCdp.Connection.open(endpoint)
  return BrowserCdp.direct(connection, () => {
    kill()
    process.off("exit", kill)
  })
}

async function waitForPort(file: string, child: { exitCode: number | null }, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `The Lunos browser exited at start (code ${child.exitCode}). Is another Lunos already using its profile at ${path.dirname(file)}?`,
      )
    const text = await Bun.file(file)
      .text()
      .catch(() => "")
    const [port, socket] = text.split("\n")
    if (port && socket) return `ws://127.0.0.1:${port.trim()}${socket.trim()}`
    await Bun.sleep(100)
  }
  throw new Error("The Lunos browser didn't start within 20 seconds.")
}
