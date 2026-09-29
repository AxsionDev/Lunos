export * as ProviderConfigured from "./configured"

import { Schema } from "effect"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"

/**
 * The configured-providers list behind the TUI's /providers dialog (XCOD-130). It mirrors
 * `lunos providers list`: every stored credential plus every provider that loaded from the
 * environment or config, with how it authenticates, whether it works, and where it processes
 * data. It never carries a secret: only the credential's type crosses the wire.
 */

export const Method = Schema.Literals(["api", "oauth", "wellknown", "env", "config", "custom"])
export type Method = Schema.Schema.Type<typeof Method>

/**
 * - `connected`: the provider loaded and can serve models.
 * - `expired`: an OAuth credential whose access token has expired and that has no refresh token
 *   to renew it. An expired access token *with* a refresh token is still `connected`: it is
 *   renewed on the next request, and is routinely past its expiry between uses.
 * - `error`: a credential is stored but the provider did not load (unknown provider id, disabled
 *   in config, or its plugin failed), so the credential is not being used.
 */
export const Status = Schema.Literals(["connected", "expired", "error"])
export type Status = Schema.Schema.Type<typeof Status>

export const Item = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  method: Method,
  status: Status,
  /** A credential is stored in auth.json, so logging out can remove it. */
  stored: Schema.Boolean,
  jurisdiction: Schema.Struct({
    region: Schema.Literals(["eu", "us", "other", "configurable", "unknown"]),
    basis: Schema.String,
  }),
}).annotate({ identifier: "ConfiguredProvider" })
export type Item = Schema.Schema.Type<typeof Item>

export const List = Schema.Array(Item)

type Credential = { type: "api" | "oauth" | "wellknown"; refresh?: string; expires?: number }
type Loaded = { name: string; source: "env" | "config" | "custom" | "api"; options: Record<string, unknown> }

export function status(credential: Credential | undefined, loaded: boolean, now: number): Status {
  if (credential?.type === "oauth" && !credential.refresh && (credential.expires ?? 0) < now) return "expired"
  if (credential && !loaded) return "error"
  return "connected"
}

export function list(input: {
  credentials: Record<string, Credential>
  loaded: Record<string, Loaded>
  names: Record<string, string>
  declared?: Readonly<Record<string, Jurisdiction.Declaration>>
  now?: number
}): Item[] {
  const now = input.now ?? Date.now()
  const ids = [...new Set([...Object.keys(input.credentials), ...Object.keys(input.loaded)])]
  return ids
    .map((id) => {
      const credential = input.credentials[id]
      const loaded = input.loaded[id]
      const baseURL = typeof loaded?.options?.baseURL === "string" ? loaded.options.baseURL : undefined
      const { claim } = Jurisdiction.resolve(id, baseURL, input.declared)
      return {
        id,
        name: loaded?.name ?? input.names[id] ?? id,
        method: credential?.type ?? loaded?.source ?? "custom",
        status: status(credential, loaded !== undefined, now),
        stored: credential !== undefined,
        jurisdiction: { region: claim.region, basis: claim.basis },
      } satisfies Item
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}
