export * as CloudLegal from "./legal"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Offline } from "@opencode-ai/core/offline"
import { CloudSyncApi } from "./sync-api"

/**
 * XCOD-275: the Terms and the Privacy notice, their versions and where to read them, as Lunos Cloud
 * publishes them (`GET /v1/legal`: `{ terms: { version, url }, privacy: { version, url } }`, no
 * sign-in needed). Nothing about them is built into the client. The last answer is kept on this
 * machine, so a start that can't or mustn't ask (offline, an exemption) uses it, or skips the check.
 */

export type Document = { version: string; url: string }
export type Legal = { terms: Document; privacy: Document }

export const TIMEOUT_MS = 5_000

/** Where the last answer is kept. */
export const cacheFile = () => path.join(Global.Path.cache, "cloud", "legal.json")

const document = (value: unknown): Document | undefined => {
  const item = value as Record<string, unknown> | null | undefined
  const version = item?.version
  const url = item?.url
  if (typeof version !== "string" || !version || typeof url !== "string") return
  // Shown as a link to open: only a web page.
  if (!/^https?:\/\//.test(url)) return
  return { version, url }
}

export function parse(body: unknown): Legal | undefined {
  const item = body as Record<string, unknown> | null | undefined
  const terms = document(item?.terms)
  const privacy = document(item?.privacy)
  return terms && privacy ? { terms, privacy } : undefined
}

/** The last answer kept on this machine, if any. */
export async function cached(): Promise<Legal | undefined> {
  const raw = await fs.readFile(cacheFile(), "utf8").catch(() => undefined)
  if (!raw) return undefined
  try {
    return parse(JSON.parse(raw))
  } catch {
    return undefined
  }
}

export type Options = { fetch?: typeof fetch; endpoint?: string; timeoutMs?: number }

/** Asks Lunos Cloud and keeps the answer; throws when it can't be asked or answers something else. */
export async function fetchLegal(opts: Options = {}): Promise<Legal> {
  const base = opts.endpoint ?? (await CloudSyncApi.endpoint())
  const response = await (opts.fetch ?? fetch)(`${base}/v1/legal`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Lunos Cloud answered ${response.status} for the Terms and the Privacy notice`)
  const legal = parse(await response.json().catch(() => undefined))
  if (!legal) throw new Error("Lunos Cloud's answer for the Terms and the Privacy notice isn't one Lunos can read")
  const where = cacheFile()
  await fs.mkdir(path.dirname(where), { recursive: true })
  await fs.writeFile(where, JSON.stringify(legal))
  return legal
}

/**
 * The current Terms and Privacy notice: Lunos Cloud's answer, else the last one kept here. With
 * `network: false`, or offline (LUNOS_OFFLINE), only the kept one: nothing is sent.
 */
export async function current(input: { network: boolean } & Options): Promise<Legal | undefined> {
  if (!input.network || Offline.enabled()) return cached()
  return fetchLegal(input).catch(() => cached())
}
