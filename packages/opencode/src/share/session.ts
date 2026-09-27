import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { Effect, Layer, Scope, Context, Schema } from "effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ShareNext } from "./share-next"
import { ConfigPolicy } from "@/config/policy"

export const DISABLED_MESSAGE =
  'Session sharing is disabled. To share without uploading anything, use /export to save the transcript as a file. To enable /share, set "share": "manual" in your Lunos config.'

export class ShareDisabledError extends Schema.TaggedErrorClass<ShareDisabledError>()("ShareDisabledError", {
  /** Set when an organisation policy locks `share` (XCOD-102): config can't turn it on. */
  locked: Schema.optional(Schema.Boolean),
}) {
  override get message() {
    return this.locked ? ConfigPolicy.message("share") : DISABLED_MESSAGE
  }
}

export interface Interface {
  readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
  readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, ShareDisabledError | unknown>
  readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const session = yield* Session.Service
    const shareNext = yield* ShareNext.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service

    const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
      const conf = yield* cfg.get()
      if (conf.share === "disabled") {
        const locked = ConfigPolicy.isLocked(conf.$locked, "share")
        // `/share`, `lunos run --share` and API clients all arrive here.
        if (locked) yield* ConfigPolicy.refused("share", "share request")
        return yield* new ShareDisabledError({ locked })
      }
      const result = yield* shareNext.create(sessionID)
      yield* session.setShare({ sessionID, share: { url: result.url } })
      return result
    })

    const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
      yield* shareNext.remove(sessionID)
      yield* session.setShare({ sessionID, share: undefined })
    })

    const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
      const result = yield* session.create(input)
      if (result.parentID) return result
      const conf = yield* cfg.get()
      // "disabled" wins over OPENCODE_AUTO_SHARE: the env flag only upgrades manual to auto.
      if (conf.share === "disabled") return result
      // A locked `share` can't be upgraded to "auto" by the env flag either (XCOD-102).
      if (flags.autoShare && conf.share !== "auto" && ConfigPolicy.isLocked(conf.$locked, "share")) {
        yield* ConfigPolicy.refused("share", "OPENCODE_AUTO_SHARE")
        return result
      }
      if (!(flags.autoShare || conf.share === "auto")) return result
      yield* share(result.id).pipe(Effect.ignore, Effect.forkIn(scope))
      return result
    })

    return Service.of({ create, share, unshare })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Session.node, ShareNext.node, RuntimeFlags.node],
})

export * as SessionShare from "./session"
