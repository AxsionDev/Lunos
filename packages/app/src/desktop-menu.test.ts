import { describe, expect, test } from "bun:test"
import { DESKTOP_MENU } from "./desktop-menu"

describe("desktop menu", () => {
  test("exports logs through the desktop command registry", () => {
    const items = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.labelKey === "desktop.menu.exportLogs",
    )

    expect(items).toHaveLength(2)
    expect(items.every((item) => item.type === "item" && item.command === "logs.export" && !item.action)).toBe(true)
  })

  test("Window → Sessions opens the Sessions window with a shortcut (XCOD-205)", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.id === "window")
    const item = windowMenu?.items?.find((entry) => entry.type === "item" && entry.action === "window.sessions")
    expect(item).toMatchObject({
      labelKey: "desktop.menu.sessions",
      accelerator: { macos: "Cmd+Option+S", windows: "Ctrl+Alt+S" },
    })
  })

  test("provides translated labels for role-backed entries", () => {
    const windowMenu = DESKTOP_MENU.find((menu) => menu.role === "windowMenu")
    const roleItems = DESKTOP_MENU.flatMap((menu) => menu.items ?? []).filter(
      (item) => item.type === "item" && item.role && item.labelKey,
    )

    expect(windowMenu?.labelKey).toBe("desktop.menu.window")
    expect(roleItems.length).toBeGreaterThan(0)
  })
})
