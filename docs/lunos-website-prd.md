# Lunos Official Website & Hosted Marketplace — Product Requirements Document

Owner: Petar Minev (product owner) · Drafted: 2026-09-15 · Status: Draft v0.1 · Domain: **lunos.tech**
Related: `product-vision-roadmap.md`, `lunos-marketing-gtm-plan.md`, `lunos-splash-and-marketplace.md`, Jira epics XCOD-21 (marketing/GTM), XCOD-32 (registry backend), XCOD-7 (marketplace client)

> **Re-phased 2026-09-15**: marketplace hosting is now **Phase 2, deferred**. Phase 1 is the marketing site plus a minimal contact backend, scoped to ship fast. Everything marketplace-related below is kept (not deleted) as the Phase 2 plan, and marked `[Phase 2]` throughout — it's already-done design work, no sense discarding it, it just isn't what gets built first.

## 1. Purpose

lunos.tech is the public face of the Lunos project. **Phase 1** ships the marketing/landing site the GTM plan calls for (XCOD-25) — positioning, docs, roadmap, FAQ, design-partner capture — plus the small backend it needs for the contact form. **Phase 2** `[deferred]` makes lunos.tech also the production host for the plugin marketplace registry (XCOD-36, currently "works in dev/staging, nothing points at it yet"), consolidating that with the marketing site's backend under `api.lunos.tech` instead of standing up a separate hosted service.

Splitting it this way means Phase 1 has no dependency on the marketplace's open questions (§12) — none of the manifest-schema/seed-data/ingestion gaps block getting the site live.

## 2. Goals

**Phase 1**
- Give the project a real public address at lunos.tech that a developer, journalist, or procurement reviewer can land on (closes the "there is currently nothing to market" gap flagged in the GTM plan).
- Ship it on infrastructure Lunos actually controls (a self-hosted Windows/IIS box), which doubles as a live demonstration of the sovereignty pitch: the project's own site isn't running on US cloud infra either.
- Keep frontend and backend as independently deployable projects with a straightforward, scriptable build → hand-off → deploy flow, since there's no CI runner on the target machine yet — this pays off again in Phase 2 without rework.
- Get something live fast — this is the explicit driver for the re-phase: don't let the marketplace's open questions hold up a site that doesn't need them.

**Phase 2** `[deferred]`
- Make the plugin marketplace browsable on the web, not just through the CLI/TUI — turning the existing `GET /marketplaces`, `GET /plugins`, `GET /plugins/search` contract (XCOD-33) into a public product surface.

## 3. Non-goals

**Phase 1**
- No marketplace browsing/search UI, no registry API, no ingestion job — that's all Phase 2 (§ throughout, marked `[Phase 2]`).
- No admin/CMS UI — content pages are static Angular content, not a database-backed CMS.
- No user accounts, login, or personalization.
- No multi-region/HA hosting — single Windows box.

**Phase 2** `[deferred]`
- No plugin publishing/moderation flow — the marketplace stays read-only on the web (browse/search), matching the CLI/TUI scope already shipped (XCOD-7 explicitly scoped out publisher auth/moderation).

## 4. Scope decisions and assumptions (stated, not blocking)

- **Naming**: XCOD-22 (the naming-freeze decision) was still open as of the last release notes, flagged specifically because "Lunos" collides with a funded startup at lunos.ai. Choosing the domain **lunos.tech** for this PRD is, in effect, a vote to keep the name — I'm proceeding on that basis since you specified the domain, but this should get a formal close on XCOD-22 before anything here goes live publicly, not after.
- **Registry hosting relocation**: XCOD-33's hosting/API-contract decision was written "evaluated explicitly against Lunos's EU-sovereignty positioning rather than defaulting to US-region infra" — I don't have that decision's actual conclusion in the project docs I can see. This PRD assumes the conclusion is compatible with (or is superseded by) self-hosting on your Windows/IIS box. Worth a quick sanity check against whatever XCOD-33 actually landed on before build starts, so we're not quietly overriding a decision that had different reasoning behind it.
- **Data store for marketplace data**: not specified anywhere upstream. For a single self-hosted Windows box I'm assuming **SQLite** (zero extra install, file-based, trivial backup) rather than SQL Server, with room to swap to SQL Server Express later if concurrent write volume ever justifies it. Flag if engineering already committed to something else in XCOD-34.
- **"No reverse proxy"**: read as — don't put IIS ARR/YARP/nginx in front to merge frontend and API under one origin. Architecture below keeps them as two independent IIS sites/origins with CORS between them, not a proxied single origin.
- **Public reachability of a home/office Windows box**: out of this PRD's architecture scope but flagged as a real feasibility risk in §9 — a public domain pointing at non-datacenter infrastructure needs a static IP or dynamic DNS, port forwarding, and an uptime story that a plain dev machine doesn't have by default.

## 5. Audiences

Same priority order as the GTM plan, since this site is those audiences' first touchpoint:

1. EU public-sector integrators and GovTech/civic-tech developers.
2. opencode contributors and Claude Code users evaluating Lunos for parity features.
3. EU regulated-enterprise engineering teams for whom US-hosted tooling is a procurement blocker.
4. EU OSS/digital-sovereignty policy circles (Digital SME Alliance, EuroStack-adjacent) — amplifiers, not direct users.

## 6. Site map

| Section | Pages | Phase | Notes |
|---|---|---|---|
| Marketing | Home, Product/Features (parity table from the roadmap doc), Roadmap, Docs/Install, Sovereignty & Compliance, FAQ ("why fork opencode"), Changelog / build-in-public log, Design-partner / Contact, About, License | **1** | Content sourced from `product-vision-roadmap.md` and the GTM plan's foundations checklist (§4 of that doc) |
| Marketplace | Browse marketplaces, Browse/search plugins, Plugin detail, Marketplace source detail | **2** `[deferred]` | Public read-only UI over the registry API — not built, not linked from nav, until Phase 2 |
| System | 404, health/status (internal-facing, not linked in nav) | **1** | |

## 7. Functional requirements

**Marketing site** `[Phase 1]`
- Home states the one-liner and sovereignty hook verbatim from the GTM plan (§3 of that doc), links to install docs; the marketplace link in nav/footer waits until it's actually built (see §6 — don't link to a page that doesn't exist yet).
- Docs/Install page ships a working install command and a terminal recording/GIF — this is explicitly called out in the GTM plan as the single highest-leverage marketing asset for a dev tool; don't ship this page without it.
- Roadmap page mirrors the five-phase roadmap and current shipped/in-progress state (i.e., stays in sync with the release notes — worth generating this page's content from the same source as the Jira-derived release notes rather than hand-duplicating it).
- Design-partner/Contact page captures an email + a short "what are you evaluating this for" field, feeding XCOD-29's private outreach list — this is the one page that needs a backend in Phase 1 (see §8).
- License statement is explicit on its own page, not just in a repo LICENSE file (GTM plan §4 calls this out specifically for enterprise trust).

**Marketplace (public)** `[Phase 2, deferred]`
- Browse marketplaces: list of added marketplace sources with plugin counts and last-refreshed time (surface the ingestion job's staleness indicator publicly — it's a trust signal, not just an internal ops detail).
- Browse/search plugins: filter by source type (`npm`/`github`), free-text search, paginated list.
- Plugin detail: name, description, source link, source type, install command shown ready to copy (`lunos plugin install <name>`), marketplace it came from, last-refreshed time.
- Marketplace source detail: which plugins it contributes, source URL, freshness.
- All of this reads from `api.lunos.tech` using the existing `GET /marketplaces`, `GET /plugins`, `GET /plugins/search` contract from XCOD-33 — no new API surface needs designing when this phase starts, only implementing against the already-agreed contract.

## 8. System architecture

Two independently deployable projects, two independent IIS sites/origins on the same physical Windows box — no reverse proxy merging them:

```
lunos.tech          → IIS Site "Lunos.Web"  → Angular static build output (Lunos.Web project)
api.lunos.tech       → IIS Site "Lunos.Api"  → ASP.NET Core Web API, in-process hosting (Lunos.Api project)
```

**Lunos.Web** (Angular, latest stable — Angular 22 as of this writing, signals-first, standalone components, no NgModules)
- Pure static output (`ng build --configuration production`) served directly by IIS as static files — this rules out live server-side rendering, since a Node SSR server is a runtime IIS would have to proxy to, which contradicts §4's "no reverse proxy" decision.
- **Correction from the original draft**: for SEO, use Angular's **build-time prerendering** (`ng build` with `outputMode: static` / the prerender builder, generating static HTML per marketing route at build time), not `@angular/ssr`'s live server-rendering mode — prerendering ships plain HTML files IIS serves exactly like the rest of the bundle, no Node process involved. The GTM plan's channel strategy (Show HN, Reddit, Fosstodon, search) depends on marketing pages being crawlable; a client-side-only SPA renders empty to a crawler that doesn't execute JS, and prerendering solves that without adding a server runtime. Marketplace browse pages stay client-rendered since they're data-driven and less SEO-critical.
- Calls `api.lunos.tech` directly over HTTPS with CORS, not through any same-origin proxy path.
- `web.config` in the site root uses IIS URL Rewrite **only** for Angular client-side routing fallback (rewrite unmatched paths to `index.html`) — this is a same-app SPA-routing rule, not a reverse proxy to the API, and is the one IIS Rewrite use that's appropriate here.

**Lunos.Api** (.NET, latest LTS — .NET 10 as of this writing)
- ASP.NET Core Web API, hosted via the ASP.NET Core Module v2 in-process on its own IIS site/app pool.
- **Phase 1 scope is deliberately small**: `POST /contact` and `GET /health` only, backed by SQLite (see §4) for contact submissions. Standing up the full two-project/two-IIS-site architecture now — even for a backend this thin — means Phase 2 adds the marketplace tables and ingestion job to an already-deployed, already-working API instead of standing up new infrastructure later.
- `[Phase 2, deferred]` Owns the marketplace registry: the read endpoints (`/marketplaces`, `/plugins`, `/plugins/search`) plus the scheduled ingestion job (XCOD-35's re-resolve-every-source job) running as an `IHostedService`/background service inside the same process — no separate registry microservice, since it's one self-hosted box.
- CORS policy restricted to `https://lunos.tech` (and any staging origin) — nothing wide-open.
- A `/health` endpoint for the deploy script's post-deploy smoke test (see §10) — needed from day one regardless of phase.

## 9. Non-functional requirements

- **Security**: HTTPS-only on both sites (IIS bindings + certificate — automate renewal with `win-acme` for Let's Encrypt rather than a manual yearly cert chore), locked-down CORS on the API, standard input validation/rate limiting on search endpoints.
- **Accessibility**: the roadmap originally scoped a WCAG pass for Phase 4 (TUI/desktop/web). Pulling a basic WCAG 2.1 AA pass into this site now is cheap relative to doing it later across three surfaces, and a public-sector-facing site is exactly where accessibility compliance gets checked first.
- **Performance**: prerendered marketing pages for fast first paint and crawlability; lazy-loaded marketplace module so the marketing bundle stays small.
- **Observability**: basic structured logging on the API, the `/health` endpoint above, and surfacing the ingestion job's last-run status/staleness (already planned per XCOD-13's client-side caching pattern — same signal, now exposed server-side too).
- **Sovereignty narrative**: worth stating as a requirement, not just a side effect — the deployment doc/FAQ page should say plainly that the official site itself runs on self-hosted EU infrastructure, since that's a genuine, checkable proof point for the positioning in §3 of the GTM plan.

## 10. Hosting, build, and deploy

**Target environment**: Windows Server (or Windows 10/11 Pro) with IIS, ASP.NET Core Hosting Bundle (includes ASP.NET Core Module v2) and the URL Rewrite module installed. Two IIS sites as in §8, each its own app pool (No Managed Code / "No Managed Code" CLR for the API app pool, since ASP.NET Core doesn't run in-process CLR the classic way — standard ASP.NET Core-on-IIS setup).

**Build vs. deploy split**, since binaries are built off-box and handed to the IIS machine rather than built there:

- `build.ps1` — run wherever the source is built (dev machine or a future CI runner): builds the Angular production bundle and publishes the .NET API, drops both into a single versioned, zippable artifact folder.
- `deploy.ps1` — run on the IIS box against that artifact: stops the app pools, backs up the currently-deployed folders, copies the new build in, restarts the app pools, and hits `/health` to confirm the API came back up.

```powershell
# build.ps1 — run from the repo root; produces ./artifacts/<version>/{web,api}
param(
    [string]$Version = (Get-Date -Format "yyyyMMdd-HHmmss")
)

$ErrorActionPreference = "Stop"
$artifactRoot = Join-Path $PSScriptRoot "artifacts\$Version"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

Write-Host "Building Lunos.Web (Angular)..."
Push-Location "$PSScriptRoot\Lunos.Web"
npm ci
npx ng build --configuration production --output-path "$artifactRoot\web"
Pop-Location

Write-Host "Publishing Lunos.Api (.NET)..."
dotnet publish "$PSScriptRoot\Lunos.Api\Lunos.Api.csproj" `
    -c Release `
    -o "$artifactRoot\api" `
    --runtime win-x64 `
    --self-contained false

"$Version" | Out-File -Encoding utf8 (Join-Path $artifactRoot "version.txt")

Write-Host "Zipping artifact..."
Compress-Archive -Path "$artifactRoot\*" -DestinationPath "$PSScriptRoot\artifacts\lunos-$Version.zip" -Force

Write-Host "Done: artifacts\lunos-$Version.zip"
```

```powershell
# deploy.ps1 — run ON the IIS box, as Administrator, against a build.ps1 artifact zip
param(
    [Parameter(Mandatory = $true)][string]$ArtifactZip,
    [string]$WebSitePath = "C:\inetpub\lunos-web",
    [string]$ApiSitePath = "C:\inetpub\lunos-api",
    [string]$WebAppPool  = "Lunos.Web",
    [string]$ApiAppPool  = "Lunos.Api",
    [string]$BackupRoot  = "C:\inetpub\_backups",
    [int]$KeepBackups    = 5
)

Import-Module WebAdministration
$ErrorActionPreference = "Stop"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$extractPath = Join-Path $env:TEMP "lunos-deploy-$stamp"
Expand-Archive -Path $ArtifactZip -DestinationPath $extractPath -Force

Write-Host "Stopping app pools..."
Stop-WebAppPool -Name $WebAppPool
Stop-WebAppPool -Name $ApiAppPool

function Backup-AndReplace($source, $target, $label) {
    $backupDir = Join-Path $BackupRoot "$label-$stamp"
    if (Test-Path $target) {
        Write-Host "Backing up $label to $backupDir"
        Copy-Item -Path $target -Destination $backupDir -Recurse -Force
    }
    Write-Host "Deploying $label..."
    robocopy $source $target /MIR /R:3 /W:5 | Out-Null
}

Backup-AndReplace "$extractPath\web" $WebSitePath "web"
Backup-AndReplace "$extractPath\api" $ApiSitePath  "api"

# prune old backups, keep newest $KeepBackups per label
foreach ($label in @("web", "api")) {
    Get-ChildItem $BackupRoot -Directory -Filter "$label-*" |
        Sort-Object CreationTime -Descending |
        Select-Object -Skip $KeepBackups |
        Remove-Item -Recurse -Force
}

Write-Host "Starting app pools..."
Start-WebAppPool -Name $WebAppPool
Start-WebAppPool -Name $ApiAppPool

Start-Sleep -Seconds 5
try {
    $health = Invoke-RestMethod -Uri "https://api.lunos.tech/health" -TimeoutSec 15
    Write-Host "API health check OK: $health"
} catch {
    Write-Warning "API health check FAILED after deploy — investigate before announcing this release."
}

Remove-Item $extractPath -Recurse -Force
Write-Host "Deploy complete."
```

Treat these as a working starting point, not a finished pipeline — they don't yet handle IIS site/app-pool creation (one-time provisioning script, separate concern) or automated rollback beyond the kept backups.

## 11. Milestones

**Phase 1**
- **M1 — Marketing site + contact form live**: Angular marketing pages (§7), `Lunos.Api` serving just `/contact` and `/health`, deployed via the scripts in §10 to `lunos.tech`. Closes the "nothing to click through to" gap and most of XCOD-21's child stories (23, 24, 25, 26, 28), contingent on XCOD-22 naming freeze actually closing first. **This is the milestone the re-phase is optimizing for.**
- **M2 — Hardening**: prerendering for SEO, WCAG pass, cert automation, documented backup/restore.

**Phase 2** `[deferred]`
- **M3 — Marketplace live**: `api.lunos.tech` extended with the registry contract and real data, marketplace browse/search/detail pages built and wired up on `lunos.tech`, nav/footer links to it re-enabled. Effectively closes XCOD-36 by giving the registry a real production home. Blocked on the manifest-schema/ingestion-mechanics/seed-list gaps in §12 — none of which need solving before M1/M2 ship.

## 12. Open questions / risks

**Blocking Phase 1 (M1/M2):**

- XCOD-22 (naming freeze) is still open — the site being built now is under a name that might not survive that decision. This is the one Phase-1 blocker worth resolving before real content goes live, not after.
- **License isn't decided.** The GTM plan recommends stating a license explicitly but never names one (only "whatever it's inherited from opencode"). The site's License page (§7, Phase 1) can't be written without that decision existing somewhere first.
- Public reachability from non-datacenter infrastructure (static IP / DDNS, port forwarding, power/ISP uptime) isn't solved by this document and should get its own short decision before M1 ships — this is now the more urgent of the two infra risks, since M1 no longer waits on the marketplace.

**Blocking Phase 2 only (M3) — not urgent, doesn't block M1/M2:**

- **Marketplace manifest schema and resolution mechanics are referenced, not defined.** XCOD-8 ("define the Lunos marketplace manifest format") and the ingestion job's actual npm/GitHub resolution logic (XCOD-34/35) live outside these project docs. Pull the real schema and implementation details in before Phase 2 starts, or explicitly decide it gets re-derived from scratch.
- **No production seed list.** XCOD-9's actual seed marketplace catalog isn't reproduced here — needed before Phase 2 launches, not before Phase 1.
- **Registry hosting reconciliation.** XCOD-33's hosting/API-contract decision was written "evaluated explicitly against Lunos's EU-sovereignty positioning" — its actual conclusion isn't visible in the docs I can see, and this PRD's self-hosted-on-Windows approach should be checked against it before Phase 2, not assumed compatible.
- Marketplace data storage (SQLite assumption, §4) hasn't been confirmed against whatever XCOD-34's dev/staging implementation already uses.

---
Sources consulted for current stack recommendations (Angular 22 signal-first release, .NET 10 LTS): [Angular Latest Version: What Changed and What to Break First](https://arc.dev/employer-blog/angular-latest-version-your-friendly-guide-to-new-features-and-updates-in-2026/), [Angular | endoflife.date](https://endoflife.date/angular), [Microsoft .NET | endoflife.date](https://endoflife.date/dotnet), [The official .NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy)
