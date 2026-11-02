import { expect, test } from "bun:test"
import { catppuccinTheme, resolveThemeVariant } from "@opencode-ai/ui/theme"
import { applyLunosTheme, lunosThemeVars } from "../src/theme"

// XCOD-272: the embed sits inside app.lunos.tech, which is dark only (Catppuccin Mocha, from the
// lunoshq design package). The embed takes the same look from @opencode-ai/ui's own Catppuccin theme,
// dark variant, and applies it to its mount element only, never to the host's :root.

test("the variables are Catppuccin's dark variant, with the host's fonts first", () => {
  const vars = lunosThemeVars()
  const mocha = resolveThemeVariant(catppuccinTheme.dark, true)
  expect(vars["--background-base"]).toBe(mocha["background-base"])
  expect(vars["--text-strong"]).toBe(mocha["text-strong"])
  expect(catppuccinTheme.dark.palette?.neutral).toBe("#1e1e2e")
  expect(vars["--font-family-sans"]).toStartWith("'IBM Plex Sans', ")
  expect(vars["--font-family-mono"]).toStartWith("'JetBrains Mono', ")
  // The v2 tokens the session UI also reads.
  expect(Object.keys(vars).some((k) => k.startsWith("--v2-"))).toBe(true)
})

test("applies to the mount element only, dark", () => {
  const set = new Map<string, string>()
  const el = {
    style: { setProperty: (k: string, v: string) => void set.set(k, v) },
    dataset: {} as Record<string, string>,
  }
  applyLunosTheme(el as unknown as HTMLElement)
  expect(set.get("color-scheme")).toBe("dark")
  expect(set.get("--background-base")).toBe(lunosThemeVars()["--background-base"])
  expect(el.dataset.lunosTheme).toBe("catppuccin-dark")
})
