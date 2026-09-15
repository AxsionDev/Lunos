---
type: user-journeys
identifier: xcod-34-registry-api-journeys
generated: 2026-09-14
source_documentation:
  - .claude/docs/xcod-34-registry-api.md
  - packages/opencode/specs/marketplace-registry.md
  - packages/opencode/src/marketplace/shared.ts
  - packages/opencode/src/plugin/discover.ts
  - packages/console/function/src/auth.ts
  - packages/console/function/src/stat.ts
actor_types: [End User, System/API Consumer, Admin/Operator]
journey_count: 10
gap_count: 4
---

# User Journeys: XCOD-34 Registry API (read endpoints)

## Executive Summary

- **Total Journeys Identified:** 10 (3 End User, 4 API Consumer, 3 Admin/Operator)
- **Actor Distribution:** End User 3, System/API Consumer 4, Admin/Operator 3, System (automated) 0, External Integration 0
- **Coverage Status:** Gaps Identified (2 need explicit confirmation, 2 minor proposals carried as defaults)
- **Documentation Sources:** `xcod-34-registry-api.md` (Discovery), `marketplace-registry.md` (XCOD-33 design spec), plus direct reads of `shared.ts`, `discover.ts`, `auth.ts`, `stat.ts` for exact technical entry points
- **Scope note:** This is a small, well-specified backend-only story (4 read endpoints, no UI). Actor taxonomy adapted per the task brief: no Staff User actor exists (nothing in this story is operated by internal non-admin staff), and Staff User / generic System (automated job) sections are intentionally omitted rather than padded to meet the analyst's default minimums — those minimums are explicitly overridden for this story.

## Actor Map

| Actor | Role | Journey Count | Key Interactions |
|-------|------|----------------|-------------------|
| End User | Lunos CLI/TUI user (human) | 3 | `marketplace add <registry-url>/marketplace.json`, `marketplace list`, `marketplace search` — all via existing XCOD-10/XCOD-11 client code, unmodified |
| System/API Consumer | Raw HTTP client — future registry-aware tooling, or a developer exploring the API directly | 4 | `GET /marketplaces`, `GET /plugins`, `GET /plugins/search?q=`, `GET /marketplace.json` |
| Admin/Operator | Engineer deploying/operating the registry service | 3 | Provision D1 (EU jurisdiction, irreversible choice), seed from `marketplace.json`, verify deployment against Jira ACs |
| System (automated) | N/A for XCOD-34 | 0 | None — no scheduled jobs, no startup hooks in a Worker. Ingestion/refresh automation is XCOD-35. |
| External Integration | N/A for XCOD-34 | 0 | None — see dedicated section below |

---

## End User Journeys

### [EUSR-001] Add the registry as a marketplace source

**Actor:** End User — Lunos CLI/TUI user
**Trigger:** User runs `lunos marketplace add https://<registry-workers-dev-url>/marketplace.json` (dev/staging `workers.dev` URL for XCOD-34; a custom `registry.<domain>` is XCOD-36 scope, not available yet)
**Preconditions:**
- Registry Worker deployed and D1 seeded (ADMIN-001, ADMIN-002 complete)
- Lunos CLI installed (XCOD-10 code path, unmodified by this story)

**Journey Steps:**
| Step | Action | Code/API | Expected Outcome | Error Scenarios |
|------|--------|----------|-------------------|------------------|
| 1 | CLI classifies the source spec | `sourceKind()`, `packages/opencode/src/marketplace/shared.ts` (~L26-30) — `https://` prefix → `"url"` kind | Source recognized as URL-based | Malformed URL string → falls through to github-shorthand/path detection, likely fails later |
| 2 | CLI fetches manifest text | `manifestText()` url branch → `fetchText(url)` (shared.ts ~L44-49), sends `Accept: application/json` | Raw manifest text returned | Non-2xx response → `fetchText` throws `` `Request to ${url} failed with status ${response.status}` `` |
| 3 | Worker routes the request | `packages/registry/src/index.ts` (new), manual `new URL(request.url).pathname === "/marketplace.json"` — same style as `packages/console/function/src/auth.ts:45-46` | Request matched to the manifest handler | — |
| 4 | Worker assembles response | D1 query (behind a DI-testable seam per Discovery risk #2) aggregates all seeded plugins into one `Marketplace.Manifest`-shaped document | 200 JSON body, bare manifest shape, zero extra top-level fields | D1 unavailable/query throws → 5xx (see APIC-004) |
| 5 | CLI parses and validates | `JSON.parse` then `Marketplace.decode` (`Schema.decodeUnknownSync(Manifest)`, `packages/core/src/marketplace.ts`) | Manifest object in memory | Invalid JSON → parse throws; schema mismatch → decode throws |
| 6 | CLI persists the source | `patchPluginConfig` writes to `FIELD = "marketplace"` config array; `cacheMarketplaceManifest` caches manifest locally (XCOD-13) | Source added to config, cache warm | — |

**Data Flow:**
```
CLI arg (URL) -> sourceKind() -> fetchText() -> [Worker: pathname route -> D1 query -> Manifest JSON] -> JSON.parse -> Marketplace.decode -> config + cache write
```

**Success Outcome:** `outro` confirms the marketplace was added; local config and cache reflect the registry as a marketplace source, indistinguishable from any other URL-hosted marketplace.

**Alternative Paths:**
- **[ALT-A]** Source already present in config → existing "already added" short-circuit (unchanged XCOD-10 behavior, not touched by this story).

**Error Paths:**
- **[ERR-1]** Worker/D1 down or query fails → client sees the literal thrown string `Request to <url> failed with status <code>` → add fails, no config mutation.
- **[ERR-2]** Response body not valid JSON → `JSON.parse` throws → add fails.
- **[ERR-3]** Response decodes but violates `Marketplace.Manifest` shape (e.g. extra top-level fields — a requirement per Discovery, not a demonstrated Effect Schema failure mode) → `Marketplace.decode` throws → add fails.

**Integration Points:**
| System | Direction | Purpose |
|--------|-----------|---------|
| Registry Worker (`GET /marketplace.json`) | Outbound (client → registry) | Only registry endpoint any End User journey touches |

**Related Journeys:** APIC-004 (`GET /marketplace.json` server side), ADMIN-002 (seed data this depends on)

**Agent Notes:**
- Key files: `packages/opencode/src/marketplace/shared.ts`, `packages/opencode/src/cli/cmd/marketplace.ts`, `packages/core/src/marketplace.ts`
- Test scenarios: verify no client-side code changes are needed (this journey exercises existing XCOD-10 code against a new server, not new client logic)
- Common issues: don't confuse this with the API Consumer journeys below — `marketplace add` never calls `/marketplaces`, `/plugins`, or `/plugins/search`, only `/marketplace.json`

---

### [EUSR-002] List plugins from a registry-backed marketplace

**Actor:** End User — Lunos CLI/TUI user
**Trigger:** `lunos marketplace list` or `plugin list`, after EUSR-001
**Preconditions:** Registry added as a marketplace source (EUSR-001 complete)

**Journey Steps:**
| Step | Action | Code/API | Expected Outcome | Error Scenarios |
|------|--------|----------|-------------------|------------------|
| 1 | Resolve configured sources | `resolveAddedMarketplaces` (shared.ts) | List of source specs including the registry URL | — |
| 2 | Refresh-or-fallback per source | `refreshMarketplaceCache` — refetches `/marketplace.json`, respecting cache freshness (XCOD-13) | Fresh manifest, or fallback to last-cached copy with `stale` marker if the fetch fails | Registry unreachable + no prior cache → source excluded (`entry.ok === false`) |
| 3 | Flatten plugins | `listPlugins` (`packages/opencode/src/plugin/discover.ts` ~L38-58) — iterates `resolved` entries, skips `!entry.ok`, builds `PluginListEntry[]` with `marketplace`, `spec` (via `pluginInstallSpec`) | Combined plugin list across all sources, registry-sourced rows indistinguishable from other sources | — |

**Success Outcome:** Plugin table displayed including registry-sourced plugins; `PluginMarketplaceStatus` shows `stale` if the last fetch fell back to cache.

**Alternative Paths:**
- **[ALT-A]** Registry temporarily unreachable but a prior successful fetch was cached → list still succeeds, marked stale, no hard error (differs from EUSR-001's hard failure since `add` has no cache to fall back to).

**Error Paths:**
- **[ERR-1]** Registry unreachable on first-ever fetch (no cache yet — shouldn't normally happen since EUSR-001 must have succeeded to add the source, but covers a manually-edited config) → source skipped in `listPlugins`, no plugins from that source shown, no crash.

**Related Journeys:** EUSR-001, EUSR-003, APIC-004

**Agent Notes:**
- Key files: `packages/opencode/src/plugin/discover.ts`, `packages/opencode/src/marketplace/shared.ts`
- Common issues: this journey never calls `GET /plugins` — it re-fetches `/marketplace.json` and flattens client-side, same as any other marketplace source.

---

### [EUSR-003] Search plugins locally against registry-backed cache

**Actor:** End User — Lunos CLI/TUI user
**Trigger:** `lunos marketplace search <query>` or `plugin search <query>`
**Preconditions:** Registry added as a marketplace source (EUSR-001)

**Journey Steps:**
| Step | Action | Code/API | Expected Outcome | Error Scenarios |
|------|--------|----------|-------------------|------------------|
| 1 | Run `listPlugins` internally | `searchPlugins` calls `listPlugins` first (`discover.ts` ~L130-137) | Same flattened list as EUSR-002 | Inherits EUSR-002 errors |
| 2 | Filter client-side | Case-insensitive substring match over `[name, description ?? "", category ?? "", ...tags ?? []]` (haystack — **not** `author`, **not** `marketplace`) | Matching subset returned | Empty query → `needle = ""` → `includes("")` always true → returns everything |

**Success Outcome:** Matching plugins displayed, entirely from local cache.

**Important — explicitly does NOT call the registry's search endpoint:** `searchPlugins` is 100% client-side filtering over the already-cached/flattened manifest data. It never issues `GET /plugins/search?q=`. That endpoint (APIC-003) exists for *future registry-aware tooling*, per the XCOD-33 spec — do not build or assume a network call here in Phase 4.

**Error Paths:** Inherits EUSR-002's error paths (this journey is a pure post-filter on `listPlugins`'s result).

**Related Journeys:** EUSR-002, APIC-003 (server-side equivalent, used by a different actor)

**Agent Notes:**
- Key files: `packages/opencode/src/plugin/discover.ts` (`searchPlugins`)
- Common issues: keeping this distinction clear is the single most important thing for Phase 3/4 — conflating client-side search with the registry's `/plugins/search` endpoint would invent client-side scope this ticket doesn't include.

---

## System/API Consumer Journeys

*Actor: a raw HTTP client — future registry-aware tooling, or a developer/curl session hitting the registry directly. Not the Lunos CLI (see End User section above). One journey per endpoint; happy, empty, and malformed paths are nested within each rather than split into separate journeys, to avoid inflating journey count for a 4-endpoint API.*

### [APIC-001] `GET /marketplaces`

**Trigger:** HTTP GET to `/marketplaces` on the registry's dev/staging URL
**Preconditions:** Worker deployed (ADMIN-001); D1 seeded or empty (both are valid states to exercise)

**Journey Steps:**
| Step | Action | Component | Data Affected |
|------|--------|-----------|-----------------|
| 1 | Request arrives | Worker `fetch` handler, `packages/registry/src/index.ts` | — |
| 2 | Pathname match | Manual `new URL(request.url).pathname === "/marketplaces"` (style per `auth.ts:45-46`) | — |
| 3 | Query D1 | DI-testable seam over `env.MarketplaceRegistryDb` *(type `Env = { MarketplaceRegistryDb: D1Database }` by analogy to `AuthStorage: KVNamespace` — unconfirmed, no existing D1 precedent in this repo per Discovery)* | Reads marketplace table |
| 4 | Compute `pluginCount` | Derived per marketplace, not a stored manifest field | Reads/aggregates plugin table |
| 5 | Serialize response | `{ marketplaces: [{ name, owner, description, pluginCount, source }] }` | — |

**Success Outcome (happy path):** `200`, `marketplaces` array with one entry per ingested marketplace (1 entry after ADMIN-002 seeding, matching the seed's `lunos-community`).

**Alternative Paths:**
- **[ALT-A — empty result]** D1 has zero marketplace rows (pre-seed, or seed failed per ADMIN-002's abort behavior) → `200 { "marketplaces": [] }`. **Not a 404** — matches the client's "no marketplaces" semantics used elsewhere in this contract.

**Error Paths:**
- **[ERR-1 — D1 unavailable/query failure]** Binding missing, D1 outage, or query throws → Worker returns `5xx` with an error body. *(Exact error envelope shape is not specified by XCOD-33's spec or Discovery — see GAP-003; proceed with a plain `{ "error": string }` JSON body as the working default.)*
- **[ERR-2 — malformed request]** Wrong HTTP method (e.g. `POST /marketplaces`) or an unmatched path under this prefix → propose `405` for a known path + wrong method, `404` for a genuinely unmatched path (see GAP-004).

**Technical Entry Points:**
- Backend: `packages/registry/src/index.ts` (new), pathname branch for `/marketplaces`
- Database: registry's marketplace table (schema itself is a Phase 3 contract decision, not fixed by this doc)

**Related Journeys:** ADMIN-002 (data this reads), APIC-002/003/004 (sibling endpoints, same Worker/routing pattern)

---

### [APIC-002] `GET /plugins`

**Trigger:** HTTP GET to `/plugins`
**Preconditions:** Same as APIC-001

**Journey Steps:**
| Step | Action | Component | Data Affected |
|------|--------|-----------|-----------------|
| 1-2 | Request arrives, pathname match | Worker fetch handler | — |
| 3 | Query D1 for all plugin rows, joined/denormalized with parent marketplace `name` | DI seam over D1 | Reads plugin + marketplace tables |
| 4 | Flatten, preserving raw `source` | Registry-native analog of `listPlugins` — **reuses the matching/flattening logic pattern, not the `PluginListEntry` type**, since the registry must keep `source` as the raw `Marketplace.Source` union (client's `PluginListEntry.spec` collapses it to an install string; the registry response must not) | — |
| 5 | Serialize | `{ plugins: [{ name, marketplace, description, category, tags, source }] }` | — |

**Success Outcome (happy path):** `200`, full flattened plugin list (32 entries after ADMIN-002 seeding).

**Alternative Paths:**
- **[ALT-A — empty result]** No plugins seeded yet → `200 { "plugins": [] }`, not `404`.

**Error Paths:**
- **[ERR-1 — D1 unavailable/query failure]** → `5xx`, same envelope as APIC-001/ERR-1.
- **[ERR-2 — malformed request]** Wrong method or unmatched sub-path → `405`/`404` per GAP-004's proposed convention.

**Technical Entry Points:**
- Backend: `packages/registry/src/index.ts`, pathname branch for `/plugins`
- Database: plugin table (denormalized with marketplace name, per spec's data-seed-mapping section)

**Related Journeys:** APIC-003 (search is this endpoint's filtered variant), EUSR-002 (client-side analog, no network dependency on this endpoint)

---

### [APIC-003] `GET /plugins/search?q=<query>`

**Trigger:** HTTP GET to `/plugins/search` with a `q` query parameter
**Preconditions:** Same as APIC-001/002

**Journey Steps:**
| Step | Action | Component | Data Affected |
|------|--------|-----------|-----------------|
| 1-3 | Request arrives, pathname match, `q` extracted from `URLSearchParams` | Worker fetch handler | — |
| 4 | Filter server-side | Same matching fields as client's `searchPlugins`: case-insensitive substring over `name`, `description`, `category`, `tags` — **explicitly not** `author` or `marketplace`, to keep behavior consistent whichever side (client cache vs. registry) does the searching | Reads same data as APIC-002 |
| 5 | Serialize | Identical shape to `GET /plugins`, scoped to matches | — |

**Success Outcome (happy path):** `200`, `plugins` array of matches.

**Alternative Paths:**
- **[ALT-A — empty query]** `q=` (present, empty string) → per spec parity with the client (`needle = "".toLowerCase()`, `includes("")` always true) → `200`, **all** plugins returned, same as `GET /plugins`.
- **[ALT-B — no matches]** Non-empty `q` matches nothing → `200 { "plugins": [] }` — explicitly called out in XCOD-33's spec as **not** a `404`.

**Error Paths:**
- **[ERR-1 — malformed/missing `q`]** `q` param entirely absent from the URL → **GAP-001, needs confirmation** (working default below).
- **[ERR-2 — D1 unavailable/query failure]** → `5xx`, same as APIC-001/ERR-1.
- **[ERR-3 — malformed request]** Wrong method → `405` per GAP-004.

**Technical Entry Points:**
- Backend: `packages/registry/src/index.ts`, pathname branch for `/plugins/search`, `URLSearchParams.get("q")`
- Database: same plugin table as APIC-002

**Related Journeys:** APIC-002, EUSR-003 (client-side analog — does not call this endpoint)

---

### [APIC-004] `GET /marketplace.json`

**Trigger:** HTTP GET to `/marketplace.json` (fixed path — this is also what EUSR-001's `marketplace add` hits)
**Preconditions:** Same as APIC-001

**Journey Steps:**
| Step | Action | Component | Data Affected |
|------|--------|-----------|-----------------|
| 1-2 | Request arrives, pathname match on exact `/marketplace.json` | Worker fetch handler | — |
| 3 | Query D1 for every plugin across every ingested marketplace | DI seam over D1 | Reads plugin + marketplace tables |
| 4 | Assemble a bare `Marketplace.Manifest` document — `name`, `owner`, `description`, `version`, `plugins: Entry[]` — using the registry's **own fixed identity** for top-level `name`/`owner` (not any single seeded marketplace's identity) | Reuses `Marketplace.Manifest`/`Entry`/`Source` from `packages/core/src/marketplace.ts`, no redefinition | — |
| 5 | Serialize with zero extra top-level fields | Requirement per Discovery: any wrapper/extra field would break `resolveMarketplaceManifest`'s `Marketplace.decode` call client-side | — |

**Success Outcome (happy path):** `200`, a document that `Marketplace.decode` accepts unmodified — this is the endpoint XCOD-34's Jira AC ("payloads validate against the XCOD-8 schema") and EUSR-001 both depend on.

**Alternative Paths:**
- **[ALT-A — empty dataset]** No plugins seeded yet → `200`, manifest with `plugins: []` (a valid, schema-conformant empty array — `Entry.pipe(Schema.Array)` permits zero elements) rather than an error.

**Error Paths:**
- **[ERR-1 — D1 unavailable/query failure]** → `5xx`. Because this is the endpoint `marketplace add` actually depends on, this is also EUSR-001/ERR-1 from the client's point of view.
- **[ERR-2 — schema-invalid seed data]** Not a per-request condition — a Worker has no startup hook, so this can't manifest as a runtime validation step here. It is gated entirely at seed time (**ADMIN-002**): if `marketplace.json` fails `Marketplace.decode` during seeding, the seed aborts and D1 is never written with bad rows, so this endpoint can never legitimately serve invalid data. Cross-referenced here rather than re-implemented as request-time validation.
- **[ERR-3 — malformed request]** Wrong method → `405` per GAP-004.

**Technical Entry Points:**
- Backend: `packages/registry/src/index.ts`, pathname branch for exact `/marketplace.json`
- Database: plugin + marketplace tables (same underlying data as APIC-001/002, different projection)

**Related Journeys:** EUSR-001 (this endpoint is EUSR-001's entire server-side dependency), ADMIN-002 (seed-time validation this endpoint relies on)

---

## Admin/Operator Journeys

### [ADMIN-001] Provision the D1 database and Worker (dev/staging)

**Actor:** Admin/Operator (engineer deploying XCOD-34)
**Trigger:** Setting up registry infrastructure for the first time in XCOD-34's dev/staging scope
**Preconditions:** SST config access, Cloudflare account/API token configured, `infra/console.ts` available as the Worker-construct precedent

**Process Steps:**
| Step | Action | Component | Data Affected |
|------|--------|-----------|-----------------|
| 1 | **Before creating anything**, confirm whether `sst.cloudflare.D1`'s `transform.database` escape hatch actually plumbs `jurisdiction: "eu"` through to the underlying Cloudflare `D1DatabaseArgs` | SST source/docs, Cloudflare provider resource | None yet — read-only verification step, gates everything after it |
| 2a | If confirmed: create D1 inline via `sst.cloudflare.D1("MarketplaceRegistryDb", { transform: { database: { jurisdiction: "eu" } } })` in a new `infra/registry.ts` | SST | Creates D1 instance |
| 2b | If **not** confirmed: create the DB out-of-band via `wrangler d1 create --jurisdiction=eu`, then reference it in SST via `sst.cloudflare.D1.get(...)` — **never** create inline in this case | wrangler CLI + SST | Creates D1 instance |
| 3 | Define the Worker | `sst.cloudflare.Worker("MarketplaceRegistry", { handler: "packages/registry/src/index.ts", url: true, link: [registryDb] })` — `url: true` gives a `workers.dev` URL for dev/staging; a custom `domain: registry.<domain>` is XCOD-36 scope, not provisioned here | Creates Worker |
| 4 | Deploy | `sst dev` / `sst deploy` | Worker live, D1 binding resolvable as `env.MarketplaceRegistryDb` (`Env` type declared locally per-file, by analogy to `AuthStorage: KVNamespace` — **unconfirmed pattern**, no existing D1 usage anywhere in this repo per Discovery) |
| 5 | Apply schema/migrations | D1 migration mechanism (TBD — Phase 3 contract decision) for marketplace + plugin tables | Creates tables |

**Success Outcome:** D1 database exists with confirmed EU jurisdiction (verifiable via Cloudflare dashboard/API), Worker deployed and reachable over HTTPS at its `workers.dev` URL, binding resolves without error.

**Failure Handling:**
- **[FAIL-1]** Jurisdiction plumbing turns out unconfirmed *after* a database was already created inline → **unrecoverable** per the spec (jurisdiction is create-time-only, irreversible) — the database must be destroyed and recreated via the `wrangler d1 create --jurisdiction=eu` path. This is exactly why step 1 must happen before step 2, not after.
- **[FAIL-2]** `sst dev`/`deploy` can't resolve the D1 binding → Worker fails to start, or every request 500s at runtime (surfaces as APIC-*/ERR-1 for every endpoint).

**Downstream Effects:** Every API Consumer journey and EUSR-001 depend on this journey completing successfully.

---

### [ADMIN-002] Seed D1 from the root `marketplace.json`

**Actor:** Admin/Operator
**Trigger:** Operator runs a seed script/task after ADMIN-001's deployment, before the endpoints are considered AC-complete
**Preconditions:** ADMIN-001 complete (Worker deployed, D1 binding resolvable)

**Process Steps:**
| Step | Action | Component | Data Affected |
|------|--------|-----------|-----------------|
| 1 | Read repo-root `marketplace.json` (XCOD-9 seed — 32 entries, all `source.type: "github"`, no `npm`/`category`/`tags` examples in the real data) | Seed script | — |
| 2 | Decode via `Marketplace.decode` (`Schema.decodeUnknownSync(Manifest)`) **before writing any row** — this is the only place "schema-invalid seed data" can be caught, since a Worker has no startup/boot hook | `@opencode-ai/core/marketplace` | Validates in-memory only |
| 3a | If decode succeeds: insert one marketplace row + one plugin row per entry (denormalized with parent marketplace `name`, per spec's data-seed-mapping section), ideally as a single D1 batch/transaction | D1 write | Marketplace + plugin tables populated |
| 3b | If decode fails: **abort the seed**, write nothing | Seed script | D1 left in its prior state (untouched, or empty on first run) |

**Success Outcome:** D1 has 1 marketplace row (`lunos-community`) and one plugin row per entry in the seed file — 32 entries at the time of Discovery (this count belongs to `marketplace.json`'s current contents, not a fixed constant; it changes if the seed file changes, and is unrelated to the illustrative `"pluginCount": 36` figure in XCOD-33's `/marketplaces` example response, which is a documentation example, not the real seed's count).

**Failure Handling:**
- **[FAIL-1 — schema-invalid seed data]** Decode fails → seed aborts before any writes → all 4 endpoints continue serving prior state (empty, on first run) rather than partially-seeded or corrupt data. Operator fixes `marketplace.json` (or the seed script) and reruns.
- **[FAIL-2 — partial write]** D1 write fails mid-seed if not run as a single transaction/batch → risk of inconsistent marketplace/plugin row counts. Recommend batching inserts to avoid this (a Phase 3/4 implementation concern, flagged here so it isn't missed).

**Downstream Effects:** All 4 API Consumer endpoints and EUSR-001/002/003 read this data; the "empty result set" alternative paths (APIC-001/002/003/004 ALT-A) describe the state *before* this journey runs.

---

### [ADMIN-003] Verify deployment against XCOD-34's acceptance criteria

**Actor:** Admin/Operator
**Trigger:** Confirming AC #1 ("all endpoints live/reachable over HTTPS in dev/staging") and AC #2 ("payloads validate against the XCOD-8 schema") after ADMIN-001/002
**Preconditions:** ADMIN-001 and ADMIN-002 complete

**Process Steps:**
| Step | Action | Component | Data Affected |
|------|--------|-----------|-----------------|
| 1 | Hit all 4 endpoints over HTTPS against the `workers.dev` URL | curl / HTTP client | — |
| 2 | Confirm each returns `200` with the expected shape (per APIC-001..004's happy paths) | Manual/scripted check | — |
| 3 | Programmatically round-trip the `/marketplace.json` response through `Marketplace.decode` — not just eyeballing the JSON — to actually satisfy AC #2 | `@opencode-ai/core/marketplace` | — |
| 4 | Confirm plugin/marketplace counts match the seed file's actual entry count at seed time (1 marketplace row; plugin row count equals `marketplace.json`'s current `plugins.length`, not a hardcoded number — this will drift once XCOD-35 starts ingesting beyond the initial seed) | Manual/scripted check | — |

**Success Outcome:** All 4 endpoints reachable and correct; `/marketplace.json` decodes cleanly; counts match the seed file used — XCOD-34's Jira ACs #1–#3 are satisfied (AC #4, test coverage, is validated by the actual test suite, not this manual journey).

**Failure Handling:**
- **[FAIL-1]** Any endpoint unreachable or returns unexpected shape/5xx → not yet AC-complete, loop back to ADMIN-001 (infra) or ADMIN-002 (data).

**Downstream Effects:** This is the smoke-test gate before XCOD-34 is considered done; it does not cover XCOD-36's production/custom-domain verification, which is out of scope here.

---

## System Journeys

**N/A for XCOD-34.** A Cloudflare Worker has no scheduled/background execution model and no startup hook — every piece of server-side behavior in this story is either synchronous request handling (captured under **System/API Consumer** journeys above) or an operator-run one-off script (captured under **Admin/Operator**). A genuine automated System journey — a scheduled job that crawls/refreshes marketplaces beyond the one-time seed — is explicitly XCOD-35's scope, not XCOD-34's, per both the Jira ticket and the XCOD-33 spec's "Explicitly out of scope for v1" list combined with the epic breakdown (XCOD-32 → XCOD-34/35/36).

## External Integration Journeys

**N/A for XCOD-34.** No third-party system calls into, or is called by, this story's endpoints:
- The Lunos CLI/TUI client is first-party and already covered under End User journeys.
- Manual operator tooling (`wrangler`, `sst`, curl) is covered under Admin/Operator journeys.
- XCOD-35 (an automated ingestion/crawling job that would poll external marketplace sources) and XCOD-36 (production deploy, custom domain, plus the "no new client code" AC verification against a real external caller) are separate, later stories in epic XCOD-32 and are explicitly out of scope for this document per the task brief.

---

## Gaps and Open Questions

### [GAP-001] Missing vs. empty `q` on `GET /plugins/search`

**Location:** APIC-003
**Impact:** APIC-003's error/alternative paths; Phase 3 contract for this endpoint
**Question:** Should `GET /plugins/search` with **no** `q` parameter at all behave differently from `q=` (present but empty)? The client's `searchPlugins` never faces this ambiguity — the CLI always passes a real string.
**Proposed resolution (working default until confirmed):** Absent `q` → `400 Bad Request` (missing required parameter). Present-but-empty or whitespace-only `q` → `200`, all plugins returned (mirrors the client's `trim().toLowerCase()` → `includes("")` → always-true behavior exactly). **Needs explicit confirmation before Phase 3 contract-writing** — this is a real behavioral decision, not a formatting detail.

### [GAP-002] Registry's own fixed identity for `GET /marketplace.json`'s top-level `name`/`owner`

**Location:** APIC-004
**Impact:** APIC-004's happy path; EUSR-001 (client sees this value after every `marketplace add`)
**Question:** The XCOD-33 spec says the aggregate manifest's top-level `name`/`owner` must be a fixed registry identity (e.g. `"lunos-registry"`), not inferred from any single seeded marketplace — but only suggests the `name`. The `owner` block (`name`, optional `email`, optional `url`) is unspecified, and there is no existing "registry-as-owner" identity anywhere in the codebase to derive one from (the only `owner` values that exist today belong to the seeded `lunos-community` marketplace itself — `{ name: "Lunos Community", url: "https://github.com/lunos-community" }` per the spec's `/marketplaces` example — which is a different entity from the registry aggregating it).
**Proposed resolution:** treat the entire `owner` block, not just `name`, as **explicitly TBD — needs an explicit decision, not a placeholder value carried into Phase 3.** Do not default to a synthetic URL (e.g. a guessed GitHub org) that a later phase could copy literally as if it were confirmed.

### [GAP-003] Error response envelope shape for 5xx responses (minor)

**Location:** All 4 API Consumer journeys, ERR-1
**Impact:** Low — doesn't block Phase 3 contract-writing, but should be settled once rather than improvised per-endpoint
**Question:** Neither the XCOD-33 spec nor the Discovery doc specifies a JSON error body shape for failure responses.
**Suggested resolution:** A plain `{ "error": string }` JSON body alongside the appropriate status code, consistent with every other response in this contract being JSON. Carried forward as a working default; revisit only if Phase 3's team-lead contract wants something more structured (e.g. an error code field).

### [GAP-004] Unmatched path / wrong-method handling (minor)

**Location:** All 4 API Consumer journeys, malformed-request error paths
**Impact:** Low — a manual pathname router needs *some* explicit behavior here, but it's not specified anywhere
**Question:** What should the router return for a request to an unmatched path, or a matched path with the wrong HTTP method (e.g. `POST /marketplaces`)?
**Suggested resolution:** `404` for a genuinely unmatched path, `405 Method Not Allowed` for a matched path used with the wrong method (mirrors `packages/console/function/src/stat.ts`'s existing `if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 })` precedent). Carried forward as a working default.

---

## Journey Cross-Reference Matrix

| Journey ID | Triggers | Triggered By | Shares Data With |
|------------|----------|----------------|-------------------|
| EUSR-001 | APIC-004 (via HTTP call) | User running `marketplace add` | ADMIN-002 (seed data) |
| EUSR-002 | APIC-004 (re-fetch on refresh) | User running `marketplace list` | EUSR-001 (source config), ADMIN-002 |
| EUSR-003 | — (pure client-side, no HTTP) | User running `marketplace search` | EUSR-002 (reuses its `listPlugins` result) |
| APIC-001 | — | Any raw HTTP client | ADMIN-002 (marketplace table) |
| APIC-002 | — | Any raw HTTP client | ADMIN-002 (plugin table) |
| APIC-003 | — | Any raw HTTP client | APIC-002 (same underlying data, filtered) |
| APIC-004 | — | Any raw HTTP client, or EUSR-001 | ADMIN-002 (all data), EUSR-001 (consumer) |
| ADMIN-001 | — | Operator, first-time setup | Gates all APIC-* and EUSR-* journeys |
| ADMIN-002 | — | Operator, after ADMIN-001 | Gates all APIC-* happy paths |
| ADMIN-003 | APIC-001..004 (as verification calls) | Operator, after ADMIN-001/002 | — |

---

## Agent Implementation Notes

> **For Development Agents (Phase 4):**
> - Start with ADMIN-001's jurisdiction-plumbing verification (step 1) — it's a blocking, irreversible decision that must happen before any D1 resource is created, before any endpoint code is written.
> - Build `packages/registry/src/index.ts`'s manual pathname router and the D1 DI seam next — every APIC-* journey depends on both.
> - GET /marketplace.json (APIC-004) is the highest-priority endpoint: it's the only one any real client (EUSR-001) actually calls, and it's what XCOD-34's and XCOD-36's ACs verify against.
> - GET /marketplaces and GET /plugins (APIC-001/002) can be built in parallel once the D1 seam exists; GET /plugins/search (APIC-003) is a thin filter over APIC-002's query.

> **For Testing Agents:**
> - Priority test scenarios: APIC-004 happy path decoding cleanly via `Marketplace.decode`; ADMIN-002's decode-before-write seed gate (schema-invalid seed data never reaches D1); GAP-001's proposed absent-vs-empty `q` behavior once confirmed.
> - Edge cases to cover: empty-D1 state for all 4 endpoints (before ADMIN-002 runs) returning `200` with empty arrays, never `404`; `q` matching only `name`/`description`/`category`/`tags`, explicitly not `author`/`marketplace`.
> - Per Discovery's testing-conventions note: keep D1 access behind the DI seam so these are `bun:test` unit tests against a fake database dependency — no `miniflare`/`vitest-pool-workers` needed for XCOD-34's scope; reserve live-D1 verification for ADMIN-003's manual smoke test.

> **For Documentation Agents:**
> - No user-facing documentation needed beyond what XCOD-10/XCOD-11 already have — End User journeys use unmodified client commands.
> - An "operating the registry" runbook (ADMIN-001/002/003 distilled) would be useful once XCOD-36 adds production deploy on top of this.

---

## Journey → User Story Mapping

| Journey ID | Suggested Epic/Area | Story Title | Priority |
|------------|----------------------|--------------|----------|
| ADMIN-001 | Registry Infra | As an operator, I can provision the D1 database with a confirmed EU jurisdiction and deploy the Worker to dev/staging | High (blocking) |
| APIC-004 | Registry API | As an API consumer, I can fetch a schema-valid aggregate manifest at `/marketplace.json` | High |
| ADMIN-002 | Registry Infra | As an operator, I can seed the registry from the root `marketplace.json`, with invalid seed data rejected before any write | High |
| APIC-001 | Registry API | As an API consumer, I can list all aggregated marketplaces | Medium |
| APIC-002 | Registry API | As an API consumer, I can list all plugins across marketplaces | Medium |
| APIC-003 | Registry API | As an API consumer, I can search plugins server-side by query | Medium |
| EUSR-001 | Client Integration | As a CLI user, I can add the registry as a marketplace source with no new client code | High (verifies contract end-to-end) |
| EUSR-002 / EUSR-003 | Client Integration | As a CLI user, I can list/search plugins from a registry-backed source | Low (already-working client code, verification only) |
| ADMIN-003 | Registry Infra | As an operator, I can verify the deployment satisfies XCOD-34's acceptance criteria | Medium |

### Implementation Sequence
1. ADMIN-001 (jurisdiction-gated D1 + Worker provisioning) — foundational, no dependencies.
2. APIC-004 + ADMIN-002 (seed + manifest endpoint) — core happy path, satisfies the most load-bearing AC.
3. APIC-001, APIC-002, APIC-003 — remaining endpoints, parallelizable once the D1 seam exists.
4. Error paths for all 4 endpoints (D1-down 5xx, empty-array 200s, GAP-001/GAP-004 resolutions).
5. EUSR-001/002/003 as end-to-end verification (no new client code to write, but worth an integration-style test against a deployed dev instance).
6. ADMIN-003 as the final AC smoke-test gate.

---

## Handoff Protocol

### For Backend Developer (Phase 4)
| Journey ID | Key Endpoints Needed |
|------------|------------------------|
| APIC-001 | `GET /marketplaces` |
| APIC-002 | `GET /plugins` |
| APIC-003 | `GET /plugins/search?q=` |
| APIC-004 | `GET /marketplace.json` |

### For Database Developer
| Journey ID | Entities Affected |
|------------|----------------------|
| ADMIN-002, APIC-001..004 | D1 marketplace table, D1 plugin table (schema TBD — Phase 3 contract) |

### For Integration/DevOps-facing work (no dedicated Admin agent in this fleet)
| Journey ID | Concern |
|------------|----------|
| ADMIN-001 | SST `infra/registry.ts`, D1 jurisdiction verification, dev/staging Worker deploy |
| ADMIN-002 | Seed script, decode-before-write gate |
| ADMIN-003 | Smoke-test checklist against Jira ACs #1–#3 |

### Open items requiring a decision before Phase 3 contracts are finalized
- **GAP-001 (absent vs. empty `q`) — blocking.** This is a contract-shape decision for `GET /plugins/search`, not an implementation detail. Phase 3 should not write that endpoint's contract until this is answered; the working default (400 for absent, all-results for empty) is a reasonable starting proposal, not a substitute for a decision.
- **GAP-002 (fixed registry identity for `/marketplace.json`) — blocking.** No placeholder value should be carried into Phase 3/4 as if confirmed; the entire `owner` block is genuinely undecided.
- GAP-003, GAP-004 — non-blocking, carried forward as working defaults unless overridden during Phase 3 review.
