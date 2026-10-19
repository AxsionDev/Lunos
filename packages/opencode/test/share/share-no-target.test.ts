// XCOD-266: upstream shut its share service down in v1.19.3. With no organisation console and no
// enterprise.url, sharing ("manual" or "auto") must not send anything anywhere, and must say why.
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { SessionShareTable } from "@opencode-ai/core/share/sql"
import { eq } from "drizzle-orm"
import { AccountRepo } from "../../src/account/repo"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { TuiEvent } from "../../src/server/tui-event"
import { Session } from "@/session/session"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { provideTmpdirInstance } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node])))

const json = (req: Parameters<typeof HttpClientResponse.fromWeb>[0], body: unknown) =>
  HttpClientResponse.fromWeb(
    req,
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  )

/** Every request ShareNext's HTTP client is asked to make, answered as a share server would. */
function spyClient() {
  const seen: HttpClientRequest.HttpClientRequest[] = []
  const client = HttpClient.make((req) => {
    seen.push(req)
    return Effect.succeed(json(req, { id: "shr_abc", url: "https://share.example.com/share/abc", secret: "sec" }))
  })
  return { seen, client }
}

function layer(client: HttpClient.HttpClient) {
  const replacement = [httpClient, Layer.succeed(HttpClient.HttpClient, client)] as const
  return LayerNode.compile(
    LayerNode.group([
      SessionShare.node,
      ShareNext.node,
      EventV2Bridge.node,
      Session.node,
      SessionProjector.node,
      AccountRepo.node,
      Database.node,
      RuntimeFlags.node,
    ]),
    [replacement],
  )
}

// The same thing seen from the outside: no share request may reach the network through fetch either.
// (Unrelated background fetches, such as the models.dev catalogue, are not this test's concern.)
const fetched: string[] = []
const shareFetches = () => fetched.filter((url) => /opncd\.ai|\/api\/shares?(\/|$)/.test(url))
const realFetch = globalThis.fetch
beforeEach(async () => {
  await resetDatabase()
  fetched.length = 0
  globalThis.fetch = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      fetched.push(input instanceof Request ? input.url : String(input))
      return realFetch(input, init)
    },
    { preconnect: realFetch.preconnect },
  ) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const toasts = Effect.gen(function* () {
  const seen: string[] = []
  const events = yield* EventV2Bridge.Service
  yield* events.listen((event) =>
    Effect.sync(() => {
      if (event.type === TuiEvent.ToastShow.type) seen.push((event.data as { message: string }).message)
    }),
  )
  return seen
})

const NO_TARGET = "Sharing needs a Lunos organisation (lunos login) or enterprise.url in config."

describe("sharing with nowhere to share to (XCOD-266)", () => {
  it.live("share is on (the precondition the other tests rely on)", () =>
    Effect.sync(() => {
      // `disabled` is read once at import: set, every test here would pass without proving anything.
      expect(process.env["OPENCODE_DISABLE_SHARE"]).toBeUndefined()
      expect(process.env["LUNOS_OFFLINE"]).toBeUndefined()
    }),
  )

  it.live("manual: /share refuses with the message and sends nothing", () =>
    provideTmpdirInstance(
      () => {
        const { seen, client } = spyClient()
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "manual" })
          const exit = yield* Effect.exit((yield* SessionShare.Service).share(session.id))

          expect(Exit.isFailure(exit)).toBe(true)
          const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          expect(ShareNext.isNoTarget(error)).toBe(true)
          expect((error as Error).message).toBe(NO_TARGET)
          expect(seen).toEqual([])
          expect(shareFetches()).toEqual([])
        }).pipe(Effect.provide(layer(client)))
      },
      { config: { share: "manual" } },
    ),
  )

  it.live("auto: new sessions upload nothing, and the message is shown once per project", () =>
    provideTmpdirInstance(
      () => {
        const { seen, client } = spyClient()
        return Effect.gen(function* () {
          const shown = yield* toasts
          const share = yield* SessionShare.Service

          yield* share.create({ title: "first" })
          yield* share.create({ title: "second" })
          yield* share.create({ title: "third" })
          // The auto share runs in the background; give all three time to finish.
          yield* Effect.sleep(300)

          expect(shown).toEqual([NO_TARGET])
          expect(seen).toEqual([])
          expect(shareFetches()).toEqual([])
        }).pipe(Effect.provide(layer(client)))
      },
      { config: { share: "auto" } },
    ),
  )

  it.live("unshare of a share made before the change forgets it locally and sends nothing", () =>
    provideTmpdirInstance(
      () => {
        const { seen, client } = spyClient()
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "old share" })
          const { db } = yield* Database.Service
          yield* db
            .insert(SessionShareTable)
            .values({ session_id: session.id, id: "shr_old", url: "https://old.example/s/old", secret: "sec" })
            .run()
            .pipe(Effect.orDie)

          yield* (yield* SessionShare.Service).unshare(session.id)

          const row = yield* db
            .select()
            .from(SessionShareTable)
            .where(eq(SessionShareTable.session_id, session.id))
            .get()
            .pipe(Effect.orDie)
          expect(row).toBeUndefined()
          expect(seen).toEqual([])
          expect(shareFetches()).toEqual([])
        }).pipe(Effect.provide(layer(client)))
      },
      { config: { share: "manual" } },
    ),
  )

  // Positive control: the same spy does see a share when there is somewhere to share to.
  it.live("with enterprise.url, manual share uploads there", () =>
    provideTmpdirInstance(
      () => {
        const { seen, client } = spyClient()
        return Effect.gen(function* () {
          const session = yield* (yield* Session.Service).create({ title: "enterprise" })
          const result = yield* (yield* SessionShare.Service).share(session.id)

          expect(result.url).toBe("https://share.example.com/share/abc")
          expect(seen[0]?.method).toBe("POST")
          expect(seen[0]?.url).toBe("https://share.example.com/api/share")
        }).pipe(Effect.provide(layer(client)))
      },
      { config: { share: "manual", enterprise: { url: "https://share.example.com" } } },
    ),
  )
})
