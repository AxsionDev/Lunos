---
name: project-lunos-web-contrast-tokens
description: Exact WCAG contrast ratios for the Lunos design system's overlay/subtext color tokens against --base and --crust, measured in Task 11's axe-core pass — --overlay1 fails AA against --base despite looking safe.
metadata:
  type: project
---

Computed exact WCAG relative-luminance contrast ratios (not eyeballed) for `Lunos.Web/src/styles/tokens.scss`'s secondary-text tokens against the two dark backgrounds they're commonly used on:

| Token | vs. `--base` (#1e1e2e) | vs. `--crust` (#11111b) |
|---|---|---|
| `--overlay0` (#6c7086) | 3.36:1 | 3.84:1 |
| `--overlay1` (#7f849c) | **4.44:1 — fails AA (4.5:1)** | 5.07:1 — passes |
| `--subtext0` (#a6adc8) | 7.37:1 | 8.42:1 |
| `--subtext1` (#bac2de) | 9.26:1 | 10.59:1 |

**Why:** the Phase 1 plan's Task 11 brief claimed `--overlay1` gives "~5.4:1 against `--crust`/`--base`" as if the two backgrounds were interchangeable for this purpose — they're not. `--overlay1` on `--crust` passes AA; `--overlay1` on `--base` (a lighter background) does not. `Lunos.Web/src/app/shared/footer/footer.component.ts`'s `<footer>` has no explicit background, so it inherits `body`'s `background: var(--base)`, and axe-core (`@axe-core/cli`) correctly flagged this as a real `color-contrast` violation. Fixed by switching the footer to `--subtext1`, matching the token other components (`nav-bar`, `hero-scene`'s tagline, `sovereignty-strip`, `contact`'s form labels) already use for secondary/body text.

**How to apply:** when styling body/secondary text on a `--base`-background element in future tasks, use `--subtext0` or `--subtext1`, not `--overlay1` — `--overlay1` only clears AA on the darker `--crust` background. `--overlay0` fails AA as body text against both and should be reserved for non-text UI (borders, dividers — WCAG's 3:1 non-text threshold), same as its existing use in `hero-scene.component.ts`'s `.water` border.

See also [[project_lunos_web_prerender]].
