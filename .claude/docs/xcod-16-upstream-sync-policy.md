# XCOD-16 — Upstream sync policy (ADOPTED) + rebase rehearsal notes

**Status:** adopted · **Date:** 2026-09-18 · **Epic:** XCOD-15 (Close out Phase 0)
**Supersedes:** AXC-7 and AXC-8 from the Phase 0 backlog

> [!IMPORTANT]
> **The draft policy was amended by this rehearsal.** The draft mandated *rebase* onto
> `upstream/dev`. The rehearsal proved rebase is not viable for this fork: **109 conflicts vs. 0
> for a merge** of the identical upstream range. The adopted policy below uses **merge**. The
> ticket explicitly licensed this — "carry forward as-is unless this story's rebase rehearsal
> surfaces a needed change." It surfaced one.

## Adopted policy

1. **Remotes.** `origin` = the Lunos fork (`pminev1/Lunos`). `upstream` = `anomalyco/opencode`.
   The `upstream` remote was **missing entirely** and was added as part of this story.
2. **Integration strategy — `merge`, not `rebase`.** Sync with
   `git fetch upstream && git merge upstream/dev`. Never rebase the fork's accumulated history
   onto upstream. Evidence in the rehearsal section below.
3. **Cadence.** Weekly, not continuously. Unchanged from the draft.
4. **Ownership.** The current maintainer owns conflict resolution until a second maintainer joins.
   Conflicts touching Lunos-only files (branding, EU provider config, compliance docs) always
   resolve in favour of Lunos's version. Unchanged from the draft.
5. **Isolation boundary.** Lunos-specific code lives in clearly separated modules rather than
   scattered edits inside upstream files. **This claim was tested and holds** — see below.
6. **Upstreaming.** Anything generically useful is proposed as a PR to `anomalyco/opencode` first.
   Unchanged from the draft.
7. **Branch tracking.** Track `dev`, not tagged releases, until upstream cuts a stable v2 tag.
   Unchanged from the draft.
8. **Never sync directly on `dev`.** Do it on a throwaway branch, verify, then merge. The runbook
   below encodes this.

## Weekly sync runbook

```bash
git fetch upstream
git worktree add ../sync-$(date +%F) -b sync-$(date +%F) dev   # never sync on dev itself
cd ../sync-$(date +%F)
git merge upstream/dev                                          # merge, never rebase
bun install                                                     # bun.lock conflicts most often
GITHUB_ACTIONS=false bun turbo test                             # NOT `bun test` — see note
bun run typecheck
(cd packages/client   && bun run check:generated)               # CI runs these two as well
(cd packages/opencode && bun run test:httpapi)
# compare the failing-test set against dev's baseline before blaming the sync
```

**Note on running tests:** `bun test` from the repo root fails by design.
`bunfig.toml` sets `[test] root = "./do-not-run-tests-from-root"` and the root `package.json`
`test` script is `echo 'do not run tests from root' && exit 1`. The real invocation — the one CI
uses in `test.yml` — is `GITHUB_ACTIONS=false bun turbo test`.

## Rehearsal: what was actually run

**Divergence at rehearsal time**

| Measure | Value |
|---|---|
| Merge base | `95daf9067` |
| `upstream/dev` tip | `b02acc1e3` |
| Fork-only commits (`upstream/dev..dev`) | **85** |
| Upstream-only commits (`dev..upstream/dev`) | **22** |
| Fork-changed files since base | 385 |
| Upstream-changed files since base | 112 |
| **Files changed by both (net diff)** | **4** — `bun.lock`, `packages/cli/package.json`, `packages/opencode/src/cli/cmd/tui.ts`, `packages/tui/src/app.tsx` |

### Attempt 1 — `git rebase upstream/dev`: aborted

Failed on the very first fork commit it tried to replay, **`3f3585cf1` "chore: remove legacy
AxCode/opencode fork content"** — a mass-deletion commit touching **6,560 files
(1,426,709 deletions)**.

| Result | Value |
|---|---|
| Conflicted files | **109** |
| Conflict type | **109 modify/delete, 0 content** |
| Time to first failure | ~3s |
| Outcome | **aborted** — `dev` never touched |

Every conflict has the same shape: *"deleted in `3f3585cf1` … and modified in HEAD."* Our history
deletes a file; upstream has since edited it; the replay cannot reconcile the two without a manual
decision per file. Resolving 109 of these by hand, on the *first* of 85 commits, with no guarantee
later commits don't re-conflict, is not a weekly operation.

### Attempt 2 — `git merge upstream/dev`: clean

| Result | Value |
|---|---|
| Conflicted files | **0** |
| Time | **<1s** |
| Upstream commits absorbed | 22 (+1 merge commit) |

### Post-sync verification

Baseline captured **before** the sync in the **same worktree**, so the comparison is valid.

| Check | Before sync | After sync | Verdict |
|---|---|---|---|
| `bun run typecheck` | 30/30 pass, exit 0 | 30/30 pass, exit 0 | no change |
| `bun turbo test` | 830 pass / 9 fail, exit 1 | 830 pass / 9 fail, exit 1 | no change |
| Failing-test set | 9 named tests | **identical 9 tests** | **zero regressions** |
| `check:generated` (in `packages/client`) | exit 0 | exit 0 | no change |
| `test:httpapi` (in `packages/opencode`) | exit 0 | exit 0 | no change |

`test.yml` runs **three** commands in its unit job, not one — `bun turbo test`,
`bun run check:generated` (from `packages/client`), and `bun run test:httpapi` (from
`packages/opencode`). All three were run at both ends. `check:generated` matters most here: it is
the natural casualty of merging upstream changes to generated SDK output, and the merge absorbed
upstream edits to `packages/opencode/src/server/routes/instance/httpapi/middleware/error.ts` and
its test. It passes.

The 9 failures are **pre-existing on `dev`** and unrelated to the sync — 8 in
`prompt submit worktree selection` and 1 in `desktop native locale detection`, all in
`@opencode-ai/app`. They fail identically with and without upstream's commits. Capturing the
baseline first is what makes that statement provable rather than assumed.

## Why the cheap pre-check under-predicted the rebase cost by ~27×

Worth internalising before the next sync, because the obvious pre-flight check is misleading:

Comparing net diffs (`base..ours` vs `base..theirs`) showed only **4** overlapping files, which
suggests a trivial integration. The rebase produced **109** conflicts.

Both numbers are correct — they measure different things:

- A **merge** is a three-way comparison of *endpoints*. A file deleted and later re-added nets out
  to "unchanged," so it never conflicts.
- A **rebase** replays all 85 commits *individually*, re-enacting every intermediate state —
  including the mass deletion in `3f3585cf1` — against a moved target.

This fork's history is full of delete/re-add churn from the AXCODE → Ratio → Lunos renames. That
churn is invisible in the net diff and dominant in a replay.

**Rule of thumb:** net-diff overlap predicts *merge* burden. It predicts *rebase* burden only for a
fork whose history has no large delete/re-add or rename churn. This fork is not that fork, and
`3f3585cf1` alone guarantees it never will be — history is immutable, so this cost is permanent,
not a transient state that cleans itself up.

## On the isolation boundary

The draft policy asserted Lunos-specific code is "clearly separated … so weekly rebases stay
mechanical." **The separation claim is true** — 4 overlapping files out of 385 is excellent
isolation, and it is why the merge was clean. The *conclusion* drawn from it was wrong: good
isolation makes **merges** mechanical, not rebases. Rebase cost is driven by history shape, not by
file-level separation. The policy keeps the boundary requirement and drops the rebase inference.

## Acceptance criteria

- [x] Sync policy adopted (not just drafted) and stored durably in the repo — this file
- [x] One real rebase of the fork's Lunos-specific commits onto current `upstream/dev` attempted
      against real history — **aborted with evidence after 109 conflicts**; a clean merge of the
      identical upstream range was completed in its place
- [x] The fork builds and tests after the sync — typecheck 30/30, zero test regressions
- [x] Rehearsal notes written down, with conflicts, resolutions, and timings

> [!NOTE]
> **AC #2 was met in substance, not literally.** The rebase was genuinely attempted against real
> commits, and its failure is the story's most useful output. Completing it would have meant
> hand-resolving 109 modify/delete conflicts to produce history no one should adopt. If you want
> the literal criterion satisfied, say so and it can be ground out — but the recommendation is to
> accept the evidence and take the amended policy.

## Follow-up for the reviewer

The rehearsal branch **`xcod-16-upstream-sync-verified`** holds the actual clean merge of
`upstream/dev` (22 upstream commits, 0 conflicts, 0 regressions). It is deliberately **not**
merged into `dev` — taking 22 upstream commits is a real product decision, separate from adopting
a policy document. Merge it when you want the sync; it is verified and ready.
