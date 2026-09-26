// XCOD-107: reduced motion. Animations are the moon's reflection pulse on the home screen, the
// spinners and the prompt's placeholder cycling.
//
// - `reduced_motion: true` in TUI config turns them off, and the in-app toggle can't turn them
//   back on (an organisation or a user who needs this shouldn't be one keypress away from losing it).
// - `NO_COLOR` (set and non-empty) or `TERM=dumb` make "off" the default; the toggle still works.
// - Otherwise the in-app toggle ("Disable animations") decides, defaulting to on.

export function prefersReducedMotion(env: Record<string, string | undefined> = process.env) {
  return !!env.NO_COLOR || env.TERM === "dumb"
}

export function animationsEnabled(
  reducedMotion: boolean | undefined,
  stored: boolean | undefined,
  env: Record<string, string | undefined> = process.env,
) {
  if (reducedMotion === true) return false
  if (stored !== undefined) return stored
  if (reducedMotion === false) return true
  return !prefersReducedMotion(env)
}
