---
name: project_xcod32_marketplace_registry_epic
description: Structure and story split of the Lunos Marketplace Registry epic (XCOD-32) — relevant to any future journey analysis on XCOD-33/34/35/36
metadata:
  type: project
---

Epic XCOD-32 ("Lunos Marketplace Registry Service", split out of XCOD-14 / originally XCOD-7) is a
Cloudflare Worker + D1 service (`packages/registry`, flat package) that aggregates marketplace/plugin
metadata for the Lunos CLI/TUI (a Bun/TypeScript monorepo — see [[project_claude_md_mismatch]]).
Four child stories:

- **XCOD-33** — design-only spec (`packages/opencode/specs/marketplace-registry.md`): hosting decision
  (Cloudflare Worker + D1, `jurisdiction: "eu"`), exact API contract for all 4 endpoints, data-seed
  mapping. No code.
- **XCOD-34** — read-only API implementation (`GET /marketplaces`, `/plugins`, `/plugins/search?q=`,
  `/marketplace.json`), seeded from root `marketplace.json` (XCOD-9). No UI. I documented this in
  `.claude/docs/xcod-34-registry-api-user-journeys.md`.
- **XCOD-35** — ingestion/crawling job to keep the registry fresh beyond the one-time seed. Out of
  scope for XCOD-34.
- **XCOD-36** — production deploy, custom domain (`registry.<domain>`), and the "no new client code"
  acceptance criterion verified against a real external caller. Out of scope for XCOD-34.

**Why this matters for journey analysis:** XCOD-34 has genuinely zero System (automated job) and zero
External Integration journeys — those only show up starting XCOD-35/36. Don't invent scope for those
actor types on XCOD-34-scoped work; a future XCOD-35/36 journey analysis is where they belong.

Client-side marketplace code (XCOD-8 schema, XCOD-9 seed, XCOD-10 `marketplace add`, XCOD-11
`listPlugins`/`searchPlugins`, XCOD-13 caching) is already implemented and unmodified by XCOD-34 — the
registry is *an additional* marketplace source, not a replacement. See [[feedback_client_vs_registry_endpoint_scope]].
