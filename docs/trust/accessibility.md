# Accessibility

**Status: no accessibility statement or conformance report has been published yet.** An
EN 301 549 / WCAG 2.1 AA audit of the terminal UI, the desktop app and lunos.tech is in progress
(XCOD-107). The statement and report will be published here with the date of the audit, and they will
say what conforms, what partially conforms and what doesn't, based only on what was tested.

What exists today in the terminal UI (**from v1.18.40**):

- A `high-contrast` theme: text and status colours at 7:1 contrast or more on its backgrounds.
- A `reduced_motion` setting that turns off every animation; animations are also off by default when
  `NO_COLOR` is set or `TERM=dumb`.
- Error states that no longer rely on colour alone.

See [TUI configuration](../../packages/web/src/content/docs/tui.mdx) and
[themes](../../packages/web/src/content/docs/themes.mdx).
