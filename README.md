# Lunos Website

Two independently deployable projects:
- `Lunos.Web/` — Angular 22 marketing site (zoneless, standalone, prerendered marketing routes)
- `Lunos.Api/` — .NET 10 minimal API (SQLite-backed), Phase 1 scope: `POST /api/v1/contact`, `GET /health`

## Local development

- API: `cd Lunos.Api/Lunos.Api && dotnet run` (binds `https://localhost:5443` per `launchSettings.json`)
- Web: `cd Lunos.Web && npm ci && npx ng serve` (binds `http://localhost:4200`, calls the API above via `environment.ts`)

## Build & deploy

- `./build.ps1` — produces a versioned zip under `./artifacts/`
- `./deploy.ps1 -ArtifactZip <path>` — run on the target IIS box as Administrator; see `docs/lunos-website-technical-spec.md` §9 for the one-time IIS provisioning checklist.
