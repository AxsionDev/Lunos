#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

await $`bun dev generate > ../sdk/openapi.json`.cwd("packages/opencode")

// Regenerated here so docs/provider-jurisdictions.md cannot drift from the table that actually
// governs residency enforcement (packages/core/src/jurisdiction.ts). XCOD-61.
await $`bun ./script/jurisdictions.ts`

// XCOD-90: keeps packages/opencode/package.json's lunos.upstreamVersion at the last upstream sync.
await $`bun ./script/upstream-version.ts`

await $`./script/format.ts`
