# Lunos Website & Marketplace — Technical Implementation Spec

Addendum to `lunos-website-prd.md` · Purpose: close the gaps between a PO-level PRD and something an AI development agent can build from without guessing or stalling on clarification. Read together with the PRD — this doesn't repeat the "why," only the "exactly what."

> **Re-phased 2026-09-15**: matches the PRD's re-phase — marketplace is now **Phase 2, deferred**. Everything below marked `[Phase 2]` is kept as the plan for when that phase starts, not deleted; it's already-specified work. **Phase 1 build scope is §1–§2, the Contact-only slice of §3–§4, all of §5–§9 except the marketplace route/screen, and §10's Phase 1 steps.**

## Why the PRD alone isn't enough for an agent

The PRD is sufficient for a human engineer with .NET/Angular judgment to start from — it states intent, architecture direction, and constraints. It is **not** sufficient for an AI agent to build unattended, because it leaves every concrete shape open: no fixed request/response schemas, no field-by-field data model, no folder/naming structure, no per-page component states, no acceptance criteria, no literal setup checklist. Two independently built projects (Angular calling a separate .NET API over HTTP) is exactly where an agent's own guesses on both sides stop matching each other. This doc pins those shapes down.

## 1. Repository & solution structure

```
lunos-website/
  Lunos.Web/                        # Angular workspace
    src/app/
      core/                         # singleton services, HTTP interceptor, guards
      shared/                       # shared components, pipes, models (mirrors API DTOs)
      features/
        marketing/
          home/ product/ roadmap/ docs-install/ sovereignty/
          faq/ changelog/ contact/ about/ license/
        marketplace/                # [Phase 2] not created in Phase 1
          marketplace-list/ marketplace-detail/
          plugin-list/ plugin-detail/
      app.routes.ts
    src/styles/
      tokens.scss                  # color + type tokens, see §6
    src/environments/
      environment.ts               # dev
      environment.production.ts    # prod
    angular.json  package.json
  Lunos.Api/                        # .NET solution
    Lunos.Api/
      Endpoints/                    # Phase 1: HealthEndpoints, ContactEndpoints only
      Models/                       # Phase 1: Contact entity only; Marketplace/Plugin are [Phase 2]
      Dtos/                         # request/response shapes (never expose entities directly)
      Data/                         # DbContext, migrations, SQLite file location
      Services/                     # Phase 1: ContactService; MarketplaceService/PluginService are [Phase 2]
      Ingestion/                    # [Phase 2] IHostedService background job (XCOD-35 logic) — not created in Phase 1
      Program.cs
      appsettings.json
      appsettings.Production.json
    Lunos.Api.Tests/
    Lunos.Api.sln
  build.ps1
  deploy.ps1
  README.md
```

The folders marked `[Phase 2]` above are intentionally absent from the Phase 1 repo — don't scaffold empty placeholders for them; add them when Phase 2 actually starts so the tree reflects what's built, not what's planned.

Rule for the agent: nothing gets added at the root level of either project outside this tree without a reason stated in a commit message — keeps the two projects independently buildable by `build.ps1` without special-casing.

**Toolchain pins** (an agent left to infer these will pick whatever's newest at build time, which drifts):
- `.NET` — pin the SDK with a `global.json` at repo root (`"sdk": { "version": "10.0.100" }`, adjust to the actual installed patch) so `dotnet build`/`publish` can't silently jump major versions.
- `Node` — pin with an `.nvmrc` (or `"engines"` in `package.json`) at a current Node LTS; record the exact version once decided rather than leaving it ambient.
- Package manager — `npm` (matches `build.ps1`'s `npm ci`); don't mix in `pnpm`/`yarn` lockfiles.
- EF Core — `Microsoft.EntityFrameworkCore.Sqlite` + `Microsoft.EntityFrameworkCore.Design`, same major version as the pinned .NET SDK's default EF Core release.

## 2. Naming conventions

- .NET root namespace: `Lunos.Api` (`Lunos.Api.Models`, `Lunos.Api.Dtos`, `Lunos.Api.Services`, `Lunos.Api.Ingestion`).
- Angular component selector prefix: `lunos-` (e.g. `lunos-plugin-list`).
- API is versioned from day one even with one consumer: base path `/api/v1/`.
- IIS site names: `Lunos.Web`, `Lunos.Api` (matches app pool names — keeps `deploy.ps1` params self-explanatory).
- Angular bootstrap: standalone, **zoneless** change detection (`provideZonelessChangeDetection`, no `zone.js` in `polyfills`) — Angular 22's signal-first direction is built around this; don't leave the app on zone.js by default and don't mix the two strategies across components.

## 3. Data model

**Contact** `[Phase 1]` — the only entity Phase 1 needs.

| Field | Type | Notes |
|---|---|---|
| Id | Guid | PK |
| Email | string | required, validated server-side |
| Message | string | required |
| Context | string? | optional free-text (e.g. "evaluating for ECRIS integration") |
| CreatedUtc | DateTime | set server-side, not client-supplied |

**Marketplace** `[Phase 2, deferred — kept here as the plan, not built in Phase 1]`

| Field | Type | Notes |
|---|---|---|
| Id | Guid | PK |
| Name | string | required |
| SourceUrl | string | required |
| SourceType | enum `npm` \| `github` | |
| Description | string? | nullable |
| LastRefreshedUtc | DateTime | set by ingestion job |
| LastRefreshStatus | enum `ok` \| `stale` \| `failed` | `stale` = last attempt failed but previous good data is kept, per XCOD-35's "unreachable source doesn't corrupt last-known-good data" requirement |
| PluginCount | int | computed, not stored |

**Plugin** `[Phase 2, deferred]`

| Field | Type | Notes |
|---|---|---|
| Id | Guid | PK |
| MarketplaceId | Guid | FK → Marketplace |
| Name | string | required |
| Description | string? | |
| SourceType | enum `npm` \| `github` | inherited from parent marketplace entry but stored denormalized for query simplicity |
| SourceRef | string | npm package name, or `owner/repo` for GitHub |
| HomepageUrl | string? | |
| LastSeenUtc | DateTime | updated each ingestion pass; used to detect plugins dropped from a source |

`InstallCommand` is **not** stored — it's derived at the DTO layer as `` `lunos plugin install ${name}` `` so the CLI syntax only has to change in one place if it ever does.

## 4. API contract

All responses are JSON. All list endpoints share this envelope:

```json
{ "items": [ /* DTOs */ ], "total": 0, "page": 1, "pageSize": 20 }
```

All errors share this envelope, with the matching HTTP status code:

```json
{ "error": { "code": "not_found", "message": "Plugin not found." } }
```

This envelope must also be what an **unhandled** exception produces, not just the errors each endpoint raises deliberately — register a global exception handler (`UseExceptionHandler` mapping to the same `{ error: { code, message } }` shape, `code: "internal_error"`, no stack trace in the response body) in `Program.cs` before any endpoints are mapped. Without this, an unexpected exception falls through to ASP.NET Core's default developer-exception page or a bare 500, breaking the "every error is this shape" contract the Angular error states in §5 depend on.

**Logging**: structured logging via the built-in `ILogger` (Console + a rolling file sink under a `Logs/` folder next to the site, since there's no centralized log aggregation on a single self-hosted box) — request path, status code, and duration per request at minimum, plus every ingestion run's outcome (source, duration, `ok`/`stale`/`failed`). This is what makes `LastRefreshStatus` and `/health` debuggable after the fact instead of only in the moment.

**CORS policy** (named, not the permissive default): allow origins `https://lunos.tech` (and `http://localhost:4200` only under `Development`), methods `GET, POST, OPTIONS`, standard headers, `AllowCredentials` **false** — the site has no auth/cookies, so credentialed CORS is unnecessary surface area.

**Phase 1**

| Method & path | Query params | Success | Notes |
|---|---|---|---|
| `POST /api/v1/contact` | body: `{ "email": string, "message": string, "context": string? }` | 201, `{ "id": guid }` | 400 with `error.code = "validation_error"` and a `fields` map if email/message fail validation; not rate-limited in v1 but the handler should be structured so a rate limiter is a one-line addition later |
| `GET /health` | — | 200 `{ "status": "ok", "dbConnected": true }` | used by `deploy.ps1`'s smoke test — must return 200 only when the DB is actually reachable, not just when the process is up. `lastIngestionRunUtc` is added to this response in Phase 2, once there's a job to report on — omit it in Phase 1 rather than hardcoding a fake value |

**Phase 2** `[deferred]`

| Method & path | Query params | Success | Notes |
|---|---|---|---|
| `GET /api/v1/marketplaces` | `page`, `pageSize` (default 1/20, max 100) | 200, list envelope of Marketplace DTOs | |
| `GET /api/v1/marketplaces/{id}` | — | 200, Marketplace DTO + `plugins: PluginSummary[]` | 404 if not found |
| `GET /api/v1/plugins` | `q` (optional), `sourceType` (optional, `npm`\|`github`), `marketplaceId` (optional guid), `page`, `pageSize` | 200, list envelope of Plugin DTOs | |
| `GET /api/v1/plugins/search` | `q` (required) | same shape as `/plugins` | 400 if `q` missing/empty |
| `GET /api/v1/plugins/{id}` | — | 200, full Plugin DTO | 404 if not found |

Pagination, `q`, and error shapes are identical across every list endpoint on purpose — when Phase 2 starts, an agent implementing the second and third endpoint should copy the first, not reinvent it. The shared envelope and global exception handler below apply to both phases equally.

## 5. Angular route table & required states

| Route | Component | Phase | Notes |
|---|---|---|---|
| `/` | HomeComponent | 1 | |
| `/product` | ProductComponent | 1 | renders parity table |
| `/roadmap` | RoadmapComponent | 1 | |
| `/docs` | DocsInstallComponent | 1 | install command + terminal GIF |
| `/sovereignty` | SovereigntyComponent | 1 | |
| `/faq` | FaqComponent | 1 | |
| `/changelog` | ChangelogComponent | 1 | |
| `/contact` | ContactComponent | 1 | design-partner capture form, calls `POST /contact` |
| `/about` | AboutComponent | 1 | |
| `/license` | LicenseComponent | 1 | |
| `/marketplace` | MarketplaceListComponent | **2** | not routed/built in Phase 1 |
| `/marketplace/:id` | MarketplaceDetailComponent | **2** | not routed/built in Phase 1 |
| `/plugins` | PluginListComponent | **2** | not routed/built in Phase 1; reads `q`/`sourceType`/`page` from query params, not just component state, once it exists |
| `/plugins/:id` | PluginDetailComponent | **2** | not routed/built in Phase 1 |
| `**` | NotFoundComponent | 1 | |

The nav bar (§6) omits the Marketplace link entirely in Phase 1 — don't ship a nav item pointing at a route that 404s. Every Phase 1 component that calls the API (just the contact form's submit, for now) must implement all four of: **loading**, **loaded**, **empty**, **error** (request failed — show a retry action, not a blank page); the same four-state rule applies to the marketplace/plugin components when Phase 2 builds them.

## 6. Visual design system

Direction: **"Moonlit Cove"** — carries the TUI's own splash identity (XCOD-3/XCOD-6/XCOD-37) into the website rather than inventing a separate look. Canonical visual reference (build against this, don't re-derive it from prose): **[Moonlit Cove UI](https://claude.ai/artifact/8o73HhWXaTDu1THSsShsVF)**.

**Decision: dark-only, no light theme.** The scene is a night sky by design — a light variant would undercut the concept. Every page ships the palette below as literal values (not a `prefers-color-scheme` swap); if a light mode is ever wanted later, it's a second token set built the same way, using Catppuccin Latte (the official companion palette to Mocha) as the base — not an ad hoc invention.

**Color tokens** (Catppuccin Mocha, standard hex values — define these once as CSS custom properties in `src/styles/tokens.scss` and consume everywhere, never inline a hex in a component):

| Token | Hex | Role |
|---|---|---|
| `--base` | `#1e1e2e` | page background |
| `--mantle` | `#181825` | recessed panels, terminal/browser chrome |
| `--crust` | `#11111b` | deepest background (hero sky top, nav text-on-accent) |
| `--surface0` | `#313244` | card fill |
| `--surface1` | `#45475a` | card/input borders |
| `--surface2` | `#585b70` | stronger borders, dividers |
| `--overlay0` / `--overlay1` | `#6c7086` / `#7f849c` | muted chrome (window dots, disabled text) |
| `--text` | `#cdd6f4` | primary text |
| `--subtext1` / `--subtext0` | `#bac2de` / `#a6adc8` | secondary/tertiary text |
| `--mauve` | `#cba6f7` | primary accent — CTAs, links, active chip, GitHub-source badge |
| `--blue` | `#89b4fa` | secondary accent — npm-source badge |
| `--sapphire` | `#74c7ec` | section eyebrows, water highlights |
| `--peach` / `--yellow` | `#fab387` / `#f9e2af` | moon glow, warm highlight text |
| `--green` | `#a6e3a1` | status/sync-ok dot (semantic — never used as a second brand accent) |
| `--lavender` | `#b4befe` | cloud fill |

**Typography**: two Google Fonts roles, no third face.
- Display/label/code — **JetBrains Mono** (weights 400/500/600/700). Used for the wordmark, nav CTA, section eyebrows, card tags, all badges, and anything that echoes the terminal (install commands, the marketplace URL bar). Chosen because it's literally a coding-tool font, not a generic display face.
- Body — **IBM Plex Sans** (weights 400/500/600). Everything else: paragraphs, nav links, card copy, form inputs.

**Layout components** (build each as a shared Angular component in `shared/`, not re-implemented per page):

- **Nav bar**: wordmark left (`lunos`, mono, 700), links center, a mono-labeled primary CTA right (`$ install` or similar), collapses links below 640px.
- **Hero / moonlit scene**: eyebrow line (mono, uppercase, `--sapphire`) → wordmark (mono, 700, clamp 40–72px) → one-line tagline → the scene itself (a purely decorative `aria-hidden` element: two blurred cloud shapes in `--lavender`, a radial-gradient moon in peach/yellow with a soft box-shadow glow, a water band below a hairline waterline, and a reflection ellipse that shimmers — opacity `0.4 → 0.95 → 0.4` over `2.6s`, matching the TUI's own animation timing exactly, disabled under `prefers-reduced-motion`) → a terminal-chrome card showing the real install command with a blinking mono cursor.
- **Sovereignty strip**: a full-width band (`--mantle` background, bordered top/bottom) stating the self-hosting claim as fact, not slogan — this is the one place a warm accent color (`--peach`) is allowed to color inline text for emphasis.
- **Feature card**: a mono "phase" tag pill (`--mauve` fill, `--crust` text) + heading + one sentence of body copy, laid out in a 2-up grid (1-up under 640px). Content comes from the roadmap's phase/parity data, never invented.
- **Marketplace screen** `[Phase 2, deferred]`: framed like a browser window (dot-chrome bar + a mono URL pill) so it visually reads as "a different page/route," not another card on the same page. Inside: a search input + filter chips (`All`/`npm`/`github`, active chip filled `--mauve`), then a 2-up grid of plugin cards — name (mono, 600) + source badge (`npm` in translucent `--blue`, `github` in translucent `--mauve` — color is a secondary cue, the label text is always shown) + one-line description + a small `--green` sync dot with "synced Nm ago," surfacing the ingestion job's freshness the same way the CLI's own staleness indicator does. Already designed in the reference — just not built until Phase 2.
- **Footer**: single centered line, wordmark in mono + domain, muted color.

Every component above already exists, styled, in the published reference — implementing this section means matching that page's CSS values and structure in Angular, not redesigning from the token table alone. Phase 1 builds everything except the marketplace screen component.

## 7. Configuration

`Lunos.Web/src/environments/environment.production.ts`:
```ts
export const environment = {
  production: true,
  apiBaseUrl: 'https://api.lunos.tech/api/v1'
};
```

`Lunos.Api/appsettings.Production.json`:
```json
{
  "ConnectionStrings": { "MarketplaceDb": "Data Source=D:\\lunos-data\\marketplace.db" },
  "Cors": { "AllowedOrigins": [ "https://lunos.tech" ] },
  "Ingestion": { "IntervalMinutes": 60 }
}
```

The SQLite file path lives outside the IIS site's physical path (`D:\lunos-data\...`, not under `C:\inetpub\lunos-api`) so a `deploy.ps1` run that replaces the site folder never touches the database.

## 8. Acceptance criteria (pattern — replicate per feature)

Every AC below (and every one an agent writes following this pattern) must land as an **executable test**, not just a prose checklist — `Lunos.Api.Tests` (xUnit, one test class per endpoint group, using EF Core's SQLite in-memory provider so tests don't touch the real dev/prod database file) for the API-side criteria, and Angular's own test runner for component-level states (loading/empty/error rendering). Pin whichever runner Angular 22's `ng new` scaffolds by default into `angular.json` explicitly rather than leaving it ambient — Angular's legacy Karma runner has been phased out in recent CLI versions in favor of Vitest/Web Test Runner, and an agent shouldn't have to guess which one this workspace uses. A feature isn't "done" per §10's build order until its AC has a passing automated test, not just a manual check.

**Phase 1**
- **Health check**: Given the SQLite file is missing or locked, when `/health` is called, then it returns non-200 (not a 200 with `dbConnected: false`) — the deploy script's smoke test only checks the status code.
- **Contact form**: Given a valid email and message, when submitted, then the record is persisted server-side and the form shows a success state; given an invalid email, the form blocks submission client-side with an inline error, no request sent.

**Phase 2** `[deferred]`
- **Plugin search**: Given the marketplace has plugins named "eslint-plugin-foo" and "prettier-bar", when a user searches `q=eslint`, then only "eslint-plugin-foo" is returned, `total` reflects the filtered count (not the full table), and the page shows result count text ("1 result for 'eslint'").
- **Empty search**: Given a search matches nothing, when the API returns `items: [], total: 0`, then the UI shows an explicit "no plugins matched" empty state, not a blank list or a spinner stuck on loading.
- **Marketplace ingestion failure**: Given a marketplace source is unreachable during a scheduled ingestion run, when the run completes, then that marketplace's `LastRefreshStatus` becomes `failed`, its previously-ingested plugins are **not** deleted, and `/health`'s `lastIngestionRunUtc` still advances (the job ran, it just partially failed).

## 9. IIS setup checklist (literal, not prose)

1. Install ASP.NET Core Hosting Bundle (includes ASP.NET Core Module v2) and the URL Rewrite module on the Windows box.
2. Create folder `C:\inetpub\lunos-web` and `C:\inetpub\lunos-api`; create `D:\lunos-data` for the SQLite file, grant the API's app pool identity modify rights on `D:\lunos-data` only.
3. Create app pool `Lunos.Web` — No Managed Code, and app pool `Lunos.Api` — No Managed Code (ASP.NET Core Module handles the runtime, not the classic CLR).
4. Create IIS site `Lunos.Web`: physical path `C:\inetpub\lunos-web`, binding `https://lunos.tech` (+ `http://lunos.tech` redirecting to https), app pool `Lunos.Web`.
5. Create IIS site `Lunos.Api`: physical path `C:\inetpub\lunos-api`, binding `https://api.lunos.tech`, app pool `Lunos.Api`.
6. Install TLS certificates for both bindings (win-acme against Let's Encrypt, one cert per hostname or a SAN cert covering both).
7. Confirm DNS: `lunos.tech` and `api.lunos.tech` A/CNAME records point at the box's reachable address before any of the above matters.
8. Run `deploy.ps1` against a `build.ps1` artifact; confirm `https://lunos.tech` loads and `https://api.lunos.tech/health` returns 200.

## 10. Suggested build order (agent-consumable tickets)

**Phase 1**

1. `Lunos.Api` skeleton: solution/project structure, EF Core + SQLite wired up, Contact entity + migration, global exception handler + CORS policy per §4.
2. `POST /api/v1/contact` and `GET /health` per §4, with the shared error envelope.
3. `Lunos.Web` skeleton: routing table per §5 (Phase 1 routes only), `tokens.scss` + shared components per §6 built once (nav — no marketplace link yet, hero scene, footer), shared HTTP service calling `apiBaseUrl`, loading/empty/error state pattern.
4. Marketing content pages (§7 of the PRD) — static content, can run in parallel with 3.
5. Contact page wired to the live `POST /contact` endpoint, all four states per §5.
6. `build.ps1` / `deploy.ps1` per the PRD, run once against a real IIS box per §9 above — this is the "in the air" milestone.
7. Build-time prerendering (per the PRD's corrected §8 — no live SSR/Node server) + WCAG pass (PRD's M2) — deliberately last, after functional correctness.

**Phase 2** `[deferred — starts only once the §13 blockers below are resolved]`

8. Marketplace + Plugin entities, migration, seed data (a few fake rows) for local dev; extend `/health` with `lastIngestionRunUtc`.
9. `GET /marketplaces`, `GET /marketplaces/{id}`, `GET /plugins`, `GET /plugins/search`, `GET /plugins/{id}` per §4.
10. Ingestion `IHostedService` per XCOD-35's existing logic — implement against seed data first, real source resolution second.
11. Marketplace + plugin pages built, wired to the live API, nav link re-enabled.

## 11. Guardrails for the agent

- **Don't build any Phase 2 item in Phase 1.** No `Marketplace`/`Plugin` entities, no `Endpoints/Marketplace*`/`Endpoints/Plugin*`, no `Ingestion/`, no marketplace routes or nav link — the whole point of the re-phase is a small, fast, shippable Phase 1; scope creep here defeats it.
- Don't add authentication, plugin publishing, or write endpoints beyond `POST /contact` — out of scope per the PRD's non-goals; a ticket that seems to need one should stop and flag it rather than add it.
- Don't introduce a second data store or an ORM beyond EF Core + SQLite without it being a stated decision.
- Don't route Angular → API calls through any same-origin proxy path or IIS rewrite rule — cross-origin + CORS only, per the PRD's "no reverse proxy" scope decision.
- `[Phase 2]` Reuse the existing ingestion/resolution logic from the XCOD-34/35 dev-staging implementation where it exists rather than re-deriving marketplace/plugin resolution from scratch — that source isn't included anywhere in this doc set (see §13), so this only becomes actionable once it's handed over; don't guess at it when Phase 2 starts either.
- Don't invent colors, fonts, or component styling outside §6 — match the published reference, don't reinterpret it.

## 12. Local development & first-deploy database setup

- `Lunos.Web/src/environments/environment.ts` (dev): `apiBaseUrl: 'https://localhost:5443/api/v1'` (or whatever port `dotnet run` binds — pin it in `launchSettings.json` so it's not ambient).
- `Lunos.Api/appsettings.Development.json`: `ConnectionStrings:MarketplaceDb` pointing at a local SQLite file under the repo (e.g. `./data/marketplace.dev.db`, gitignored), `Cors:AllowedOrigins` including `http://localhost:4200`.
- EF Core migrations run automatically on startup (`db.Database.Migrate()` in `Program.cs`) rather than requiring a manual step — this is what makes the first production deploy create `D:\lunos-data\marketplace.db` correctly with no separate DBA step; `deploy.ps1`'s health check after restart is what confirms this worked.
- `[Phase 2]` A `Data/SeedData.cs` (dev-only, gated behind `IsDevelopment()`) inserts a handful of fake marketplaces/plugins so `Lunos.Web` has something to render locally before the real ingestion job or XCOD-34's seed catalog is wired up — not needed until Phase 2, since Phase 1 has no marketplace data to seed.

## 13. What this spec still doesn't cover — needs your input, not an agent's guess

Visual identity is resolved as of §6. Splitting off Phase 2 removed it from Phase 1's critical path, but two items still block Phase 1 shipping, and the rest only matter once Phase 2 starts:

**Blocking Phase 1 (§10 steps 1–7):**

- **License isn't decided** — the GTM plan flags this as needing an explicit statement but never names one. The License page has nothing to render until that decision exists.
- **Actual marketing copy**: the PRD says pages source content "from `product-vision-roadmap.md`/the GTM plan," but no approved copy blocks exist yet for every page (Home's hero copy is drafted in the §6 reference; FAQ, Sovereignty & Compliance, About, Changelog, and others aren't). An agent building those today would be drafting filler text under your name. Worth writing (or approving agent-drafted, then locking) real copy per page before it counts as "done," separately from its technical implementation.

**Blocking Phase 2 only (§10 steps 8–11) — no urgency, doesn't hold up Phase 1:**

- **Marketplace manifest schema and ingestion resolution mechanics aren't defined here.** XCOD-8's manifest format and XCOD-34/35's actual npm/GitHub resolution logic live outside this doc set. §11's guardrail says "reuse, don't re-derive" — that only works if the real schema/source gets handed over before Phase 2 starts.
- **No production seed list** — which marketplace sources the live site registers on day one (XCOD-9's actual catalog) isn't reproduced anywhere in these docs.
