# XCOD-48 — Credential provisioning: what is actually required

**Status:** checklist for the owner · **Date:** 2026-09-19 · **Ticket:** XCOD-48 (To Do)
**Depends on:** XCOD-49's signing decision · **Blocks:** XCOD-20, XCOD-46, XCOD-49 AC-2

> Everything here must be done by a human with account access. The agent cannot provision
> credentials. This document exists to make that a paste-and-go task rather than a research task.

## ⚠️ The scope shrank — read this first

XCOD-48's description records a decision from **2026-09-18**: _"provision the full credential set
(option a) rather than shipping a CLI-only, unsigned release."_

**XCOD-49's owner decision on 2026-09-19 reversed that** — ship unsigned for now. The two are in
direct conflict, and the newer one wins. Consequence:

| Credential family                         | Under the old decision | **Under the unsigned decision**            |
| ----------------------------------------- | ---------------------- | ------------------------------------------ |
| npm authentication                        | required               | **still required** ⬅ the only real blocker |
| Azure Trusted Signing (6 secrets)         | required               | not needed — job skips cleanly             |
| Apple certs (5 secrets, currently broken) | required               | not needed — steps skip cleanly            |
| Tauri updater signing (2 secrets)         | required               | not needed for Phase 0 (CLI-only)          |
| AUR key                                   | optional               | not needed — leg disabled                  |
| Sentry / telemetry                        | optional               | not needed, and see note below             |

**So this ticket is now one task: provision npm auth.** Everything else is deferred, not missing.

## The one thing that must happen

### npm authentication

`publish.yml` sets `registry-url` on `actions/setup-node`, which writes an `.npmrc` expecting
`NODE_AUTH_TOKEN`. Nothing ever supplied it, so `npm publish` could never authenticate — this was
never a "missing secret," it was missing _wiring_.

**The wiring is now done** (XCOD-48 commit): the publish step passes
`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. It resolves empty today and starts working the moment
the secret exists, with no further workflow edit.

**What you need to do:**

1. On npmjs.com, create a **Granular Access Token** (or classic Automation token) with
   **read and write** permission for the `lunos-ai` package.
   - ~~`lunos-ai` is currently **unclaimed** (404).~~ **Done 2026-09-21** — all 13 package names are
     claimed by `axsiond` and `lunos-ai@1.18.35` is published.
   - The token therefore no longer needs org/user-level publish scope. **Scope it down to the 13
     `lunos-*` packages now** — that was always the plan "after the first publish", and the first
     publish has happened.
2. Add it to the repository:

   ```bash
   gh secret set NPM_TOKEN --repo AxsionDev/Lunos
   # paste the token when prompted
   ```

3. Verify it landed:

   ```bash
   gh secret list --repo AxsionDev/Lunos
   ```

**Note the `--repo` flag.** With an `upstream` remote configured, bare `gh` commands have resolved
to `anomalyco/opencode` before. Always pass it explicitly.

### The alternative: npm Trusted Publishing

Upstream uses OIDC trusted publishing instead of a token — hence `permissions: id-token: write`.
That route needs no secret, but must be configured on npm's side **before** the first publish, and
points at a specific repo + workflow path.

Not recommended here, for a specific reason: **XCOD-48's description says to point it at
`pminev1/Lunos`, which is stale** — the repo moved to `AxsionDev/Lunos` on 2026-09-18. A trusted
publisher configured against the old path would silently fail to match. The token route has no
equivalent trap.

#### ⏳ …but the token route has a deprecation clock (noted 2026-09-21)

Every publish run prints this:

> npm tokens that bypass 2FA are being restricted for account changes and direct publishing.
> Learn how to prepare: https://gh.io/npm-gat-bypass2fa-deprecation

`NPM_TOKEN` is a granular token with **bypass-2FA** enabled — that is precisely what lets CI publish
unattended, and npm is restricting it. This is not urgent and nothing is broken today, but it means
the recommendation above has an expiry date.

Evidence the bypass is load-bearing: on 2026-09-21 a local `npm login` session token hit
`403 Two-factor authentication or granular access token with bypass 2fa enabled is required to
publish`, while the CI token published all 13 packages in the same window. Interactive `--otp` is
**not** a workable substitute for the platform packages — npm validates the OTP only after receiving
the request body, and a 60 MB upload outlasts a 30-second TOTP window.

When the restriction lands, the migration target is **Trusted Publishing (OIDC)** — the very thing
deferred above. Configure it against `AxsionDev/Lunos` and `.github/workflows/publish.yml`, not the
stale `pminev1` path. `permissions: id-token: write` is already set on the workflow.

## ✅ The first dispatch has now happened (2026-09-21)

`NPM_TOKEN` was set and the path **did** execute end to end — run
[35602897979](https://github.com/AxsionDev/Lunos/actions/runs/35602897979) published all 13 packages
at **1.18.35**, created tag `v1.18.35`, pushed the `dev` version-sync commit and un-drafted the
release. `npm install lunos-ai` resolves and runs.

The section below used to warn "expect at least one more inherited-infrastructure surprise." There
were **four** more, all resolved under XCOD-49. Recorded because the pattern predicts where the next
one lives:

| Was flagged as unknown                     | What actually happened                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ghcr push never run / org permissions      | Permissions were **fine**. It failed on `packages/opencode/Dockerfile` still copying `dist/opencode-*` after the rebrand. Fixed; image now pushes for `:<version>` and `:latest`.                                                                                                                                                                 |
| `version.ts` depends on upstream's package | This was the **sharpest** one. It was not just `bun i -g opencode-ai` — `packages/script/src/index.ts` derived the next version number by fetching upstream's `opencode-ai` from npm. `bump=patch` read upstream's 1.18.31 and produced 1.18.32 while `lunos-ai` was at 1.18.34, publishing a **downgrade** as `latest`. Repointed at `lunos-ai`. |
| desktop artifacts feed `gh release upload` | Upload was fine. `finalize-latest-json.ts` failed instead: it signs bundles with `TAURI_SIGNING_PRIVATE_KEY`, which this fork lacks. Now gated on the secret's presence, so it resumes automatically once the key is provisioned.                                                                                                                 |
| _(not anticipated)_                        | npm rate-limits **new package creation** at account level for hours. A one-time cost — all 13 names now exist, so later releases are version bumps and unaffected.                                                                                                                                                                                |

**Takeaway for the deferred credentials below:** every failure was inherited configuration pointing
at upstream's resources, not an absent secret. When enabling any deferred leg, grep it for
`opencode` / `anomalyco` / `pminev1` before the first run — that is cheaper than a 20–45 minute
dispatch, and it is how the Homebrew leg was caught writing into `anomalyco/homebrew-tap`.

## Deferred, with reasons — not forgotten

**Apple (5 secrets, present but broken).** `import-codesign-certs` failed at `/usr/bin/security`
exit 1 — a malformed cert or wrong password, not an absent one. Most likely `APPLE_CERTIFICATE` is
a base64 blob with a stray newline, or the wrong cert type (needs **Developer ID Application**, not
Apple Development). Re-export the `.p12` and re-encode with `base64 -i cert.p12 | pbcopy`.

**Azure Trusted Signing (6 secrets, absent).** Needs an Azure subscription, a Trusted Signing
account, and a service principal with federated credentials for GitHub OIDC. Also has an
organisation identity-validation step that can take days — **start early if Windows signing is
ever wanted**, it is not a same-day purchase.

**Tauri updater keys (2 secrets).** Generated locally by the Tauri CLI, no purchase. Only needed
for desktop auto-update manifests.

**Sentry / telemetry.** Before enabling: Sentry is US-headquartered. Consider whether that is
compatible with the EU-sovereignty positioning recorded in
[xcod-55-infrastructure-sovereignty-decision.md](./xcod-55-infrastructure-sovereignty-decision.md).
That decision scopes the public claim to self-hosted distribution, so telemetry from _our_ build
pipeline is not covered by it either way — but it is worth a deliberate choice rather than a
default.

**`vars.OPENCODE_APP_ID`** — no longer required. XCOD-47 made the GitHub App optional with a
`GITHUB_TOKEN` fallback.

## Secrets referenced by workflows but irrelevant here

The full audit turned up several that belong to _deferred_ workflows, not the release path:
`CLOUDFLARE_API_TOKEN`, `PLANETSCALE_SERVICE_TOKEN*`, `STRIPE_SECRET_KEY_*`, `HONEYCOMB_API_KEY`,
`POSTHOG_KEY`, `OPENCODE_API_KEY`, `VSCE_PAT`, `OPENVSX_TOKEN`, `vars.AWS_DEPLOY_ROLE_ARN`.

These belong to `deploy.yml`, `publish-vscode.yml` and friends — all deferred by XCOD-19. **Do not
provision them to "complete the set."** Several imply infrastructure Lunos does not operate.
