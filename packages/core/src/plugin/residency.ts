export * as ResidencyPlugin from "./residency"

import path from "path"
import { appendFile, mkdir } from "fs/promises"
import { Effect } from "effect"
import { define } from "./internal"
import { Config } from "../config"
import { Global } from "../global"
import { Residency } from "../residency"

/**
 * Enforces the data-residency policy and writes the egress audit log (XCOD-62).
 *
 * Enforcement rides the `aisdk.sdk` hook rather than living in the AISDK layer itself, because
 * `plugin/internal.ts` already provides `Config.Service` to plugins while the AISDK layer is
 * built with `deps: []`. The hook runs inside `AISDK.language()`, wrapped by `initError(...)`,
 * which is `Effect.catchCause` — so throwing here surfaces as an `InitError` and no language
 * model is ever produced. That makes this request-time enforcement: there is no other path to a
 * language model that skips it.
 *
 * The SDK cache in `AISDK` does not weaken that. `sdks.get(sdkKey)` can only hit after a
 * resolution that *succeeded*, which cannot happen for a denied provider.
 */

function resolvePolicy(files: readonly Config.Document[]):
  | {
      policy: Residency.Policy
      audit: boolean
      auditPath: string | undefined
    }
  | undefined {
  // Last configured wins, matching how the rest of config layering resolves.
  let found: { policy: Residency.Policy; audit: boolean; auditPath: string | undefined } | undefined
  for (const file of files) {
    const residency = file.info.residency
    if (!residency) continue
    found = {
      policy: { allow: residency.allow },
      // Audit is on by default once a policy exists — the ticket's "on by default when a
      // residency policy is configured", so enabling residency does not silently skip the
      // record of what actually left.
      audit: residency.audit ?? true,
      auditPath: residency.auditPath,
    }
  }
  return found
}

async function append(file: string, text: string) {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, text, "utf8")
  } catch (err) {
    // A failing audit sink must not take down the user's session. It is reported rather than
    // swallowed, so a persistently unwritable log is visible instead of quietly producing an
    // empty audit trail.
    console.error(`[residency] failed to write audit log at ${file}:`, err)
  }
}

export const Plugin = define({
  id: "residency",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service

    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        const resolved = resolvePolicy(files)

        // No policy configured: a complete no-op. No enforcement, no logging, no wrapped fetch,
        // so deployments that do not use this pay nothing per request.
        if (!resolved) return

        const providerID = evt.model.providerID
        const decision = Residency.evaluate(providerID, resolved.policy)

        if (!decision.allowed) {
          if (resolved.audit) {
            // Record the refusal too. An audit trail that only lists successful calls cannot
            // answer "did anything try to leave the region?", which is the question an auditor
            // actually asks.
            const file = resolved.auditPath ?? defaultAuditPath()
            void append(file, Residency.line(Residency.record(providerID, urlOf(evt.options), false)))
          }
          throw new Residency.DeniedError(decision)
        }

        if (!resolved.audit) return

        const file = resolved.auditPath ?? defaultAuditPath()
        const inner = evt.options.fetch
        // Wrap whatever fetch is already installed — `prepareOptions` puts its own wrapper here
        // first, so this composes on top rather than replacing it. Same pattern that file uses.
        evt.options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
          void append(file, Residency.line(Residency.record(providerID, url, true)))
          return (typeof inner === "function" ? inner : fetch)(input, init)
        }
      }),
    )
  }),
})

function defaultAuditPath() {
  return path.join(Global.Path.log, "residency-egress.log")
}

function urlOf(options: Record<string, any>): string {
  return typeof options?.baseURL === "string" ? options.baseURL : ""
}
