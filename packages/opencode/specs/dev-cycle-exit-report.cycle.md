---
phase: verify
gate: approved
---

<!-- Verbatim copy of .opencode/dev-cycle/1790314820817-crisp-canyon.md from the XCOD-86 run (session ses_f28ebcb2fffeP3wkQxM5ti2Xz1), final state after gate 3. Only local paths are normalised to <worktree> and <tmp>. See dev-cycle-exit-report.md. -->

# XCOD-96 Dev Cycle

## Discover

### Request

Fix XCOD-96: v1 server plugin loading must not emit `level=ERROR` for valid v2 plugin files discovered from `.opencode/plugin/` or `.opencode/plugins/`. Genuine v1 plugin failures must still log at ERROR. Regression coverage must exercise the real loader path, not only `readV1Plugin` directly.

### Reproduction

Created a temporary git repo at `<tmp>/xcod-96-repro` with `.opencode/plugin/hello-v2.ts`:

```ts
export default { id: "hello-v2", setup: async () => {} }
```

Ran from that repo:

```sh
bun <worktree>/packages/opencode/src/index.ts debug agent build --print-logs --log-level INFO
```

Observed current failure:

```text
level=ERROR message="failed to load plugin" path=file:///.../.opencode/plugin/hello-v2.ts error="Plugin export is not a function"
```

This proves the previous partial change to `readV1Plugin(..., "detect")` is insufficient because the real `applyPlugin` path falls through to legacy export loading.

### Code Path Evidence

- `packages/opencode/src/config/plugin.ts:21-28` discovers `{plugin,plugins}/*.{ts,js}` and returns file URLs for v1 plugin config.
- `packages/core/src/config/plugin/external.ts:15-30` defines the v2 valid default shapes as `{ id, effect }` or `{ id, setup }`.
- `packages/core/src/config/plugin/external.ts:61-73` scans the same `{plugin,plugins}/*.{ts,js}` directory glob for v2 plugin loading.
- `packages/opencode/src/plugin/index.ts:223-255` loads configured v1 server plugins through `PluginLoader.loadExternal`.
- `packages/opencode/src/plugin/index.ts:123-134` applies a loaded module: it calls `readV1Plugin(..., "detect")`; if that returns a plugin it runs `server()`, otherwise it falls through to `getLegacyPlugins(load.mod)`.
- `packages/opencode/src/plugin/index.ts:108-120` `getLegacyPlugins` inspects every module export and throws `Plugin export is not a function` when a default object is not a v1 server plugin function.
- `packages/opencode/src/plugin/index.ts:261-278` catches `applyPlugin` errors and logs `Effect.logError("failed to load plugin", ...)`, producing the observed ERROR.

### Test Evidence

- `packages/opencode/test/plugin/loader-shared.test.ts` already exercises `Plugin.Service` through a real plugin loading path using temp directories and `load(tmp.path)`.
- The current added tests only call `readV1Plugin` directly, so they miss the `applyPlugin -> getLegacyPlugins` fallthrough.
- The regression should create a `.opencode/plugin/hello-v2.ts` v2-shaped file and initialize/list the plugin service through the same shared-loader harness, asserting no ERROR log and no thrown loader-path failure.

### Explore Agent Findings

- Test explorer confirmed `applyPlugin` is private and reached through `Plugin.Service.list()` in `packages/opencode/test/plugin/loader-shared.test.ts:47-48`.
- Test explorer confirmed logger capture examples exist in config tests, but the smallest high-value test can use the real loader harness and marker/log assertions.
- Test explorer recommended `packages/opencode/test/plugin/loader-shared.test.ts` as the smallest regression location because it already drives `Plugin.Service -> PluginLoader.loadExternal -> applyPlugin -> getLegacyPlugins`.

## Architect

### Preferred Approach

Add explicit v2-module recognition in the v1 server plugin application path after v1 object detection and before legacy export fallback, but do not skip silently. Return a structured skip result from `applyPlugin`, then log that skip at DEBUG in the existing Effect pipeline.

Implementation shape:

- Keep the existing v2-shape predicate in `packages/opencode/src/plugin/shared.ts`, but export a module-level helper such as `isV2PluginModule(mod: Record<string, unknown>)`.
- In `packages/opencode/src/plugin/index.ts`, import that helper and change `applyPlugin` from returning `Promise<void>` to returning an internal result:

```ts
type ApplyPluginResult =
  | { readonly type: "loaded" }
  | { readonly type: "skipped-v2"; readonly spec: string; readonly path: string }
```

- Update `applyPlugin` so v1 plugin and legacy plugin success return `{ type: "loaded" }`, while valid v2 modules return `{ type: "skipped-v2", spec: load.spec, path: load.entry }` before `getLegacyPlugins(load.mod)`:

```ts
const plugin = readV1Plugin(load.mod, load.spec, "server", "detect")
if (plugin) {
  await resolvePluginId(load.source, load.spec, load.target, readPluginId(plugin.id, load.spec), load.pkg)
  hooks.push(await (plugin as PluginModule).server(input, load.options))
  return { type: "loaded" }
}

if (isV2PluginModule(load.mod)) {
  return { type: "skipped-v2", spec: load.spec, path: load.entry }
}

for (const server of getLegacyPlugins(load.mod)) {
  hooks.push(await server(input, load.options))
}

return { type: "loaded" }
```

- Add DEBUG logging immediately after the existing `Effect.tryPromise({ try: () => applyPlugin(...) })` succeeds:

```ts
Effect.tap((result) =>
  result.type === "skipped-v2"
    ? Effect.logDebug("skipping v2 plugin module in v1 loader", {
        spec: result.spec,
        path: result.path,
      })
    : Effect.void,
)
```

This keeps logging in the Effect pipeline rather than introducing an Effect runtime/logger dependency into `applyPlugin`, which is currently plain async code.

### Interfaces

- `packages/opencode/src/plugin/shared.ts`: export `isV2PluginModule(mod: Record<string, unknown>): boolean`.
- The helper should return true only for `mod.default` objects with `id: string`, no `server`, no `tui`, and either `setup` or `effect` as a function.
- Keep malformed id-only defaults as non-v2 so they still fail as genuine v1/legacy plugin errors.
- `packages/opencode/src/plugin/index.ts`: introduce an internal-only `ApplyPluginResult` type. No public API, Protocol, SDK, or generated client changes are needed.
- DEBUG log message must be `skipping v2 plugin module in v1 loader`, with at least `spec` and `path` fields so users can correlate the ignored file with its resolved entrypoint.

### Rejected Alternatives

- Filter during config discovery: rejected because `packages/opencode/src/config/plugin.ts:21-28` only scans paths and should not import plugin modules during config loading.
- Change `readV1Plugin` to return a sentinel: rejected because it broadens an existing API also used by TUI runtime.
- Make `getLegacyPlugins` ignore non-function exports: rejected because it would hide genuine invalid v1/legacy plugin failures that must remain ERROR.
- Downgrade all `applyPlugin` failures to DEBUG: rejected because genuine v1 plugin failures must still log at ERROR.
- Call `Effect.logDebug` directly inside `applyPlugin`: rejected because `applyPlugin` is plain async Promise code; logging belongs in the surrounding Effect pipeline.
- Pass a logger callback into `applyPlugin`: rejected because returning a structured result is smaller and avoids adding a one-off logging dependency to plugin application.
- Silent v2 skip: rejected by the revised requirement; users need a DEBUG breadcrumb explaining why the v1 loader ignored the file.

### Regression Strategy

- Replace the direct `readV1Plugin`-only tests with a loader-path test in `packages/opencode/test/plugin/loader-shared.test.ts`.
- Test should create a v2-shaped default export and drive `yield* load(tmp.path)`, which reaches private `applyPlugin` through `Plugin.Service.list()`.
- Assert the v2-shaped module emits DEBUG-captured `skipping v2 plugin module in v1 loader` with the file spec/path, and still does not log `failed to load plugin` or `Plugin export is not a function`.
- Add or keep a genuine invalid-v1 guard to prove malformed v1-looking defaults still produce a failure through the loader path.
- Capture the full logger options object if needed, not just `options.message`, so the test can assert structured `spec` and `path` fields.

### Risks

- Do not weaken dynamic import error behavior; import failures are still real failures before shape detection.
- Do not skip hybrid objects with `server` or `tui`; those should continue through v1 validation.
- Existing uncommitted partial tests are inadequate and should be replaced or supplemented by loader-path tests.
- Preserve sequential plugin loading; the existing loop intentionally applies plugins sequentially for deterministic hook order.
- Do not emit user-facing plugin error events for valid v2 skips; valid v2 modules are not v1 load failures.

### Rewind Note

The sections below this architecture (`Plan`, `Build`, and `Verify`) are from the previous silent-skip pass and must be revised after Gate 1 is approved for the DEBUG-logging architecture.

## Plan

### Rewind Note

This plan supersedes the previous silent-skip plan. The current implementation already contains the earlier `isV2PluginModule` predicate and silent early return; the new work is to make that skip observable at DEBUG while preserving the no-ERROR behavior for valid v2 modules.

### Step 1: Export v2 Module Predicate

- Keep the existing `packages/opencode/src/plugin/shared.ts` export `isV2PluginModule(mod: Record<string, unknown>)`.
- Keep the predicate semantics unchanged: valid v2 means `id: string`, no `server`, no `tui`, and function `setup` or `effect`.
- Keep `readV1Plugin(..., "detect")` using `isV2PluginModule(mod)` so direct v1 detection still treats v2 defaults as not-v1.

### Step 2: Return Structured Apply Results

- Modify `packages/opencode/src/plugin/index.ts`.
- Add an internal `ApplyPluginResult` type:

```ts
type ApplyPluginResult =
  | { readonly _tag: "Loaded" }
  | { readonly _tag: "SkippedV2"; readonly spec: string; readonly path: string }
```

- Change `applyPlugin(...)` to return `Promise<ApplyPluginResult>`.
- Return `{ _tag: "Loaded" }` after v1 object plugin success and after legacy plugin success.
- Replace the existing silent early return with `{ _tag: "SkippedV2", spec: load.spec, path: load.entry }`.
- Leave `getLegacyPlugins` unchanged so genuine legacy/v1 failures still throw and are logged at ERROR.

### Step 3: Log V2 Skips At DEBUG

- In the external plugin application loop in `packages/opencode/src/plugin/index.ts`, add an Effect success branch before `Effect.tapError(...)`:

```ts
Effect.flatMap((result) =>
  result._tag === "SkippedV2"
    ? Effect.logDebug("skipping v2 plugin module in v1 loader", {
        spec: result.spec,
        path: result.path,
      })
    : Effect.void,
)
```

- Keep the existing `Effect.tapError((error) => Effect.logError("failed to load plugin", { path: load.spec, error }))` unchanged.

### Step 4: Update Loader-Path Regression Coverage

- Modify `packages/opencode/test/plugin/loader-shared.test.ts`.
- Keep the loader-path v2 regression using existing `withTmp(...)` and `load(tmp.path)`.
- Capture structured log entries, including `options.message` and `options.logLevel`.
- Assert the valid v2 fixture emits DEBUG message `skipping v2 plugin module in v1 loader` with the file spec/path.
- Assert that valid v2 fixture does not emit ERROR, `failed to load plugin`, or `Plugin export is not a function`.
- Keep the malformed v1-looking default guard and assert it still emits ERROR `failed to load plugin` with `must default export an object with server()`.

### Step 5: Verify

Run from `packages/opencode`:

```sh
bun test test/plugin/loader-shared.test.ts --timeout 30000
bun typecheck
```

Re-run the manual repro from the temp git repo:

```sh
bun <worktree>/packages/opencode/src/index.ts debug agent build --print-logs --log-level INFO
```

Expected result: no `level=ERROR ... failed to load plugin ... Plugin export is not a function` for a valid v2 plugin, while malformed v1 plugin failures remain ERROR in regression coverage.

## Build

### Implemented Changes

- `packages/opencode/src/plugin/shared.ts`
  - Exported `isV2PluginModule(mod: Record<string, unknown>)`.
  - Routed `readV1Plugin(..., "detect")` through the module-level v2 predicate.
  - Kept v2 recognition narrow: default export object with `id: string`, no `server`, no `tui`, and function `setup` or `effect`.

- `packages/opencode/src/plugin/index.ts`
  - Imported `isV2PluginModule`.
  - Added internal `ApplyPluginResult` with `Loaded` and `SkippedV2` outcomes.
  - Updated `applyPlugin` to return `{ _tag: "SkippedV2", spec, path }` for v2-shaped modules before falling through to `getLegacyPlugins(load.mod)`.
  - Added `Effect.logDebug("skipping v2 plugin module in v1 loader", { spec, path })` in the surrounding Effect pipeline for `SkippedV2` results.
  - Left `getLegacyPlugins` and ERROR handling unchanged for genuine invalid v1/legacy failures.

- `packages/opencode/test/plugin/loader-shared.test.ts`
  - Removed the direct-only `readV1Plugin` regression tests.
  - Added a real server loader-path test for a valid v2 `{ id, setup }` default export, asserting DEBUG `skipping v2 plugin module in v1 loader` is captured with `spec`/`path`.
  - The same test asserts no ERROR, `failed to load plugin`, or `Plugin export is not a function` is captured for the v2 file.
  - Added a loader-path guard that malformed `{ id }` defaults still emit `failed to load plugin` with `must default export an object with server()`.

## Verify

### Commands Run Locally

From `packages/opencode`:

```sh
bun test test/plugin/loader-shared.test.ts --timeout 30000
```

Result: `30 pass`, `0 fail`, `45 expect() calls`.

```sh
bun typecheck
```

Result: passed.

Manual repro from `<tmp>/xcod-96-repro` at INFO:

```sh
bun <worktree>/packages/opencode/src/index.ts debug agent build --print-logs --log-level INFO
```

Result: no `level=ERROR ... failed to load plugin ... Plugin export is not a function` entry for `.opencode/plugin/hello-v2.ts`.

Manual repro from the same repo at DEBUG:

```sh
bun <worktree>/packages/opencode/src/index.ts debug agent build --print-logs --log-level DEBUG
```

Result: emitted `level=DEBUG message="skipping v2 plugin module in v1 loader" spec=file:///.../hello-v2.ts path=file:///.../hello-v2.ts` with no plugin load ERROR.

### QA Agent Result

QA status: PASS.

QA ran:

```sh
bun test test/plugin/loader-shared.test.ts --timeout 30000
bun typecheck
```

QA also performed repro-style loader checks and a direct `{ id, effect }` detector check. No regressions found. QA noted that the loader-path regression covers `{ id, setup }`; `{ id, effect }` is covered by the shared predicate check.

After the DEBUG-logging rewind, QA additionally verified:

- DEBUG log `skipping v2 plugin module in v1 loader` includes `spec` and `path`.
- No `failed to load plugin` or `Plugin export is not a function` appears for the valid v2 repro.
- `isV2PluginModule` returns true for both `{ id, setup }` and `{ id, effect }`, and false for malformed `{ id }`.
