export * as CloudStore from "./store"

import fs from "fs/promises"
import path from "path"
import { spawn } from "child_process"
import { Global } from "@opencode-ai/core/global"
import { CloudOidc } from "./oidc"
import { CloudDefaults } from "./defaults"

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
  /** XCOD-273: taken from `LUNOS_TOKEN`, not stored; it can't be refreshed. */
  fromEnv?: boolean
}

/** XCOD-273: an access token for CI and headless runs, used when no sign-in is stored. */
export const TOKEN_ENV = "LUNOS_TOKEN"

/** The session `LUNOS_TOKEN` stands for, read at call time. Its claims are only displayed, never trusted. */
export function fromEnv(): Session | undefined {
  const token = process.env[TOKEN_ENV]?.trim()
  if (!token) return
  const claims = CloudOidc.claims(token)
  return {
    issuer: typeof claims.iss === "string" ? claims.iss : CloudDefaults.DEFAULT_ISSUER,
    clientID: typeof claims.azp === "string" ? claims.azp : "lunos-cli",
    tokens: {
      access_token: token,
      token_type: "Bearer",
      expires_at: typeof claims.exp === "number" ? claims.exp : undefined,
    },
    email: typeof claims.email === "string" ? claims.email : undefined,
    sub: typeof claims.sub === "string" ? claims.sub : "lunos-token",
    savedAt: new Date().toISOString(),
    fromEnv: true,
  }
}

const SERVICE = "lunos-cloud"
const ACCOUNT = "default"

export type Backend = "keychain" | "secret-service" | "file" | "test-keychain"

const file = () => path.join(Global.Path.data, "cloud", "session.json")
/** XCOD-273: the stand-in keychain tests use, so no test ever reads or writes the user's real one. */
export const testKeychain = () => path.join(Global.Path.data, "cloud", "test-keychain.json")

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

/**
 * The backend in use here. `LUNOS_CLOUD_STORE=file` forces the file (tests, headless servers);
 * `test-keychain` a fake keychain under the data directory, for tests that check a sign-in lands in
 * the keychain without touching the real one.
 */
export async function backend(): Promise<Backend> {
  if (process.env.LUNOS_CLOUD_STORE === "file") return "file"
  if (process.env.LUNOS_CLOUD_STORE === "test-keychain") return "test-keychain"
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
  if (where === "test-keychain") {
    await fs.mkdir(path.dirname(testKeychain()), { recursive: true, mode: 0o700 })
    await fs.writeFile(testKeychain(), JSON.stringify({ service: SERVICE, account: ACCOUNT, secret }), { mode: 0o600 })
    return where
  }
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
  if (where === "test-keychain")
    text = await fs
      .readFile(testKeychain(), "utf8")
      .then((raw) => (JSON.parse(raw) as { secret?: string }).secret)
      .catch(() => undefined)
  if (where === "keychain") {
    const result = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"])
    if (result.code === 0) text = result.stdout.trim()
  }
  if (where === "secret-service") {
    const result = await run("secret-tool", ["lookup", "service", SERVICE, "account", ACCOUNT])
    if (result.code === 0 && result.stdout.trim()) text = result.stdout.trim()
  }
  text ??= await fs.readFile(file(), "utf8").catch(() => undefined)
  if (!text) return fromEnv()
  try {
    return JSON.parse(text) as Session
  } catch {
    return fromEnv()
  }
}

export async function clear() {
  const where = await backend()
  if (where === "test-keychain") await fs.rm(testKeychain(), { force: true })
  if (where === "keychain") await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT])
  if (where === "secret-service") await run("secret-tool", ["clear", "service", SERVICE, "account", ACCOUNT])
  await fs.rm(file(), { force: true })
}
