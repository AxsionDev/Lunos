export * as MemoryKey from "./key"

import crypto from "node:crypto"
import { Global } from "@opencode-ai/core/global"

/**
 * The ledger's encryption key (XCOD-136, `memory.encryption: "os-keychain"`). A random 256-bit key,
 * kept only in the OS keychain: macOS Keychain, Windows Credential Manager, or libsecret on Linux
 * (through `Bun.secrets`). It is never written to config, to the data directory or to the ledger;
 * each encrypted ledger line records only the key's id, the first 8 hex digits of its SHA-256, so a
 * wrong key is told apart from a damaged line.
 *
 * One key per Lunos data directory: the keychain account is named after a hash of that directory,
 * so a second install (or a test's throwaway HOME) never reads or overwrites another's key.
 *
 * Losing the key loses the ledger: nothing else holds it. Lunos never creates a new key while an
 * encrypted ledger line exists, and refuses to read or write memory until the key is back.
 */

export const SERVICE = "lunos-memory"

/** How long to wait for the keychain. A locked keychain, or none at all, can block indefinitely. */
const TIMEOUT_MS = 30_000

export class KeyError extends Error {
  override name = "MemoryKeyError"
}

export interface Keychain {
  get(input: { service: string; name: string }): Promise<string | null>
  set(input: { service: string; name: string; value: string }): Promise<void>
  delete(input: { service: string; name: string }): Promise<boolean>
}

let keychain: Keychain | undefined

/** Tests replace the OS keychain with an in-memory one. */
export function use(replacement: Keychain | undefined) {
  keychain = replacement
  cached = undefined
}

function system(): Keychain {
  if (keychain) return keychain
  const secrets = (Bun as unknown as { secrets?: Keychain }).secrets
  if (!secrets) throw new KeyError("This build of Lunos has no OS keychain access (Bun.secrets is missing)")
  return secrets
}

export function account(dataDir = Global.Path.data) {
  return `ledger-key:${crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 16)}`
}

export function describe() {
  return `service "${SERVICE}", account "${account()}"`
}

export function id(key: Buffer) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8)
}

async function timed<T>(what: string, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new KeyError(
            `The OS keychain didn't answer within ${TIMEOUT_MS / 1000}s while ${what}. Is it locked, or is there no keychain (libsecret on Linux)?`,
          ),
        ),
      TIMEOUT_MS,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    if (error instanceof KeyError) throw error
    throw new KeyError(`The OS keychain refused while ${what}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    clearTimeout(timer)
  }
}

let cached: Buffer | undefined

/** The key, or undefined when the keychain has none. Throws when the keychain can't be reached. */
export async function get(): Promise<Buffer | undefined> {
  if (cached) return cached
  const value = await timed("reading the memory key", system().get({ service: SERVICE, name: account() }))
  if (!value) return undefined
  const key = Buffer.from(value, "base64")
  if (key.byteLength !== 32) throw new KeyError(`The memory key in the OS keychain (${describe()}) is not a 256-bit key`)
  cached = key
  return key
}

/** Create and store a new key. Only called when no encrypted ledger line exists. */
export async function create(): Promise<Buffer> {
  const key = crypto.randomBytes(32)
  await timed("storing a new memory key", system().set({ service: SERVICE, name: account(), value: key.toString("base64") }))
  cached = key
  return key
}

/** Forget the cached key, so the next read goes to the keychain again. */
export function reset() {
  cached = undefined
}

// ---------------------------------------------------------------------------------------------
// One ledger line: AES-256-GCM, a fresh 12-byte IV per line, the fact id as associated data (so a
// line's ciphertext can't be moved onto another fact's id).

export function seal(key: Buffer, factID: string, plain: string) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(factID, "utf8"))
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64")
}

export function open(key: Buffer, factID: string, sealed: string) {
  const data = Buffer.from(sealed, "base64")
  if (data.byteLength < 12 + 16) throw new Error("too short")
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12))
  decipher.setAAD(Buffer.from(factID, "utf8"))
  decipher.setAuthTag(data.subarray(data.byteLength - 16))
  return Buffer.concat([decipher.update(data.subarray(12, data.byteLength - 16)), decipher.final()]).toString("utf8")
}
