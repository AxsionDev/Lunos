# XCOD-1: Rename to Ratio — Decisions & Status

## Repo/org naming decision (AC: "Decide and document: rename now vs. defer")

**Decision: defer.** The GitHub repo stays `pminev1/Axcode` for now; "Ratio" is the product brand
used in user-facing surfaces (CLI, install script, README, package identity). Renaming the GitHub
repo/org itself is a separate, higher-blast-radius action (breaks existing clone URLs, CI secrets
scoped to the repo name, etc.) and is left for the user to decide and execute deliberately.

**This is a default, not a final call — confirm or override.**

## What actually changed in this pass

- `packages/cli`: bin `lildax` → `ratio` (`bin/lildax.cjs` → `bin/ratio.cjs`, `package.json`,
  `script/build.ts`, `script/publish.ts`).
- `install`: `APP=ratio`, install dir `~/.ratio/bin`, usage text, ASCII wordmark, closing messages,
  GitHub URLs repointed to `pminev1/Axcode`.
- Root `package.json`: `name` → `ratio`, `description` updated, `repository`/`homepage` → the fork's
  own repo (kept `anomalyco/opencode` as the upstream reference elsewhere, e.g. README).
- `README.md` / `CONTRIBUTING.md`: added a Ratio/fork/non-affiliation/EU-positioning note at the top.

## What's explicitly NOT done (needs follow-up, not silently skipped)

- **`packages/opencode`** (the actual compiled TUI/server binary the `install` script downloads)
  is still built and named `opencode` internally — its `--version` output, TUI splash, and binary
  filename are untouched. `install` renames the *installed* binary to `ratio` after extraction, but
  the binary itself doesn't yet identify as Ratio. Until this is addressed, "`ratio --version` prints
  Ratio branding" (AC) is not actually true — only the install path/command name is.
- **No Ratio release artifacts exist.** `install` now points at `github.com/pminev1/Axcode/releases`,
  but nothing is published there — the script is non-functional until a release pipeline exists.
- **Visual identity** (logo SVGs under `packages/console/app/src/asset/`, desktop/Electron icons,
  TUI/web banners) — not touched. This needs real design work, not a text rename.
- **Translated READMEs** (~20 files) still say OpenCode — deliberately left in English-only scope
  for this pass.
- `bun.lock` still references `lildax` — it only updates via `bun install`, which needs `node_modules`
  set up first.
