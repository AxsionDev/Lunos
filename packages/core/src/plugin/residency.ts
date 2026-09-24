export * as ResidencyPlugin from "./residency"

import path from "path"
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

export const Plugin = define({
  id: "residency",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service

    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        // Last configured wins, matching how the rest of config layering resolves.
        const block = files.findLast((file) => file.info.residency)?.info.residency
        const resolved = Residency.resolve(block)
        // No policy configured: a complete no-op, so deployments that do not use this pay nothing.
        if (!resolved) return
        evt.options.fetch = Residency.enforce({
          providerID: evt.model.providerID,
          baseURL: urlOf(evt.options),
          resolved,
          defaultAuditPath: defaultAuditPath(),
          fetch: evt.options.fetch,
        })
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
