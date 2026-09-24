# Lunos v2 Promise Plugin API

The Promise plugin API is the async/await equivalent of `@opencode-ai/plugin/v2/effect`. It grants plugins the same two in-process capabilities:

- `hook` installs behavior at a Lunos extension point.
- `reload` reruns every transform hook for a stateful domain.

The only difference from the Effect API is the async boundary: hook callbacks, hook registration, `reload`, and `Registration.dispose` use Promises instead of Effects.

## Defining A Plugin

Everything named below (`define`, `PluginContext`, `Plugin`, `Registration`, `Reload`, every `*Draft` and `*Hooks` type) is exported from the package root, so nothing needs a deep import.

```ts
import { define } from "@opencode-ai/plugin/v2/promise"

export const Plugin = define({
  id: "example",
  setup: async (ctx) => {
    await ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  },
})
```

**The setup key is `setup`, not `effect`.** This is deliberate: the key names what you pass. A Promise plugin passes an async function under `setup`. An [Effect plugin](../effect/README.md) passes an Effect-returning function under `effect`. Using the wrong key is a type error at `define(...)`.

Plugin setup registers hooks imperatively. It does not return a hook object.

Configuration supplied for the plugin is available as `ctx.options`.

A registration may be removed early through `dispose`:

```ts
const registration = await ctx.catalog.transform(applyCatalog)
await registration.dispose()
```

## Transform Hooks

Transform hooks contribute to stateful domains. The draft editor is synchronous; the callback may be `async` when it needs to await other work:

```ts
await ctx.agent.transform((agent) => {
  agent.update("reviewer", (item) => {
    item.description = "Reviews code for regressions"
    item.mode = "subagent"
  })
})
```

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

> **Where these hooks run today.** Lunos sessions still resolve models through the v1 provider (`packages/opencode/src/provider/provider.ts`), not through v2's `AISDK.language()`. v2 `aisdk` runtime hooks therefore don't run for live sessions yet. Prove a hook fires in a real `lunos run` before relying on it; see XCOD-93. There is also no `tool` domain yet (XCOD-75).

Runtime hooks intercept live operations:

```ts
await ctx.aisdk.sdk(async (event) => {
  if (event.package !== "@ai-sdk/xai") return
  const mod = await import("@ai-sdk/xai")
  event.sdk = mod.createXai(event.options)
})

await ctx.aisdk.language((event) => {
  if (event.model.providerID !== "xai") return
  event.language = event.sdk.responses(event.model.api.id)
})
```

## Reloading A Domain

When data captured by a transform changes, reload the affected domain:

```ts
let data = await loadCatalog()

await ctx.catalog.transform((catalog) => {
  applyCatalog(data, catalog)
})

data = await loadCatalog()
await ctx.catalog.reload()
```

Available reload operations are:

```ts
ctx.agent.reload()
ctx.catalog.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.reference.reload()
ctx.skill.reload()
```
