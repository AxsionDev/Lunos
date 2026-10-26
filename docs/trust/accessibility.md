# Accessibility

**Status: no accessibility statement or conformance report has been published yet.** No manual
EN 301 549 / WCAG 2.1 AA audit has been carried out: nobody has yet tested the terminal UI, the web or
desktop app, the VS Code extension or lunos.tech with a screen reader. That audit is tracked in
XCOD-141. When it is done, the statement and report will be published here, dated, and will say what
conforms, what partially conforms and what doesn't. Anything that wasn't tested will be marked
_not tested_, never _conformant_.

What exists today is automated checking and a few specific fixes. Automated checks catch only part of
WCAG, so none of this is a conformance claim.

## Web app (`packages/app`, also used by the desktop app)

- CI runs [axe-core](https://github.com/dequelabs/axe-core) with the WCAG 2.0/2.1 A and AA rules over
  the home screen, a session, a session with the review panel open, and each tab of the settings
  dialog, in both light and dark mode (the `accessibility (axe)` job in `.github/workflows/test.yml`).
  The job fails on any serious or critical finding.
- The scan uses the default theme with mocked server data. Other themes, other screens and the desktop
  app's native window chrome are not scanned.
- lunos.tech is a separate site and is not covered by this job.

## Terminal UI

From **v1.18.40**:

- A `high-contrast` theme: text and status colours at 7:1 contrast or more on its backgrounds.
- A `reduced_motion` setting that turns off every animation. Animations are also off by default when
  `NO_COLOR` is set or `TERM=dumb`.
- Error states that no longer rely on colour alone.

Not yet in a release: MCP, LSP and workspace status dots also change shape
(`•` connected, `✕` failed, `!` needs attention, `○` disabled, `…` connecting). The selected button
in permission prompts and confirm dialogs is marked with `›` as well as the highlight colour. Diffs
already show `+` and `-` beside changed lines, alongside the colour.

See [TUI configuration](../../packages/web/src/content/docs/tui.mdx) and
[themes](../../packages/web/src/content/docs/themes.mdx).
