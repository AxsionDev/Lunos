export * as CloudStore from "./store"

import fs from "fs/promises"
import path from "path"
import { spawn } from "child_process"
import { Global } from "@opencode-ai/core/global"
import type { CloudOidc } from "./oidc"

/**
 * XCOD-185: where the Lunos Cloud session is kept. In the OS keychain where there is one (macOS
 * Keychain via `security`, Linux Secret Service via `secret-tool`), otherwise in a file only the
 * user can read. One session per machine user; logging in again replaces it.
 *
 * On macOS, `security add-generic-password` takes the secret as an argument (as the Go and Rust
 * keyring libraries do), so it is briefly visible to the user's own `ps`. secret-tool reads it
 * from stdin.
 */

export interface Session {
  issuer: string
  clientID: string
  tokens: CloudOidc.Tokens
  email?: string
  sub: string
  savedAt: string
}

const SERVICE = "lunos-cloud"
const ACCOUNT = "default"

export type Backend = "keychain" | "secret-service" | "file"

const file = () => path.join(Global.Path.data, "cloud", "session.json")

function run(cmd: string, args: string[], input?: string) {
  return new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"] })
    let stdout = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.on("error", () => resolve({ code: null, stdout: "" }))
    child.on("close", (code) => resolve({ code, stdout }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

let cached: Backend | undefined

/** The backend in use here. `LUNOS_CLOUD_STORE=file` forces the file (tests, headless servers). */
export async function backend(): Promise<Backend> {
  if (process.env.LUNOS_CLOUD_STORE === "file") return "file"
  if (cached) return cached
  if (process.platform === "darwin" && (await run("/usr/bin/security", ["help"])).code !== null)
    return (cached = "keychain")
  if (process.platform === "linux" && (await run("secret-tool", ["--version"])).code === 0)
    return (cached = "secret-service")
  return (cached = "file")
}

export async function save(session: Session) {
  const secret = JSON.stringify(session)
  const where = await backend()
  if (where === "keychain") {
    const result = await run("/usr/bin/security", [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
      "-l",
      "Lunos Cloud",
      "-w",
      secret,
    ])
    if (result.code === 0) return where
  }
  if (where === "secret-service") {
    const result = await run(
      "secret-tool",
      ["store", "--label=Lunos Cloud", "service", SERVICE, "account", ACCOUNT],
      secret,
    )
    if (result.code === 0) return where
  }
  await fs.mkdir(path.dirname(file()), { recursive: true, mode: 0o700 })
  await fs.writeFile(file(), secret, { mode: 0o600 })
  await fs.chmod(file(), 0o600).catch(() => {})
  return "file" as const
}

export async function load(): Promise<Session | undefined> {
  const where = await backend()
  let text: string | undefined
  if (where === "keychain") {
    const result = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
    if (result.code === 0) text = result.stdout.trim()
  }
  if (where === "secret-service") {
    const result = await run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT])
    if (result.code === 0 && result.stdout.trim()) text = result.stdout.trim()
  }
  text ??= await fs.readFile(file(), "utf8").catch(() => undefined)
  if (!text) return undefined
  try {
    return JSON.parse(text) as Session
  } catch {
    return undefined
  }
}

export async function clear() {
  const where = await backend()
  if (where === "keychain") await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
  if (where === "secret-service") await run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT])
  await fs.rm(file(), { force: true })
}
