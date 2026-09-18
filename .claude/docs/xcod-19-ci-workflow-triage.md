# XCOD-19 — Inherited CI workflow triage

**Status:** decision record · **Date:** 2026-09-18 · **Branch:** `xcod-19-ci-workflow-triage`
**Epic:** XCOD-15 (Close out Phase 0) · **Completes:** AXC-11 from the Phase 0 backlog
**Feeds:** XCOD-18 (Re-point CI workflows at Lunos's own org and secrets)

## Scope note

This is a **decision record, not automation**. No workflow file is added, edited, or deleted by
this story. Acting on the "drop" column is XCOD-18's job, so that removal and re-pointing happen
in one reviewable change rather than two.

**Count discrepancy:** the ticket says 25 inherited workflows. `.github/workflows/` on `dev`
actually contains **26** `.yml` files. All 26 are classified below; the extra file is not an
error, the original backlog note simply predates one of them.

## Classification key

| Verdict | Meaning |
|---|---|
| **Keep** | Runs on day one. Must be green before Phase 0 exit. |
| **Defer** | Disable/leave dormant for now. Real value, but blocked on infra, secrets, a published artifact, or repo volume the fork does not yet have. |
| **Drop** | Actively remove. Upstream-community-scale policy or upstream-specific integration that will never apply to Lunos as-is. |

## The 26 workflows

### Keep day one (6)

| Workflow | What it does | Why keep |
|---|---|---|
| `test.yml` | Runs the unit/integration suite on push and PR. | The core correctness gate. Non-negotiable. |
| `typecheck.yml` | Typechecks all 30 packages. | Second correctness gate; the repo is already held to 30/30 clean. |
| `publish.yml` | Full release pipeline — npm, platform binaries, Homebrew, AUR, signing. | The fork must be installable for XCOD-20. **Blocked on XCOD-18**: references `anomalyco` in 5 places and publishes the `opencode-ai` npm package. |
| `generate.yml` | Regenerates derived artifacts (SDKs) and commits them back. | Keeps generated SDK output from silently drifting from source. |
| `nix-eval.yml` | Evaluates all flake outputs across systems. | The repo ships `flake.nix`/`flake.lock`; without this, Nix packaging breaks unnoticed. |
| `nix-hashes.yml` | Recomputes the `node_modules` hash the Nix build pins. | Paired with `nix-eval`; the flake is wrong the moment deps change without it. |

### Defer (12)

| Workflow | What it does | Why defer |
|---|---|---|
| `deploy.yml` | Deploys console/web via SST to AWS + Cloudflare. | Needs Lunos's own AWS account, SST state, and Cloudflare token. References `anomalyco`. Blocked on the infra-ownership decision (XCOD-17/XCOD-18). |
| `unlock.yml` | Manually unlocks stuck SST deploy state. | Only meaningful once `deploy.yml` runs. Ships with it or not at all. |
| `containers.yml` | Builds and pushes multi-arch Docker images to GHCR. | Would publish into the upstream GHCR namespace. Re-point with XCOD-18, or defer until containers are a supported install path. |
| `publish-vscode.yml` | Publishes the VS Code extension (`VSCE_PAT`, `OPENVSX_TOKEN`). | No Lunos marketplace listing exists yet. Publishing under upstream's identity would be wrong. |
| `publish-github-action.yml` | Publishes the composite GitHub Action. | No Lunos-owned Action is published yet. |
| `release-github-action.yml` | Cuts release tags for that Action. | Same gate as above; these two ship together. |
| `opencode.yml` | Runs `anomalyco/opencode/github` on issue/PR comments. | Pinned to an **upstream-owned action SHA** and `OPENCODE_API_KEY`. Keeping it means the fork's CI executes upstream's code. Revisit only if Lunos ships its own equivalent. |
| `review.yml` | AI-assisted PR review triggered by comment. | Needs an API key and a budget decision. Genuinely useful later; not a Phase 0 exit criterion. |
| `docs-update.yml` | Every 12h, AI-updates docs from recent commits. | Auto-committing doc changes on a schedule is noise at current velocity, and it needs an API key. |
| `docs-locale-sync.yml` | Syncs docs translations across locales. | **Directly conflicts with XCOD-24**, which declares the inherited translations stale rather than maintained. Re-enable only if Lunos commits to real localization. |
| `storybook.yml` | Builds Storybook for the UI package. | Flagged as a defer candidate in the original backlog note. No consumer for the built output today. |
| `stats.yml` | Daily repo-stats script; writes `STATS.md`. | References `anomalyco`. Vanity metrics on a pre-launch fork; XCOD-30 will define what Lunos actually wants to measure. |

### Drop (8)

All eight are upstream-community-scale policy automation. Upstream runs a high-volume public
repo; Lunos currently has effectively no inbound issue or PR traffic. Running these now is at
best inert and at worst actively hostile to the fork's first outside contributors.

| Workflow | What it does | Why drop |
|---|---|---|
| `close-issues.yml` | Nightly auto-close of stale issues. | Auto-closing is a volume-management tool. At zero volume it only signals neglect. |
| `close-prs.yml` | Auto-closes PRs lacking enough positive reactions. | Reaction-gated PR closure requires a large community to generate reactions. Closing a first contributor's PR for lack of upvotes is the worst possible first impression. |
| `compliance-close.yml` | Closes template-non-compliant issues/PRs after 2 hours. | A 2-hour compliance guillotine is upstream-scale policy. Lunos should read its handful of issues by hand. |
| `duplicate-issues.yml` | AI duplicate-issue detection. | Needs both issue volume and an API key; has neither. |
| `triage.yml` | AI issue triage and labelling. | Same — no volume to triage. |
| `pr-standards.yml` | Enforces upstream's PR template and label taxonomy. | Encodes upstream's conventions, not Lunos's. Re-add deliberately once Lunos has its own. |
| `pr-management.yml` | Team-membership-gated PR automation. | Gates on an upstream GitHub team that Lunos does not own, so it cannot behave correctly here. |
| `notify-discord.yml` | Posts releases to Discord via `DISCORD_WEBHOOK`. | Points at upstream's Discord. Lunos has no Discord yet (see XCOD-26). |

## Consequences for XCOD-18

The re-pointing story now has a bounded target list rather than all 26 files:

- **Must re-point:** `publish.yml` (`anomalyco` ×5, `opencode-ai` npm name).
- **Re-point if/when un-deferred:** `deploy.yml`, `containers.yml`, `stats.yml`, `opencode.yml`.
- **Delete outright:** the 8 "drop" workflows.
- **Secrets to provision for the keep set:** the `publish.yml` signing/distribution group —
  `APPLE_*`, `AZURE_TRUSTED_SIGNING_*`, `TAURI_SIGNING_*`, `AUR_KEY`, plus npm publish rights.
  Everything else in the inherited secret list belongs to a deferred workflow and can wait.

## Acceptance criteria

- [x] All workflows individually classified (keep / defer / drop) — 26 of 26, count delta noted
- [x] Classification written down durably in the repo (this file), not tribal knowledge
- [x] Every deferred/dropped workflow carries a one-line reason
