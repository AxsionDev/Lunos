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

| Credential family                         | Under the old decision | **Under the unsigned decision**             |
| ----------------------------------------- | ---------------------- | ------------------------------------------- |
| npm authentication                        | required               | **still required** ⬅ the only real blocker |
| Azure Trusted Signing (6 secrets)         | required               | not needed — job skips cleanly              |
| Apple certs (5 secrets, currently broken) | required               | not needed — steps skip cleanly             |
| Tauri updater signing (2 secrets)         | required               | not needed for Phase 0 (CLI-only)           |
| AUR key                                   | optional               | not needed — leg disabled                   |
| Sentry / telemetry                        | optional               | not needed, and see note below              |

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
   - `lunos-ai` is currently **unclaimed** (404). The first successful publish claims it.
   - Since it does not exist yet, the token needs org/user-level publish scope rather than
     package-scoped — scope it down after the first publish.
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

## What to expect on the first dispatch

Once `NPM_TOKEN` is set:

```bash
gh workflow run publish.yml --repo AxsionDev/Lunos -f bump=patch
```

The pipeline should now: pass the repo guards (fixed in XCOD-49), run `preflight` and report
signing as skipped, build the CLI, **skip** `sign-cli-windows`, build Electron unsigned, skip
Homebrew and AUR, push the ghcr image, and publish `lunos-ai`.

**This path has never executed end to end.** Expect at least one more inherited-infrastructure
surprise. Known remaining unknowns:

- The ghcr push to `ghcr.io/axsiondev/lunos` has never run — the org may need package-write
  permissions granted to Actions the first time.
- `version.ts` runs `bun i -g opencode-ai` (`publish.yml:52`) — installs **upstream's** package as
  a build tool. Works, but worth noting it is an upstream dependency in our release path.
- The desktop/Electron artifacts feed `gh release upload`; if any matrix leg fails, that step
  exits 1 (`publish.yml:551`).

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
