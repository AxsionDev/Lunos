# XCOD-20 AC-3 — splash and default theme, verified in a real terminal

**Date:** 2026-09-18
**Ticket:** XCOD-20 (Clean-machine install — Phase 0 exit criterion)
**Scope:** AC-3 only — splash (XCOD-6) and default theme (XCOD-2). AC-1 and AC-2 were closed
earlier; see `xcod-sprint-closeout-assessment.md:199-222`.
**Result:** **AC-3 passes.** Both the splash and the default theme render correctly. One unrelated
defect was found while looking (see "Defect found").

---

## Why this was open

The sprint closeout assessment recorded AC-3 as unverifiable: "both need an interactive TTY that a
scripted container run cannot exercise" (`xcod-sprint-closeout-assessment.md:208-209`). The source
comments say the same thing — `packages/tui/src/logo.ts:4` and `:20` both read "needs a look in an
actual terminal/TUI before shipping."

That conclusion conflated _no TTY_ with _no terminal_. A TUI gates rendering on
`process.stdout.isTTY`; piping to a file makes that false, but a **pseudo-terminal** makes it true.
So the check was reachable all along with a pty allocator.

## Method

`script(1)` allocates a pty but on macOS ignores `COLUMNS`/`LINES`, so the child inherits an 80x24
window — the home screen overflows and the wordmark scrolls off the top. (This was observed: the
first capture at 80x24 showed moon and water but no `lunos` wordmark.) The fix is to set
`TIOCSWINSZ` on the master fd explicitly, which `script` gives no way to do.

The harness therefore uses Python's `pty.fork()` + `fcntl.ioctl(TIOCSWINSZ)` at 120x45, captures the
raw stream, and replays it through a minimal ANSI screen emulator (honouring `CSI H/m/K/J`) to
recover the final frame. Scripts are in the session scratchpad: `ptyrun.py`, `render.py`,
`whichtheme.py`.

Run from the `dev` checkout at `574da7e7a5` (identical commit to the task worktree, deps installed),
via `bun run dev` → `packages/opencode/src/index.ts`. Two runs:

| Run    | `HOME`                            | Purpose                                          |
| ------ | --------------------------------- | ------------------------------------------------ |
| `real` | the developer's own               | Splash rendering under normal conditions         |
| `iso`  | throwaway dir, `XDG_*` redirected | **Default** theme with no config and no kv store |

The isolated run is what makes the theme claim about the _default_ rather than about one machine's
saved preference.

## AC-3a — splash renders correctly ✅

Final frame, isolated run, 120x45:

```
                                                          lunos
                                             ▄▄▄        ▄▄▄▄▄▄▄▄▄        ▄▄▄
                                          ▄▄▄▄▄▄▄▄▄   ▄███████████▄   ▄▄▄▄▄▄▄▄▄
                                                     ▄█████████████▄
                                                     ███████████████
                                                     ███████████████
                                                     ▀█████████████▀
                                                      ▀███████████▀
                                                        ▀▀▀▀▀▀▀▀▀
                                          ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
                                          ~~~~~~~~~~~≈≈≈≈≈≈≈≈≈≈≈≈≈≈≈~~~~~~~~~~~
                                          ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
                                          ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
```

Checked against the spec in `packages/tui/src/logo.ts:21-39`:

| Spec              | Declared                                      | Rendered                         | OK  |
| ----------------- | --------------------------------------------- | -------------------------------- | --- |
| `wordmark`        | `"lunos"`                                     | present, centred above the art   | ✅  |
| `moon`            | 8 rows                                        | 8 rows, tapered top and bottom   | ✅  |
| `cloud`           | 2 rows, one each side                         | both flanks present, top-aligned | ✅  |
| `waterWidth`      | 37                                            | 37 columns                       | ✅  |
| `reflectionWidth` | 15                                            | 15 `≈` centred under the moon    | ✅  |
| reflection inset  | woven into the water row, not a separate line | confirmed — row 2 of the band    | ✅  |

The reflection is centred: 11 + 15 + 11 = 37, matching `WATER_SIDE_WIDTH` at
`packages/tui/src/component/logo.tsx:24-25`. Composition ("Moonlit cove", XCOD-6/XCOD-37) is intact.

**Note on splash colours:** the splash uses a fixed brand palette
(`packages/tui/src/component/logo.tsx:7-21` — `MOON_COLOR #fdf3d0`, `WATER_COLOR #5f8fc7`, etc.),
deliberately independent of the active theme so it reads the same under all 30+ themes. Splash and
theme are therefore genuinely separate checks, not one check.

## AC-3b — default theme is Catppuccin Mocha ✅

Two independent lines of evidence agree.

**Code path.** `packages/tui/src/context/theme.tsx:121`:

```ts
const active = config.theme ?? kv.get("theme", "catppuccin")
```

With no config file and no kv entry — the isolated run's exact state — this resolves to
`catppuccin`.

Config is searched in two places, and **both were ruled out**, not just `$HOME`:

- _User level_ — the isolated run redirected `HOME` and `XDG_*` to a throwaway directory.
- _Project level_ — `theme.tsx:41` also searches `path.join(current, ".opencode")`. This repo does
  have a gitignored `.opencode/`, so it was inspected directly: neither `.opencode/opencode.jsonc`
  nor `.opencode/tui.json` contains a `theme` key, `.opencode/themes/mytheme.json` is merely
  registered as a custom theme (never selected), and the `tui-smoke.tsx` plugin that calls
  `api.theme.set(...)` is configured `"enabled": false`. Both runs shared a cwd, so this check —
  not the real-vs-iso comparison — is what rules out a project-local override.

**Empirical.** Scoring the truecolor SGR runs actually emitted against all 30 theme assets in
`packages/tui/src/theme/assets/` (splash palette excluded, since it is theme-independent):

```
capture: iso.raw   distinct non-splash colours: 141
  frac  hit/decl  weight  theme
  0.10    6/61      1459  catppuccin      <-- decisive
  0.04    1/25        56  lucent-orng
  0.03    1/30        56  mercury
  0.03    1/35        56  github
```

Every matched value is the **dark** variant; no `light` variant value appears anywhere:

| Role                | Dark value | Glyphs painted |
| ------------------- | ---------- | -------------- |
| `background`        | `#1e1e2e`  | 1424           |
| `backgroundElement` | `#11111b`  | 15             |
| `text`              | `#cdd6f4`  | 4              |
| `textMuted`         | `#9399b2`  | 9              |
| `secondary`         | `#cba6f7`  | 6              |

So the active default is **Catppuccin Mocha (dark)**. This is consistent with the approved design:
`component/logo.tsx:7-8` describes the splash palette as "Catppuccin Mocha values from the approved
mockup."

The `real` and `iso` runs scored identically (weight 1422 vs 1459, same six colours), consistent with
no user-level override.

**This default is a deliberate Lunos change, not an upstream inheritance.** Upstream still ships the
`opencode` theme as its default:

```
$ git show upstream/dev:packages/tui/src/context/theme.tsx | grep 'kv.get("theme"'
121:        const active = config.theme ?? kv.get("theme", "opencode")
```

The fork changed it in `6e3fc97d5d`, "fix(tui): default to Catppuccin Mocha instead of opencode
theme", whose message **names XCOD-2 directly**:

> XCOD-2: switches all 7 default-theme references in theme.tsx … from "opencode" to "catppuccin".
> The opencode theme and all other built-ins remain fully selectable via /theme — only the default
> changes. Confirmed catppuccin.json resolves to Mocha (#1e1e2e) dark / Latte (#eff1f5) light bases.

That commit independently names the same `#1e1e2e` Mocha dark base this run measured across 1424
painted glyphs. So the intended default, the implemented default, and the rendered default all
agree — AC-3b passes without needing XCOD-2's Jira text.

## Defect found — `opencode`-branded tips on the Lunos home screen

Visible directly in the captured frame:

```
                                ● Tip Run opencode agent create for guided agent creation
```

`packages/tui/src/feature-plugins/home/tips-view.tsx:237-248` contains a block of tips still using
the `opencode` command name and product name:

```
"Use {highlight}opencode run{/highlight} for non-interactive scripting"
"Use {highlight}opencode --continue{/highlight} to resume the last session"
"Run {highlight}opencode serve{/highlight} for headless API access to OpenCode"
"Run {highlight}opencode agent create{/highlight} for guided agent creation"
"Run {highlight}opencode upgrade{/highlight} to update to the latest version"
...
```

25 lines in that file reference `opencode`/`OpenCode`.

**This is not cosmetic.** The installed binary is `lunos` (`install:3` sets `APP=lunos`), so every
one of these tips instructs a user to run a command that does not exist on their machine. It is a
first-run experience bug on the home screen, in XCOD-23's rebrand scope but missed because the
rebrand sweep was textual and nobody had looked at the running TUI.

**Do not "fix" the provider attribution.** The same screen shows `Big Pickle OpenCode Zen` in the
model line — "OpenCode Zen" is a provider name and is deliberately excluded from the rebrand.
Only the command names and the standalone product references should change.

Filed as **XCOD-56**. Outside XCOD-20's ACs, so it does not block Phase 0 exit — but it is a
launch-readiness item, since XCOD-31's publication gate opens partly on XCOD-20 and the launch post
drives new users straight at this screen.

## Session note — Jira unreachable

The Atlassian MCP server was wedged for the whole session: three `getJiraIssue` calls and a
zero-parameter `getAccessibleAtlassianResources` probe all died at the 300s idle timeout. Since the
no-argument probe hung too, the fault is the server/session, not the query. Jira worked earlier the
same day, so a server restart is the likely remedy. AC text used here comes from
`xcod-sprint-closeout-assessment.md`, a secondary source.

## Bottom line

AC-3 passes on evidence, not on an owner ruling. With AC-1 and AC-2 already closed, **XCOD-20's
acceptance criteria are met** and the Phase 0 exit gate — which `xcod-31-build-in-public-cadence.md`
and `lunos-marketing-gtm-plan.md` both hang publication on — is clear from XCOD-20's side. XCOD-15
is a separate gate and is not addressed here.
