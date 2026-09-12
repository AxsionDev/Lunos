# XCOD-4: Rename to Lunos — Decisions & Status

Supersedes XCOD-1 (AXCODE → Ratio). Product name changed again, from **Ratio** to **Lunos**
(Petar Minev, 2026-09-12), before Phase 0 exit.

## Naming collision (AC: "acknowledged and accepted, or name reconsidered")

**Decision: accepted, keep the name.** `lunos.ai` (funded AI-agents startup, accounts-receivable
automation) and `lunosrouter.com` (LLM router) are separate, unrelated parties already using
"Lunos" in adjacent AI-agent space. `lunos.tech` is not a collision — it's Petar's own domain.
Proceeding with "Lunos" anyway per Petar's explicit call (2026-09-12); no product-category overlap
with either party (neither is a CLI coding agent).

## Repo/org naming decision (AC: "rename now vs. defer")

**Decision: rename now** — reversing XCOD-1's "defer" default. `pminev1/Axcode` → `pminev1/Lunos`,
executed via `gh repo rename` (GitHub auto-redirects the old URL for existing clones/links).

## What actually changed in this pass

- Root `package.json`: `name` → `lunos`, `description` updated, `repository`/`homepage` →
  `pminev1/Lunos`.
- `packages/cli`: bin `ratio` → `lunos` (`bin/ratio.cjs` → `bin/lunos.cjs`, `package.json`,
  `script/build.ts` binary var, `script/publish.ts` cp/bin paths, `bun.lock` bin entry). Internal
  wrapper strings (`.ratio` cache dir, error message) updated to `lunos`.
- `install`: `APP=lunos`, install dir `~/.lunos/bin`, usage text, temp-dir naming
  (`lunos_install_$$`), PATH-append comment, closing messages, ASCII wordmark, GitHub URLs
  repointed to `pminev1/Lunos`.
- `README.md` / `CONTRIBUTING.md`: Ratio → Lunos in the fork/non-affiliation/EU-positioning note;
  dropped the fabricated Latin-etymology line (Lunos, unlike Ratio, has no established Latin
  meaning worth claiming).
- `packages/cli/src/commands/commands.ts`: CLI display-name fallback `"ratio"` → `"lunos"`;
  `--help` description now "Lunos 2.0 preview...".
- Redrew the ASCII wordmark as "LUNOS" in all four places it was duplicated: the opentui TUI logo
  component (`packages/tui/src/logo.ts`), its plain-ANSI counterpart
  (`packages/tui/src/util/presentation.ts`), the non-TTY CLI banner
  (`packages/opencode/src/cli/ui.ts`), and the separate, simpler wordmark printed at the end of
  `install`. Hand-built box-drawing art (same approach XCOD-1 used) — **untested visually, needs a
  look in an actual terminal/TUI before shipping**, same caveat as XCOD-1's Ratio redraw.
- GitHub repo renamed `pminev1/Axcode` → `pminev1/Lunos`.

## What's explicitly NOT done (carried over from XCOD-1, still true)

- **`packages/opencode`'s actual command name is still `opencode`** — same reasoning as XCOD-1:
  the wordmark shows "Lunos" as a brand mark, but the binary you type there is still `opencode`.
  Untouched on purpose; a much larger, separate change.
- **No Lunos release artifacts exist.** `install` points at `github.com/pminev1/Lunos/releases`,
  but nothing is published there yet — non-functional until a release pipeline exists.
- **Visual identity assets** (logo SVGs under `packages/console/app/src/asset/`, desktop/Electron
  icons) — not touched. Still needs real design work, not a text rename. (These currently still
  carry the "R" monogram from Ratio — XCOD-3 territory.)
- **Translated READMEs** (~20 files) — left in English-only scope, same as XCOD-1.
- The XCOD-1 decision doc (`xcod-1-ratio-rename-decisions.md`) is left untouched as a historical
  record; its `lildax`/`pminev1/Axcode` references describe what was true *at that time*, not the
  current state.
