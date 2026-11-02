#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

// XCOD-337: the Python SDK's models and operations come from the same spec. It needs uv; without
// it, sdk-python.yml's drift check says what to run.
if (Bun.which("uv")) await $`uv run --group codegen python script/generate.py`.cwd("packages/sdk/python")
else console.warn("uv not found: skipped the Python SDK (packages/sdk/python/script/generate.py)")

// Regenerated here so docs/provider-jurisdictions.md cannot drift from the table that actually
// governs residency enforcement (packages/core/src/jurisdiction.ts). XCOD-61.
await $`bun ./script/jurisdictions.ts`

// XCOD-90: keeps packages/opencode/package.json's lunos.upstreamVersion at the last upstream sync.
await $`bun ./script/upstream-version.ts`

// XCOD-121: the outbound-call table in docs/deployment/self-hosted.md comes from Offline.CALLS.
await $`bun ./script/offline-calls.ts`

// XCOD-174: the JSON Schemas lunos.tech publishes (config, tui, theme, desktop-theme), from source.
await $`bun ./script/schemas.ts`

await $`./script/format.ts`
