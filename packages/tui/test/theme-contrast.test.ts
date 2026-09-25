import { describe, expect, test } from "bun:test"
import { DEFAULT_THEMES } from "../src/theme"

// XCOD-107: the high-contrast theme's promise, pinned. WCAG 2.1 contrast ratio from relative
// luminance; ≥7:1 is AAA for normal text (AA needs 4.5:1).
function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

const theme = DEFAULT_THEMES["high-contrast"] as unknown as {
  defs: Record<string, string>
  theme: Record<string, { dark: string; light: string }>
}
const color = (key: string, mode: "dark" | "light") => theme.defs[theme.theme[key][mode]]

describe("high-contrast theme (XCOD-107)", () => {
  test("defines every key the default theme does", () => {
    expect(Object.keys(theme.theme).sort()).toEqual(
      Object.keys((DEFAULT_THEMES.opencode as unknown as { theme: object }).theme).sort(),
    )
  })

  for (const mode of ["dark", "light"] as const) {
    test(`${mode}: text and status colours reach 7:1 on the background and on elements`, () => {
      for (const fg of ["text", "textMuted", "primary", "secondary", "accent", "error", "warning", "success", "info"])
        for (const bg of ["background", "backgroundPanel", "backgroundElement"])
          expect({ fg, bg, ratio: ratio(color(fg, mode), color(bg, mode)) >= 7 }).toEqual({ fg, bg, ratio: true })
    })
  }
})
