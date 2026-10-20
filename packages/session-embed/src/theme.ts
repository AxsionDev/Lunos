import { catppuccinTheme, resolveThemeVariant, resolveThemeVariantV2 } from "@opencode-ai/ui/theme"

// XCOD-272: lunoshq's app.lunos.tech is dark only, in Catppuccin Mocha (its @lunos/design package).
// The embed takes the same look from @opencode-ai/ui's Catppuccin theme, dark variant (Mocha), and
// sets it on its mount element only: the host's :root, and anything outside the element, keep their
// own variables. The fonts are the host's (JetBrains Mono, IBM Plex Sans), with ours as fallback.

const SANS = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

/** The CSS custom properties for the embed's dark Catppuccin look, by name (with the leading --). */
export function lunosThemeVars(): Record<string, string> {
  const tokens = {
    ...resolveThemeVariant(catppuccinTheme.dark, true),
    ...resolveThemeVariantV2(catppuccinTheme.dark, true),
  } as Record<string, string>
  return {
    ...Object.fromEntries(Object.entries(tokens).map(([k, v]) => [`--${k}`, v])),
    "--font-family-sans": `'IBM Plex Sans', ${SANS}`,
    "--font-family-mono": `'JetBrains Mono', ${MONO}`,
  }
}

/** Sets the dark Catppuccin look on `el` (and only there). */
export function applyLunosTheme(el: HTMLElement) {
  el.style.setProperty("color-scheme", "dark")
  for (const [k, v] of Object.entries(lunosThemeVars())) el.style.setProperty(k, v)
  el.dataset.lunosTheme = "catppuccin-dark"
}
