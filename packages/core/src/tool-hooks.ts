export * as ToolHooks from "./tool-hooks"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Scope } from "effect"
import { State } from "./state"

/**
 * Tool execution hooks for v2 plugins (XCOD-75): `ctx.tool["execute.before"]` and
 * `ctx.tool["execute.after"]`.
 *
 * Semantics match the v1 `tool.execute.*` dispatch, which is what live sessions run:
 * hooks run sequentially in registration order, each observes mutations made by earlier
 * ones, and a hook that fails aborts the tool call. That last property is what makes
 * guard hooks possible. Live sessions reach these hooks through the v1 `Plugin.trigger`
 * bridge (`packages/opencode/src/plugin/index.ts`), not through a v2 session runner.
 */

export interface BeforeEvent {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  args: any
}

export interface AfterEvent {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  readonly args: any
  output: { title: string; output: string; metadata: any }
}

type Callback<Event> = (event: Event) => Effect.Effect<void, unknown> | void

export interface Interface {
  readonly hook: {
    readonly before: (callback: Callback<BeforeEvent>) => Effect.Effect<State.Registration, never, Scope.Scope>
    readonly after: (callback: Callback<AfterEvent>) => Effect.Effect<State.Registration, never, Scope.Scope>
  }
  readonly runBefore: (event: BeforeEvent) => Effect.Effect<BeforeEvent, unknown>
  readonly runAfter: (event: AfterEvent) => Effect.Effect<AfterEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolHooks") {}

export const locationLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    let before: Callback<BeforeEvent>[] = []
    let after: Callback<AfterEvent>[] = []

    const register = <Event>(get: () => Callback<Event>[], set: (next: Callback<Event>[]) => void) =>
      Effect.fn("ToolHooks.hook")(function* (callback: Callback<Event>) {
        const scope = yield* Scope.Scope
        let active = true
        set([...get(), callback])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          set(get().filter((item) => item !== callback))
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      })

    const run = <Event>(hooks: readonly Callback<Event>[], event: Event): Effect.Effect<Event, unknown> =>
      Effect.gen(function* () {
        for (const hook of hooks) {
          // A hook that throws synchronously fails the run just like one that fails its Effect.
          const result = yield* Effect.try({ try: () => hook(event), catch: (error) => error })
          if (Effect.isEffect(result)) yield* result
        }
        return event
      })

    return Service.of({
      hook: {
        before: register(
          () => before,
          (next) => (before = next),
        ),
        after: register(
          () => after,
          (next) => (after = next),
        ),
      },
      runBefore: (event) => run(before, event),
      runAfter: (event) => run(after, event),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer: locationLayer, deps: [] })
