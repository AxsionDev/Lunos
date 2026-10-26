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
- `packages/cli`'s v2 CLI display name now falls back to `"ratio"` (was `"opencode"`) when no
  build-time name is injected; its `--help` description says "Ratio 2.0 preview...".
- Redrew the ASCII wordmark as "RATIO" in all four places it was duplicated: the opentui TUI logo
  component (`packages/tui/src/logo.ts`), its plain-ANSI counterpart
  (`packages/tui/src/util/presentation.ts`), and the non-TTY CLI banner
  (`packages/opencode/src/cli/ui.ts`). Untested visually — box-drawing art built by hand, needs a
  look in an actual terminal/TUI before shipping.

## What's explicitly NOT done (needs follow-up, not silently skipped)

- **`packages/opencode`'s actual command name is still `opencode`** — `.scriptName("opencode")`,
  the `yargs` usage text, and hint strings like `opencode -s <sessionID>` are all untouched
  on purpose: the wordmark now shows "Ratio" as a brand mark, but the binary you actually type is
  still `opencode` (same pattern as e.g. VS Code's `code` binary vs. its product name). Doing a
  full rename here means touching the real invoked command everywhere it's hinted at in help/output
  text across `packages/opencode` — a much larger, separate change from a cosmetic wordmark swap.
  Until that happens, "`ratio --version` prints Ratio branding" (AC) is only half true: the splash
  says Ratio, the `--version` flag just prints a bare semver number (it never printed a product name
  even before this rename), and the command you invoke is still `opencode`.
- **No Ratio release artifacts exist.** `install` now points at `github.com/pminev1/Axcode/releases`,
  but nothing is published there — the script is non-functional until a release pipeline exists.
- **Visual identity assets** (logo SVGs under `packages/console/app/src/asset/`, desktop/Electron
  icons) — not touched. This needs real design work, not a text rename.
- **Translated READMEs** (~20 files) still say OpenCode — deliberately left in English-only scope
  for this pass.
- `bun.lock` still references `lildax` — it only updates via `bun install`, which needs `node_modules`
  set up first.
