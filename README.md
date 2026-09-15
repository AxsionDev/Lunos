# Lunos Website

Two independently deployable projects:
- `Lunos.Web/` — Angular 22 marketing site (zoneless, standalone, prerendered marketing routes)
- `Lunos.Api/` — .NET 10 minimal API (SQLite-backed), Phase 1 scope: `POST /api/v1/contact`, `GET /health`

## Local development

Requires Node `>=22.22.3` (see `.nvmrc`; Angular CLI 22 hard-fails below this version) and `npm`.

- One-time setup: `dotnet dev-certs https --trust` — the API binds HTTPS by default, which requires a trusted local dev certificate.
- API: `cd Lunos.Api/Lunos.Api && dotnet run` (binds `https://localhost:5443` per `launchSettings.json`)
- Web: `cd Lunos.Web && npm ci && npx ng serve` (binds `http://localhost:4200`, calls the API above via `environment.ts`)

## Build & deploy

- `./build.ps1` — produces a versioned zip under `./artifacts/`
- `./deploy.ps1 -ArtifactZip <path>` — run on the target IIS box as Administrator; see `docs/lunos-website-technical-spec.md` §9 for the one-time IIS provisioning checklist.

### Deploying

The `Lunos.Web` IIS site's SPA-fallback URL Rewrite rule must target `index.csr.html`, **not** `index.html`. Build-time prerendering (Task 11) makes `index.html` the actual prerendered home page, not a generic shell — pointing the fallback at it would serve home-page markup (with an Angular hydration mismatch) for every 404 and every future route. `index.csr.html` is the true empty client-side-rendering shell.
