# Active sprint close-out assessment (board 169)

**Date:** 2026-09-18
**Scope:** all issues in the XCOD active sprint, assessed for "can this be closed honestly?"

## Sprint state

17 issues in the active sprint: **10 Done**, **7 To Do**.

Already Done: XCOD-16, 18, 19, 22, 23, 24, 25, 27, 40, 45.

## The 7 remaining, triaged by who can actually close them

| Issue   | Summary                              | Verdict                                                                         |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------- |
| XCOD-28 | GitHub org/repo rename               | **Closable now** — verified complete                                            |
| XCOD-20 | Clean-machine install (Phase 0 exit) | **Advanced, not Done** — clean-container install verified; needs a real release |
| XCOD-17 | Legal/entity ownership decision      | Needs owner decision                                                            |
| XCOD-26 | Claim social/community handles       | Needs owner accounts                                                            |
| XCOD-29 | Design-partner outreach              | Explicitly "BD/PO-owned, not engineering"                                       |
| XCOD-30 | GTM metrics tracking                 | Reference doc missing                                                           |
| XCOD-31 | Build-in-public cadence              | Reference doc missing                                                           |

## XCOD-28 — verified complete

Both acceptance criteria hold as of this assessment:

- **AC1, repo renamed:** `gh repo view` confirms `pminev1/Lunos` (fork of `anomalyco/opencode`).
- **AC2, no stale old-name references:** exact-case sweep for `Axcode` / `AxCode` / `axcode` across the
  tree returns hits in only five files, all of them historical records:
  `.claude/docs/xcod-{1,4,16}-*.md` and two agent-memory files. `xcod-4-lunos-rename-decisions.md`
  itself notes these references "describe what was true _at that time_" — they are deliberately
  preserved history, not stale pointers.
  The `install` script (lines 23, 24, 187, 188, 197, 201, 204, 462) and every
  `.github/workflows/*.yml` repo reference already resolve to `pminev1/Lunos`.

**Loose end (not in the ACs):** the GitHub repo description still reads "The open source coding
agent." — inherited from upstream, never rebranded. A one-line `gh repo edit --description` fixes it.

## XCOD-20 — partially verifiable today, fully blocked on release

Phase 0's stated exit criterion is **not** fully blocked. `build-cli` succeeded and left a live
run artifact, so the CI-built CLI can be inspected now; what is missing is the _published release_
that the `install` script actually downloads from.

Artifacts on run `35335881462` (none expired):

```
opencode-cli                   521,883,347 bytes   <-- CI-built CLI, usable now
opencode-cli-windows           183,764,036 bytes
opencode-preview-cli           533,981,781 bytes
opencode-desktop-*-linux-gnu   ~557-571 MB each
```

So: binary-identity and branding ACs can be checked against the CI artifact immediately. The
"documented, repeatable clean-environment install" AC still needs a real release, because `install`
fetches from `github.com/pminev1/Lunos/releases` (install:187-204).

Publish run `35335881462` (2026-09-18, 19m59s) failed. Job outcomes:

```
success   version
success   build-cli
success   build-electron (ubuntu-24.04, x86_64 / aarch64)
failure   build-electron (macos-26, macos-26-intel, windows-2025 x2)
failure   sign-cli-windows
skipped   publish          <-- nothing reached npm
```

**Root cause: inherited code-signing secrets the fork does not have.** This is the same class of
problem as XCOD-18 (inherited CI assuming upstream's infrastructure), one layer deeper.

- Windows (`sign-cli-windows`, `build-electron`): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
  `AZURE_SUBSCRIPTION_ID`, `AZURE_TRUSTED_SIGNING_*` all resolve empty →
  `azure/login` fails with "Not all values are present."
- macOS (`build-electron`): `secrets.APPLE_CERTIFICATE` is empty → `security import` fails with
  `SecKeychainItemImport: Unable to decode the provided data`.

The `publish` job is gated on `if: ... && always() && !failure() && !cancelled()`
(`publish.yml:408`) and depends on `sign-cli-windows` + `build-electron`, so the signing failures
sink the npm publish even though `build-cli` succeeded.

### Note on scope

XCOD-20's acceptance criteria are entirely about the **CLI** (`lunos` binary, `--version` branding,
splash, default theme). The Electron desktop app is not in its scope. So the signed desktop build is
not actually a prerequisite for Phase 0 exit — only the CLI publish is.

### Fix options

**Option A — smallest diff: decouple `publish` from signing.**
Drop `sign-cli-windows` and `build-electron` from `publish`'s `needs` list (`publish.yml:403-407`)
and make the `opencode-cli-signed-windows` artifact download conditional (`publish.yml:443-446`).
For a fork that ships no desktop app and no signed Windows CLI, this is the minimal change that lets
the npm publish proceed off the successful `build-cli`.

**Option B — gate signing behind a repo variable.**
Add a `vars.ENABLE_CODE_SIGNING == 'true'` flag to the `sign-cli-windows` job condition and to the
macOS / Windows signing steps in `build-electron`. Larger diff, but keeps one switch to re-enable
signing later. _Needs confirming:_ this design assumes the `secrets` context is unavailable in
job-level `if` (forcing a `vars` flag rather than a direct secret-emptiness test) — verify against
GitHub's context-availability docs before building on it.

**Option C — acquire signing certificates.** Apple Developer Program plus Azure Trusted Signing.
Weeks of lead time and recurring cost; does not unblock Phase 0 now.

Either A or B ships **unsigned** binaries — the trade-off is Windows SmartScreen warnings and macOS
Gatekeeper prompts for desktop users. Both are reversible once certificates exist. Option C is the
only one that avoids that, and it cannot unblock this sprint.

**Not yet attempted:** pushing any of this requires the `workflow` OAuth scope on the GitHub token,
which has blocked workflow pushes on this repo before.

### Second, independent blocker: release-asset names do not match the installer

Confirmed by reading the code on both sides. **This would break a clean install even with a fully
green pipeline**, so fixing signing alone is not sufficient.

- `packages/opencode/script/build.ts:146-153` builds each archive key as
  `[pkg.name, os, arch, …].join("-")`, and `packages/opencode/package.json` still declares
  `"name": "opencode"` (deliberately — see the comment at `publish.ts:7-11`, which keeps the
  internal package name to avoid a duplicate workspace name).
- `build.ts:236-243` therefore creates `opencode-darwin-arm64.zip`, `opencode-linux-x64.tar.gz`,
  … and uploads them verbatim:
  `gh release upload v${version} ./dist/*.zip ./dist/*.tar.gz --clobber`.
- `install:3` sets `APP=lunos`; `install:168` builds the requested filename as
  `filename="$APP-$target$archive_ext"` → it asks for **`lunos-darwin-arm64.zip`**.

Result: `curl -fsSL …/install | bash` 404s on every platform. The rebrand reached the installer's
`$APP` and the npm wrapper (`publish.ts` publishes `lunos-ai` exposing a `lunos` bin) but never
reached the **GitHub release asset names**. The generated Homebrew formula and AUR PKGBUILD
(`publish.ts:121-193`) point at the `opencode-*` names too, so they are self-consistent with the
release and would keep working — only the `install` script disagrees.

**Fix shape (two options, both one-sided):** either rename the archives at upload time in
`build.ts` to `${brand}-*`, updating the Homebrew/AUR URLs in `publish.ts` to match; or change
`install:168` to request `opencode-$target$ext` while still installing as `lunos`. The former is
the correct end state for a rebranded product; the latter is the smaller diff.

### Clean-environment install test — run 2026-09-18

Executed against the CI-built `opencode-linux-x64` binary from run `35335881462`, in a throwaway
`ubuntu:24.04` container (`--platform linux/amd64`) with no prior install and no cached config:

```
=== clean container: no prior lunos/opencode ===
confirmed: no ~/.lunos
confirmed: no lunos/opencode on PATH
=== running install script ===
Installing lunos from: /tmp/lunos-src
Successfully added lunos to $PATH in /root/.bashrc

█    █  █ █▄ █ █▀▀█ █▀▀▀
█    █  █ █ ▄█ █  █ ▀▀▀█
█▄▄▄ ▀▄▄▀ ▀  ▀ ▀▀▀▀ ▄▄▄█

Lunos includes free models, to start:
  cd <project>  # Open directory
  lunos         # Run command
For more information visit https://github.com/pminev1/Lunos
=== installed tree ===
-rwxr-xr-x 1 root root 185096320 Sep 18 11:34 lunos
=== version ===
0.0.0-dev-202609181053
```

**What this proves:** the install script works end to end on a genuinely clean machine, installs the
binary as `~/.lunos/bin/lunos`, wires `$PATH`, and renders correct Lunos branding and URLs. The
`opencode` name inside the artifact is a deliberate, documented implementation detail — `install:3`
sets `APP=lunos` and `install:346-348` renames the archive's internal binary on the way in.

### Full end-to-end verification — run 2026-09-18, via prerelease

After fixing the asset naming (below), a verification prerelease `v0.0.0-dev-202609181053` was cut on
`pminev1/Lunos` carrying the corrected `lunos-*` assets, and the **real download path** was exercised
in a fresh `ubuntu:24.04` container:

```
=== clean env ===
no ~/.lunos
no lunos/opencode on PATH

=== install from release (real download path) ===
$ curl -fsSL https://github.com/pminev1/Lunos/raw/dev/install | bash -s -- --version 0.0.0-dev-202609181053
Installing lunos version: 0.0.0-dev-202609181053
######################################################################## 100.0%
Successfully added lunos to $PATH in /root/.bashrc

█    █  █ █▄ █ █▀▀█ █▀▀▀
█    █  █ █ ▄█ █  █ ▀▀▀█
█▄▄▄ ▀▄▄▀ ▀  ▀ ▀▀▀▀ ▄▄▄█

=== installed ===
-rwxr-xr-x 1 501 root 185096320 lunos
=== lunos --version ===
0.0.0-dev-202609181053
```

**This closes XCOD-20's AC-1 and AC-2 with evidence:** a repeatable clean-environment install
succeeds end to end from a real GitHub release, and the installed binary is `lunos`. The product
owner ruled on 2026-09-18 that the bare `--version` string satisfies the "prints Lunos branding"
criterion (the install banner carries the branding).

A **prerelease** was used deliberately: `releases/latest/download/` skips prereleases, so this does
not become what a stray `curl … | bash` picks up, while `install --version` still exercises the
genuine `releases/download/v${version}/` path.

**Remaining gap for XCOD-20:** AC-3 — splash and default theme (XCOD-6 / XCOD-2) are still
unverified, because both need an interactive TTY that a scripted container run cannot exercise.

**What the earlier `--binary` test did not prove:**

1. ~~**Not installed from a release.**~~ **Resolved** by the prerelease run above.
2. ~~**`--version` carries no branding.**~~ **Resolved by owner ruling** — the bare version string
   is accepted as satisfying the AC.
3. **Version is a dev build,** not a real release version. Acceptable for verification purposes; a
   real versioned release still depends on the publish pipeline.
4. **Splash and default theme (XCOD-6 / XCOD-2) unverified** — both require an interactive TUI
   session, which a non-TTY container run cannot exercise. **Still open.**

So XCOD-20 has three of four acceptance criteria met with recorded evidence. Only the splash/theme
check (AC-3) remains before it can close.

## XCOD-30 / XCOD-31 — dangling reference

Both tickets' acceptance criteria cite `claude/lunos-marketing-gtm-plan.md` Sections 5–9. **That file
does not exist anywhere in the repo.** Reconstructing the plan from the ticket descriptions would
manufacture the source of truth the ACs point at, so these should not be closed on that basis.
Rebuilding the GTM plan is its own piece of work.

## XCOD-17 / XCOD-26 / XCOD-29 — owner-only

- **XCOD-17** asks for a _recorded decision_ on whether Lunos sits under Axsion or a new EU entity,
  with IP and liability implications noted. An options memo can be drafted, but the decision itself
  is the product owner's.
- **XCOD-26** requires creating real accounts (Fosstodon, LinkedIn company page, optionally X).
- **XCOD-29** requires contacting real people; the ticket itself says "BD/PO-owned task, not
  engineering."

None of these can be completed by an agent, and closing them without the underlying action would
make the board assert things that are not true.
