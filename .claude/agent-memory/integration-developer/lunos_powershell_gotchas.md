---
name: lunos-powershell-gotchas
description: PowerShell path-handling and robocopy pitfalls found while writing build.ps1/deploy.ps1 for the Lunos website deploy pipeline
metadata:
  type: project
---

While writing and dry-running `build.ps1`/`deploy.ps1` (Task 9 of the Lunos website
Phase 1 plan), two non-obvious PowerShell bugs surfaced that are easy to reintroduce in
future edits to these scripts, or in any new PowerShell tooling for this repo:

**Literal backslashes in string-interpolated paths break on non-Windows, silently.**
`Join-Path $root "sub\$version"` or `"$root\file.txt"` do NOT get their embedded `\`
treated as a path separator by .NET's file APIs on macOS/Linux — `Join-Path` only
inserts the platform separator *between its own two arguments*; it never re-splits a
literal backslash baked into one argument string. On macOS this created a directory
literally named `dryrun1\web` (backslash as part of the filename) instead of a nested
folder, while `dotnet publish -o` with the same style of path looked fine in the same
script — because MSBuild normalizes `\` to the host separator as a matter of
cross-platform project-file compatibility, masking the bug for .NET calls but not for
pure-PowerShell file operations (`New-Item`, `Get-ChildItem`, `Compress-Archive`, Angular
CLI's `--output-path` via npm/node). **Always build multi-segment paths with nested
`Join-Path` calls, never string interpolation with `\`**, even though `deploy.ps1` only
ever runs on Windows in production — it keeps both scripts dry-runnable on a
contributor's Mac via `pwsh`, which is how this repo actually validates them (Windows
Server + IIS isn't available until Task 10's real box).

**`robocopy ... | Out-Null` silently swallows real failures.** robocopy is a native exe;
its exit code lands in `$LASTEXITCODE`, and `$ErrorActionPreference = "Stop"` has zero
effect on native exit codes. robocopy's codes are a bitmask where 0–3 are all *success*
(0 = no changes, 1 = copied, 2 = extra removed, 3 = both) — checking `-ne 0` would
wrongly fail on normal successful runs. The correct check is `$LASTEXITCODE -ge 8`
immediately after each robocopy invocation, thrown before touching app pool state
further.

**Related gotcha for any script that stops IIS app pools before doing prep work:**
create every directory the script depends on (e.g. a backup root) *before* the
stop-app-pools step, not lazily inside a conditional later in the script — a
`Test-Path`-gated `Copy-Item` won't create the parent directory on a fresh box's first
run, and a later unconditional `Get-ChildItem`/`Remove-Item` against that missing path
throws under `$ErrorActionPreference = "Stop"`, leaving the site down with pools already
stopped and no restart path.

See also `.claude/agent-memory/frontend-developer/project_lunos_web_toolchain.md` for
the separate Node-version-pinning gotcha (`nvm use 22.22.3` required before any
`ng`/`npx` call) that also applies inside `build.ps1`.

**`index.html` vs `index.csr.html` after Task 11's prerendering — don't confuse them
in deploy/IIS config.** Once build-time prerendering was added, `ng build` emits BOTH
`browser/index.html` (the real prerendered home page, `ng-server-context="ssg"`) and
`browser/index.csr.html` (the true empty client-side-rendering shell). Any IIS
SPA-fallback rewrite rule, or any future deploy-script logic that needs a generic shell
for unmatched routes, must target `index.csr.html` — targeting `index.html` serves
fully-rendered home-page markup (with a hydration mismatch) for every 404 and future
route. `deploy.ps1`'s existing sanity check on `web/index.html` is unaffected (it only
confirms the browser/ flatten ran) but do not repurpose that same path for anything
SPA-fallback related. Fixed durably in the plan doc, README.md, and a deploy.ps1
comment in the C1 final-review fix (commit `eceb2fe2f`).
