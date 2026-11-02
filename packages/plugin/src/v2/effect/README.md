# Lunos v2 Effect Plugin API

The Effect plugin API grants plugins two in-process capabilities:

- `hook` installs behavior at a Lunos extension point.
- `reload` reruns every transform hook for a stateful domain.

The public server client will be exposed separately. It is intentionally not part of `PluginContext` yet.

## Defining A Plugin

Everything named below (`define`, `PluginContext`, `Plugin`, `Registration`, `Reload`, every `*Draft` and `*Hooks` type) is exported from the package root, so nothing needs a deep import.

```ts
import { define } from "@opencode-ai/plugin/v2/effect"
import { Effect } from "effect"

export const Plugin = define({
  id: "example",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  }),
})
```

**The setup key is `effect`, not `setup`.** This is deliberate: the key names what you pass. An Effect plugin passes an Effect-returning function under `effect`. A [Promise plugin](../promise/README.md) passes an async function under `setup`. Using the wrong key is a type error at `define(...)`.

Plugin setup registers hooks imperatively. It does not return a hook object.

Configuration supplied for the plugin is available as `ctx.options`.

Registrations are owned by the plugin scope. Closing the scope removes them automatically; a registration may also be removed early through `dispose`.

## Transform Hooks

Transform hooks contribute to stateful domains:

```ts
yield *
  ctx.agent.transform((agent) => {
    agent.update("reviewer", (item) => {
      item.description = "Reviews code for regressions"
      item.mode = "subagent"
    })
  })
```

Lunos rebuilds the domain when a transform is registered or disposed. A rebuild starts from fresh domain state and runs every active transform in registration order.

Available transform hooks are namespaced by domain:

```ts
ctx.agent.transform
ctx.catalog.transform
ctx.command.transform
ctx.integration.transform
ctx.reference.transform
ctx.skill.transform
```

## Runtime Hooks

> **Where these hooks run today.** Lunos sessions still resolve models through the v1 provider (`packages/opencode/src/provider/provider.ts`), not through v2's `AISDK.language()`. v2 `aisdk` runtime hooks therefore don't run for live sessions yet. Prove a hook fires in a real `lunos run` before relying on it; see XCOD-93. `tool` hooks (below) do run in live sessions, through a bridge from the v1 tool dispatch.

Runtime hooks intercept live operations rather than rebuilding domain state:

```ts
yield *
  ctx.aisdk.sdk(
    Effect.fn(function* (event) {
      if (event.package !== "@ai-sdk/xai") return
      const mod = yield* Effect.promise(() => import("@ai-sdk/xai"))
      event.sdk = mod.createXai(event.options)
    }),
  )

yield *
  ctx.aisdk.language((event) => {
    if (event.model.providerID !== "xai") return
    event.language = event.sdk.responses(event.model.api.id)
  })
```

Hooks run sequentially in registration order. Later hooks observe mutations made by earlier hooks.

## Tool Hooks

`ctx.tool` runs hooks around every tool call the agent makes. As with `aisdk`, the keys are the event names:

```ts
yield *
  ctx.tool["execute.before"]((event) => {
    // event: { tool, sessionID, callID, args } — args is mutable
    if (event.tool === "bash" && event.args.command.includes("rm -rf")) {
      return Effect.fail(new Error("blocked: destructive command"))
    }
  })

yield *
  ctx.tool["execute.after"]((event) => {
    // event: { tool, sessionID, callID, args, output: { title, output, metadata } } — output is mutable
  })
```

- Hooks run sequentially in registration order, and each one sees the mutations of earlier ones.
- **A failing `execute.before` hook aborts the tool call.** The model sees the error, and the run continues. This is the same behaviour as a rejecting v1 `tool.execute.before` hook, and it is how guard hooks work. Unlike other domains, these callbacks may fail.
- **Live sessions run these hooks.** Tool calls are still dispatched by the v1 plugin trigger, which runs v1 hooks first (including config `hooks`) and then v2 `ctx.tool` hooks, on the same event. The first tool call of a run waits until every external v2 plugin has loaded, so a guard can't miss it.
- The key is `ctx.tool["execute.before"](...)`, not `ctx.tool.hook("execute.before", ...)` as the retired PLAN.md sketched. The shape follows the other domains.

## Reloading A Domain

When data captured by a transform changes, reload the affected domain:

```ts
let data = yield * loadCatalog()

yield *
  ctx.catalog.transform((catalog) => {
    applyCatalog(data, catalog)
  })

data = yield * loadCatalog()
yield * ctx.catalog.reload()
```

Reload belongs to the domain, not an individual registration. `ctx.catalog.reload()` reruns every active catalog transform and publishes the rebuilt catalog.

Available reload operations are:

```ts
ctx.agent.reload()
ctx.catalog.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.reference.reload()
ctx.skill.reload()
```
