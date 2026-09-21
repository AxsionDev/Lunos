# Handoff — Marketplace Registry → `lunos-web`

**Audience:** agents and contributors working in `pminev1/lunos-web`. You do not need any
familiarity with the Lunos CLI repo to act on this.

**Status:** owner-approved handoff, 2026-09-21. The registry is to be built in `lunos-web`, not in
the Lunos CLI repo. Filed under [XCOD-59](https://axsion.atlassian.net/browse/XCOD-59).

## What the marketplace registry is

An **optional, additional** source of Lunos marketplace/plugin metadata: a small read-mostly HTTP
service that aggregates plugin manifests from upstream sources on a schedule and serves them over
four endpoints. It is not a package host — it stores and serves public metadata (names,
descriptions, source repos), no user data and no artifacts.

It does **not** replace anything. The Lunos CLI already fetches marketplace manifests directly from
a git repo, URL, or local path and caches them locally; the registry is just one more URL a user
can `marketplace add`. Nothing in the CLI has to change for this to ship.

## Decision you must make first: the stack

**This is unresolved and blocks everything else.** The two facts collide:

- The **existing implementation** (see below) is TypeScript on **Cloudflare Workers + D1**, built
  with bun, Effect, and SST — inherited from the Lunos CLI monorepo's toolchain.
- **`lunos-web` is a .NET 10 solution** (`Lunos.Api.sln`, SDK `10.0.103`, `global.json`) with a
  TypeScript web frontend (`Lunos.Web`), built and shipped via `build.ps1` / `deploy.ps1`.

So "port the existing implementation" and "fits the host repo" are not simultaneously satisfiable
as-is. Pick one, explicitly, and record it:

| Option                  | What it means                                                                                                                                                       | Cost                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Port as-is**      | Bring `packages/registry` over as a standalone Cloudflare Worker sub-project alongside `Lunos.Api`. Keeps the tested code and the EU-jurisdiction D1 design intact. | A second toolchain (bun + SST + Wrangler) and a second deploy path in a repo currently built by PowerShell/.NET.                                                 |
| **B — Rewrite in .NET** | Reimplement against the specs in this directory as part of `Lunos.Api`. One stack, one deploy.                                                                      | Discards ~2,700 lines of tested TypeScript. You must re-solve EU data residency yourself — .NET/Azure gives no equivalent of D1's `jurisdiction: "eu"` for free. |

The owner's stated intent is that the reverted implementation **is** the intended starting point
(i.e. leaning A) — but that was answered before the .NET/TypeScript mismatch was known. Confirm
before you invest either way.

## What you are receiving

### 1. Design specs — in this directory, complete

| File                                           | What it covers                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`service-spec.md`](service-spec.md)           | The design decision record: hosting choice, options rejected and why, what the EU claim does and does not guarantee |
| [`api-contracts.md`](api-contracts.md)         | Endpoint-by-endpoint request/response contracts (C-001 … C-00n)                                                     |
| [`api-user-journeys.md`](api-user-journeys.md) | Who calls it and why, end to end                                                                                    |
| [`api-stories.md`](api-stories.md)             | The implementation stories as originally broken down                                                                |
| [`api-overview.md`](api-overview.md)           | Architectural overview                                                                                              |
| [`deployment.md`](deployment.md)               | Original deploy design (Cloudflare/SST-specific — re-read under option B)                                           |

### 2. A working implementation, recoverable from git

It is **not** checked in anywhere. It lives in the Lunos CLI repo's history and must be pulled out:

```sh
git clone https://github.com/AxsionDev/Lunos.git
cd Lunos
git checkout 45a0944778^ -- packages/registry   # 35 files: src + tests
git show 45a0944778^:infra/registry.ts          # SST infrastructure definition
```

`45a0944778` is the commit that removed it; `^` is the last commit where it existed. It was built
and tested under XCOD-34 (read API), XCOD-35 (ingestion job) and XCOD-36 (deploy), all completed.
It has not been built or run since **2026-09-15** and will have drifted from its parent repo.

Shape: `src/router.ts` (exact-match path table, no router library), `src/handlers/*` (one per
endpoint), `src/db.ts` (D1 access behind a `RegistryReadDb` / `RegistryWriteDb` seam),
`src/ingest.ts` + `src/ingest-worker.ts` (scheduled refresh), `src/resolve.ts`, `src/seed.ts`,
`migrations/0001_init.sql`. Every module has a test file beside it.

The code is unusually well-commented about _why_ — the seam exists so handlers are testable with a
fake db and no D1, no miniflare, no deploy. That property is worth preserving under either option.

### 3. Its one external coupling

`packages/registry` depends on `@opencode-ai/core` (`workspace:*`), but uses **exactly one thing**
from it: the `Marketplace` schema from `@opencode-ai/core/marketplace`, imported by `db.ts`,
`resolve.ts` and `seed.ts`.

That module is **54 lines** (`packages/core/src/marketplace.ts`). Vendor it or re-derive it and the
package is otherwise self-contained — there is no deep monorepo entanglement to unpick.

## Already decided — do not re-derive

- **Hosting (under option A):** Cloudflare Worker + D1 created with `jurisdiction: "eu"`. Chosen
  over Enterprise-tier Regional Services (cost), AWS `eu-*` (no reuse of existing tooling), and
  self-hosted EU VPS (new ops surface). Full rationale in [`service-spec.md`](service-spec.md).
- **Scope:** additional/optional source; the client-side marketplace model is untouched.
- **Not in scope for this handoff:** actually standing up or hosting the service. Hosted
  infrastructure is deferred by [XCOD-55](https://axsion.atlassian.net/browse/XCOD-55).

## Claim discipline — please carry this forward

The original spec is careful about a distinction that is easy to lose, and the Lunos project has a
standing rule against overclaiming (XCOD-55):

- `jurisdiction: "eu"` guarantees **the dataset is created and stored in EU infrastructure**.
- It does **not** guarantee every request executes in the EU — a Worker serving a non-EU client may
  run at a non-EU edge location. Restricting _compute_ location is Cloudflare's Enterprise-tier
  Regional Services feature, which was explicitly rejected for v1.

Say "EU-resident data" — not "EU-sovereign infrastructure" or "sovereign cloud", both of which are
ruled out for Lunos by XCOD-55. Under option B the same discipline applies to whatever the .NET
hosting story turns out to be: state what is actually guaranteed.

## Why this document exists

The registry was built in the Lunos CLI repo, then reverted out on 2026-09-15 with a note that
requirements had been "handed off outside this repo." That handoff target was never located — no
successor ticket, no successor doc — leaving ~2,000 lines of design and a tested implementation
reachable only by knowing one commit hash. This file is that handoff, written down.
