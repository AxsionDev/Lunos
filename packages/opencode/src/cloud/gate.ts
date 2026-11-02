export * as CloudGate from "./gate"

import { Offline } from "@opencode-ai/core/offline"
import type { Exemption, Gate } from "@opencode-ai/tui/util/account"
import { ConfigManaged } from "@/config/managed"
import { ConfigPolicy } from "@/config/policy"
import { SandboxConfig } from "@/sandbox/config"
import { CloudDefaults } from "./defaults"

declare global {
  /** XCOD-273: set by the release pipeline's build (publish.yml); absent in a build from source. */
  const LUNOS_OFFICIAL_BUILD: boolean | undefined
}

/**
 * XCOD-273: whether this start needs a Lunos account. The official distribution (npm `lunos-ai`, the
 * installers) is built with LUNOS_OFFICIAL_BUILD; a build from source isn't, and starts as before.
 * `LUNOS_AUTH_REQUIRED=1` turns the requirement on in a build from source (to try it, and in tests);
 * nothing at run time turns it off in the official build except the exemptions below, which are
 * documented (docs: "Using Lunos without an account").
 */
export const REQUIRED_ENV = "LUNOS_AUTH_REQUIRED"

export function official() {
  return typeof LUNOS_OFFICIAL_BUILD === "boolean" && LUNOS_OFFICIAL_BUILD
}

const trimmed = (url: string) => url.replace(/\/+$/, "")

function last(docs: readonly unknown[], key: string) {
  return docs.map((doc) => ConfigPolicy.get(doc, key)).findLast((value) => value !== undefined)
}

export type Input = {
  /** Managed config on this machine (system directory, MDM profile), never fetched. */
  managed: readonly unknown[]
  /** The user's global config. A project's config is never read: a repository can't steer sign-in. */
  global: unknown
  env?: NodeJS.ProcessEnv
  tty?: { stdin: boolean; stdout: boolean }
  official?: boolean
}

/**
 * The issuer the TUI signs in to: managed config's, else the user's global config's, else Lunos's
 * own. Never a project's, so a cloned repository can't send a first-start sign-in elsewhere.
 */
export function issuer(input: Pick<Input, "managed" | "global">) {
  const value = last(input.managed, "cloud.issuer") ?? ConfigPolicy.get(input.global, "cloud.issuer")
  return typeof value === "string" && value ? value : CloudDefaults.DEFAULT_ISSUER
}

export function clientID(input: Pick<Input, "managed" | "global">) {
  const value = last(input.managed, "cloud.client_id") ?? ConfigPolicy.get(input.global, "cloud.client_id")
  return typeof value === "string" && value ? value : "lunos-cli"
}

/**
 * Whether the Welcome screen must be passed before a session, or which exemption skips it. Pure: no
 * network, no keychain. Managed `auth.required: true` turns it on in any build; the exemptions after
 * it hold either way, so self-hosted, offline and CI use never needs a Lunos account.
 */
export function resolve(input: Input): Gate {
  const env = input.env ?? process.env
  const flag = (key: string) => ["1", "true"].includes(env[key]?.toLowerCase() ?? "")
  const managedIssuer = last(input.managed, "cloud.issuer")
  const managedRequired = last(input.managed, "auth.required")
  const own = issuer(input)
  const exempt = (exemption: Exemption): Gate => ({ required: false, exemption, issuer: own })
  if (managedRequired === false) return exempt("managed")
  if (
    typeof managedIssuer === "string" &&
    managedIssuer &&
    trimmed(managedIssuer) !== trimmed(CloudDefaults.DEFAULT_ISSUER)
  )
    return exempt("org-issuer")
  if (managedRequired !== true && !(input.official ?? official()) && !flag(REQUIRED_ENV)) return exempt("source-build")
  if (flag(Offline.ENV)) return exempt("offline")
  if (flag("CI")) return exempt("ci")
  const tty = input.tty ?? { stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY) }
  if (!tty.stdin || !tty.stdout) return exempt("headless")
  return { required: true, issuer: own }
}

/** The gate for this machine, from on-disk managed config and the user's global config. */
export async function current(tty?: Input["tty"]) {
  const managed = await ConfigManaged.readOnDiskDocs().catch(() => [] as unknown[])
  const global = SandboxConfig.globalDoc()
  return {
    gate: resolve({ managed, global, tty }),
    issuer: issuer({ managed, global }),
    clientID: clientID({ managed, global }),
  }
}
