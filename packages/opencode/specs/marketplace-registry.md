# Marketplace registry service (design)

Design-only spec for XCOD-33 (child of the new epic XCOD-32, "Lunos Marketplace Registry
Service" — split out of XCOD-14, itself originally a child of the marketplace epic XCOD-7). No
service code or deploy happens in this story; this doc is the contract the next three stories
(XCOD-34 API implementation, XCOD-35 ingestion job, XCOD-36 deploy) build against.

## Status

Decision made. Not yet implemented — implementation is XCOD-34/35/36.

## Why a hosted registry at all

The client-side marketplace model (XCOD-8 through XCOD-13) already works: the CLI/TUI fetch a
manifest straight from wherever it's hosted (git repo, URL, local path) and cache it locally. This
registry is an *additional*, optional marketplace source — one that's centrally aggregated and
kept fresh — not a replacement. Nothing about XCOD-10's `marketplace add <source>` needs to
change: the registry is just another URL a user can add.

## Hosting decision

**Chosen: a Cloudflare Worker (matching the `sst.cloudflare.Worker` pattern already used for
`AuthApi`/`LogProcessor`/`Stat`, in a new package, not `packages/console/function`) with a
Cloudflare D1 database created with `jurisdiction: "eu"`.**

### Options considered

| Option | Verdict | Why |
| --- | --- | --- |
| **Cloudflare Worker + D1, EU jurisdiction** | **Chosen** | Reuses this repo's existing `sst.cloudflare.Worker` construct (already used for `AuthApi`/`LogProcessor`/`Stat` in `infra/console.ts`) and adds `sst.cloudflare.D1`, both already in the toolchain — a new package, not the `console/function` codebase itself, which is billing/auth-specific. D1 and Durable Objects support a `jurisdiction` parameter (`eu`, `fedramp`) that pins where the *data* is created and stored — this is a standard-plan feature, not gated behind an Enterprise contract. |
| Cloudflare Workers, full "Regional Services" (Data Localization Suite) | Rejected for v1 | This is the feature that actually restricts *where compute/TLS termination happens*, not just storage. It's Enterprise-tier only — availability and pricing require contacting Cloudflare's account team ([Regional Services docs](https://developers.cloudflare.com/data-localization/regional-services/)). Disproportionate cost for a v1 service with no revenue model. |
| AWS `eu-central-1`/`eu-west-1` (Lambda + API Gateway + RDS or DynamoDB) | Rejected for v1 | Would work, and is a real AWS EU region, but this repo's existing AWS usage (`sst.config.ts`) is pinned to `us-east-1` for everything else — introducing a second AWS region just for this service adds a distinct deployment path with no reuse of existing infra, for a service that's read-mostly and doesn't need AWS-specific capabilities (Athena, S3 Tables, PlanetScale) the way `infra/stats.ts` does. |
| Self-hosted (Hetzner/OVHcloud/Scaleway, EU data centers) | Rejected for v1 | Most "sovereign" option in the abstract, but means owning a new deployment/ops surface (VPS provisioning, TLS, process supervision, backups) with zero reuse of the SST+Cloudflare tooling every other service in this repo already uses. Worth revisiting only if the Cloudflare D1/jurisdiction approach turns out insufficient in practice. |

### What this decision actually guarantees — and what it doesn't

- **Guaranteed:** the registry's dataset (marketplace/plugin metadata) is created and persists only
  in Cloudflare's EU-jurisdiction infrastructure, per D1's `jurisdiction: "eu"` setting
  ([D1 data location docs](https://developers.cloudflare.com/d1/learning/data-location)).
- **Not guaranteed:** a Worker handling a request from outside the EU may still execute at a
  non-EU Cloudflare edge location — the jurisdiction constraint controls where the D1 database
  itself runs and stores data, not where every invocation of the Worker executes
  ([D1 data location docs](https://developers.cloudflare.com/d1/learning/data-location)).
- **Why that's an acceptable tradeoff for this service specifically:** the registry stores and
  serves public plugin/marketplace metadata (names, descriptions, source repos) — not user
  accounts, credentials, or any personal data. The EU-sovereignty goal is about where Lunos's own
  data lives and is governed, not about restricting which edge node answers an anonymous public
  read. If a future story adds any user-identifying data to this service (e.g. publisher accounts,
  install telemetry — both explicitly out of scope per the parent epic), this tradeoff needs
  re-evaluating against full Regional Services or a different host at that point.

### Implementation risk to verify in XCOD-34 — read before creating any D1 instance

Per [D1's data-location docs](https://developers.cloudflare.com/d1/learning/data-location),
**jurisdiction can only be set at database creation time and cannot be changed afterward.** SST's
`sst.cloudflare.D1` component does not document a `jurisdiction` constructor argument directly —
only a `transform.database` escape hatch to the underlying Cloudflare provider resource
(`D1DatabaseArgs`). Because the constraint is create-time-only and irreversible, XCOD-34 must
confirm *before creating anything* whether that escape hatch actually plumbs `jurisdiction: "eu"`
through to Cloudflare. If it doesn't, the database cannot be created via `sst.cloudflare.D1(...)`
directly — it must instead be created once via `wrangler d1 create --jurisdiction=eu` and then
referenced in SST with `sst.cloudflare.D1.get`, never re-created inline. Creating the DB first and
checking jurisdiction after is not an option; there's no fallback once a non-EU database exists.

### Infra sketch (for XCOD-36)

Following `infra/console.ts`'s existing pattern, but as a new package — `packages/console/function`
is billing/auth/Stripe-adjacent and isn't where a marketplace registry belongs, even though its
*Worker pattern* is the one being reused:

```ts
const registryDb = new sst.cloudflare.D1("MarketplaceRegistryDb" /* jurisdiction: eu, see risk note above */)
export const registry = new sst.cloudflare.Worker("MarketplaceRegistry", {
  domain: `registry.${domain}`,
  handler: "packages/registry/src/index.ts", // new package, mirroring packages/stats/ as its own tree
  url: true,
  link: [registryDb],
})
```

## API contract

Four read-only endpoints. The three registry-native ones below reuse `Marketplace.Entry`/
`Marketplace.Source` from `packages/core/src/marketplace.ts` (XCOD-8) for plugin rows, wrapped in a
registry-specific envelope; the fourth (`GET /marketplace.json`) additionally serves the aggregate
data in the exact `Marketplace.Manifest` shape — see that section below for why both are needed.

### `GET /marketplaces`

Lists every marketplace this registry aggregates.

**Response `200`:**

```json
{
  "marketplaces": [
    {
      "name": "lunos-community",
      "owner": { "name": "Lunos Community", "url": "https://github.com/lunos-community" },
      "description": "Community-curated plugins for Lunos.",
      "pluginCount": 36,
      "source": "https://github.com/pminev1/Lunos"
    }
  ]
}
```

Each entry is the manifest's top-level fields (`name`, `owner`, `description`, `version`) plus
`pluginCount` (a derived summary, not part of the XCOD-8 manifest schema itself — computed by the
registry, mirroring how `marketplace list` shows a plugin count today) and `source` (where the
registry itself resolved this marketplace from, for traceability).

### `GET /plugins`

Flattened list of every plugin across every aggregated marketplace — the registry's equivalent of
what `listPlugins` (`packages/opencode/src/plugin/discover.ts`, XCOD-11) computes client-side today.

**Response `200`:**

```json
{
  "plugins": [
    {
      "name": "conventional-commits",
      "marketplace": "lunos-community",
      "description": "Enforces Conventional Commits message format.",
      "category": "git",
      "tags": ["git", "commits"],
      "source": { "type": "npm", "package": "@lunos-community/conventional-commits", "version": "^1.2.0" }
    }
  ]
}
```

`source` is the `Marketplace.Source` tagged union exactly as defined in XCOD-8 (`npm` or `github`)
— unchanged, so the client's existing `pluginInstallSpec` (XCOD-11) works against registry
responses with no new code.

### `GET /plugins/search?q=<query>`

Same shape as `GET /plugins`, filtered server-side. `q` matches case-insensitively against name,
description, category, and tags — the same fields `searchPlugins` (XCOD-11) already matches
against client-side, so behavior is consistent whether a user searches a git-hosted marketplace or
this registry.

**Response `200`:** identical shape to `GET /plugins`, scoped to matches.

**Response `200`, no matches:** `{ "plugins": [] }` — not a `404`, matching the client's existing
"no plugins matched" (not an error) semantics.

### `GET /marketplace.json` — required for XCOD-36's "no new client code" AC

The three endpoints above are registry-native (a flattened envelope, not the XCOD-8 manifest
shape) — useful for future registry-aware tooling, but **not** what `marketplace add <source>`
can consume. `resolveMarketplaceManifest` (`packages/opencode/src/marketplace/shared.ts`) decodes
a `Marketplace.Manifest` document directly off a URL; it has no concept of this registry's
envelope. Without a manifest-shaped response somewhere, XCOD-36's "works with the existing
`marketplace add` mechanism, no new client-side code" acceptance criterion is unsatisfiable.

Resolution: the registry additionally serves an aggregate manifest at a fixed path,
`GET /marketplace.json`, shaped exactly as `Marketplace.Manifest` — `name`, `owner`, `plugins:
Entry[]` — covering every plugin the registry knows about. A user runs
`lunos marketplace add https://registry.<domain>/marketplace.json` exactly as they would for any
URL-hosted manifest; the client can't tell it apart from a static file. This is the endpoint
XCOD-36 verifies against, not the three registry-native ones above.

## Data seed mapping (XCOD-9 → registry storage)

The repo-root `marketplace.json` (XCOD-9, the seed community marketplace) is the registry's
initial dataset:

- One row in the registry's marketplace table per manifest ingested (initially: just this one
  seed manifest).
- One row per plugin entry, denormalized with its parent marketplace's `name` — mirroring exactly
  how `listPlugins` already flattens plugins with a `marketplace` field client-side.
- No schema translation needed beyond this denormalization: entry fields (`name`, `source`,
  `description`, `version`, `author`, `category`, `tags`) map 1:1 from the XCOD-8 schema.
- Ingesting additional marketplaces beyond the seed (i.e. crawling registered sources) is XCOD-35's
  scope, not this story's or XCOD-34's.
- `GET /marketplace.json`'s `plugins` array aggregates every plugin across every ingested
  marketplace into one document, so its top-level `name`/`owner` are the registry's own identity
  (e.g. `name: "lunos-registry"`), not any single source marketplace's — XCOD-34 needs a fixed value
  for these, not something inferred per-request from whichever marketplace happens to be seeded.

## Explicitly out of scope for v1

Matching the parent epic (XCOD-32):

- Publisher accounts/authentication, moderation/approval workflow for submissions
- Ratings, install counts, analytics dashboards
- Uptime/SLA guarantees, multi-region failover, abuse/rate-limit hardening
- Full Cloudflare Regional Services / Enterprise Data Localization (compute-location restriction,
  not just storage) — revisit only if this service later handles non-public data

## Reference

- Manifest schema: `packages/core/src/marketplace.ts` (XCOD-8), documented in
  `packages/opencode/specs/marketplace-manifest.md`
- Seed data: `marketplace.json` (repository root, XCOD-9)
- Client-side plugin flattening/search this contract mirrors:
  `packages/opencode/src/plugin/discover.ts` (`listPlugins`/`searchPlugins`, XCOD-11)
- Existing Cloudflare Worker precedent: `packages/console/function`, wired in `infra/console.ts`
  (`AuthApi`, `LogProcessor`, `Stat`)
- D1 jurisdiction mechanism this decision relies on:
  [D1 data location](https://developers.cloudflare.com/d1/learning/data-location),
  [D1 jurisdiction changelog](https://developers.cloudflare.com/changelog/post/2025-11-05-d1-jurisdiction/)
  (Durable Objects use the same `jurisdiction` concept —
  [DO data location](https://developers.cloudflare.com/durable-objects/reference/data-location/) —
  cited here only for how the constraint behaves generally, not as evidence for D1 specifically)
- Cloudflare Regional Services (rejected, Enterprise-only):
  [Regional Services docs](https://developers.cloudflare.com/data-localization/regional-services/)
