# XCOD-36: Registry production deploy, client verification, and docs

## Status: partial — AC4/AC5 delivered, AC1–AC3 blocked on authorized production deploy

XCOD-36 is the closeout story for epic XCOD-32 (Lunos Marketplace Registry Service). Of its 5
acceptance criteria, 2 are documentation-only and are delivered by this doc; the remaining 3 require
an actual `sst deploy` to production, which this story does not perform — see "Deploy blocker" below.

| AC | Requirement | Status |
| --- | --- | --- |
| 1 | Registry deployed via SST infra-as-code, reachable over HTTPS on a real domain | **Not done** — code is ready (`infra/registry.ts` now sets `domain: registry.${domain}`), but no deploy has run |
| 2 | `lunos marketplace add <registry-url>` works against the live service, no new client code | **Not verifiable yet** — depends on AC1; server-side prerequisite (`GET /marketplace.json`, XCOD-34) is already implemented |
| 3 | `plugin list`/`search` and the client cache (XCOD-13) work against the live registry | **Not verifiable yet** — depends on AC1 |
| 4 | Hosting/region decision written down against the EU-sovereignty goal | **Done** — see "Hosting/region decision" below |
| 5 | Out-of-scope items explicitly documented | **Done** — see "Out of scope" below |

## Deploy blocker

`sst.config.ts`'s `run()` gates the registry module behind an explicit opt-in:

```ts
// XCOD-34 (F-001): the marketplace registry Worker and its EU-jurisdiction D1 database
// are gated behind an explicit opt-in and are NOT provisioned by an ordinary deploy.
if (process.env.LUNOS_DEPLOY_REGISTRY === "1") {
  await import("./infra/registry.js")
}
```

This is deliberate (D1 jurisdiction is create-time-only and irreversible, per XCOD-33/XCOD-34), and
it means an ordinary deploy never touches this service. Actually provisioning it — creating the
EU-jurisdiction D1 database and the Worker, then pointing DNS at it — is a production infrastructure
action outside this story's authorization. AC1–AC3 stay open until that deploy is run and verified
against the live URL.

What this story *did* complete, without deploying anything:

- Added ``domain: `registry.${domain}` `` to the `MarketplaceRegistry` Worker in
  `infra/registry.ts`, matching the `auth.${domain}` / `api.${domain}` pattern already used in
  `infra/console.ts` / `infra/app.ts`. `url: true` is kept alongside it as a pre-DNS-propagation
  fallback (the same combination `AuthApi` uses in `infra/console.ts`). At production stage,
  `domain` resolves to `opencode.ai` (`infra/stage.ts`), so the deploy target is `registry.opencode.ai`.
- Confirmed the `GET /marketplace.json` endpoint (the one `marketplace add` will actually hit, per
  XCOD-33's contract) is already implemented — `packages/registry/src/handlers/marketplace-json.ts`
  — so AC2 has no remaining server-side work once deployed.

## Hosting/region decision

Finalized in XCOD-33's design doc, `packages/opencode/specs/marketplace-registry.md`
(committed `9b6f41296`): **Cloudflare Worker + D1, created with `jurisdiction: "eu"`**, chosen over
AWS `eu-central-1`, self-hosted EU options, and full Cloudflare Regional Services (rejected as
Enterprise-only overkill for a public read-mostly service with no revenue model).

Against the EU-sovereignty goal specifically: the decision guarantees the registry's dataset is
created and persists only in Cloudflare's EU-jurisdiction infrastructure. It does **not** guarantee
every Worker invocation executes at an EU edge node — jurisdiction constrains where the D1 database
lives, not where each anonymous public read is served from. That gap is accepted because this
service stores only public plugin/marketplace metadata, never user accounts or credentials; if a
future story adds user-identifying data (explicitly out of scope below), this tradeoff needs
re-evaluating against full Regional Services. See XCOD-33's doc for the full options comparison and
citations.

## Out of scope

Restated from XCOD-33/the parent epic (XCOD-32), so this story's docs are self-contained and these
items don't silently get treated as implied future work:

- Publisher accounts/authentication, moderation/approval workflow for submissions
- Ratings, install counts, analytics dashboards
- Uptime/SLA guarantees, multi-region failover, abuse/rate-limit hardening
- Full Cloudflare Regional Services / Enterprise Data Localization (compute-location restriction,
  not just storage) — revisit only if this service later handles non-public data

## Remaining work (blocked, not part of this delivery)

1. Run `LUNOS_DEPLOY_REGISTRY=1 bun sst deploy --stage=production` with production Cloudflare/AWS
   credentials.
2. Independently confirm the D1 database's EU jurisdiction post-creation via the Cloudflare
   dashboard or API (per `infra/registry.ts`'s existing comment — not merely assumed from config).
3. Verify `lunos marketplace add https://registry.opencode.ai/marketplace.json` against the live URL.
4. Regression-check `plugin list`/`search` (XCOD-11) and the client cache (XCOD-13) with the live
   registry as the configured source.
5. Flip AC1–AC3 to done and close out XCOD-36 once 1–4 pass.

## Reference

- Design/contract: `packages/opencode/specs/marketplace-registry.md` (XCOD-33)
- API implementation: `.claude/docs/xcod-34-registry-api.md` (XCOD-34)
- Deploy gate: `sst.config.ts`, `LUNOS_DEPLOY_REGISTRY` env var
- Infra: `infra/registry.ts`
