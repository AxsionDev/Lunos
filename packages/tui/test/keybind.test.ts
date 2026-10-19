import { expect, test } from "bun:test"
import { TuiKeybind } from "../src/config/keybind"

test("resolves a legacy keybind alias onto its canonical name", () => {
  const { resolved, deprecated } = TuiKeybind.resolveKeybindAliases({ agent_list: "ctrl+a" })
  expect(resolved).toEqual({ mode_list: "ctrl+a" })
  expect(deprecated).toEqual([{ legacy: "agent_list", canonical: "mode_list" }])
})

test("does not overwrite an explicit canonical override with a legacy one", () => {
  const { resolved, deprecated } = TuiKeybind.resolveKeybindAliases({
    agent_list: "ctrl+a",
    mode_list: "ctrl+m",
  })
  expect(resolved).toEqual({ mode_list: "ctrl+m" })
  expect(deprecated).toEqual([{ legacy: "agent_list", canonical: "mode_list" }])
})

test("passes through configs with no legacy aliases unchanged", () => {
  const { resolved, deprecated } = TuiKeybind.resolveKeybindAliases({ session_list: "ctrl+l" })
  expect(resolved).toEqual({ session_list: "ctrl+l" })
  expect(deprecated).toEqual([])
})

test("parse() accepts legacy keybind names instead of hard-erroring", () => {
  expect(() => TuiKeybind.parse({ agent_list: "ctrl+a" } as TuiKeybind.KeybindOverrides)).not.toThrow()
  const parsed = TuiKeybind.parse({ agent_list: "ctrl+a" } as TuiKeybind.KeybindOverrides)
  expect(parsed.mode_list).toBe("ctrl+a")
})

test("parse() still rejects genuinely unknown keybind names", () => {
  expect(() => TuiKeybind.parse({ not_a_real_keybind: "ctrl+a" } as unknown as TuiKeybind.KeybindOverrides)).toThrow()
})

// XCOD-265: what is live while /sessions is open: its own actions, the list's keys and the leader.
// Stop all and Clear ship unbound (ctrl+x is the leader); whatever defaults they get later, none
// may shadow another key in that view.
test("no default in the Sessions view collides with another of its keys or with the leader", () => {
  const names = (Object.keys(TuiKeybind.Definitions) as (keyof typeof TuiKeybind.Definitions)[]).filter(
    (name) => name.startsWith("dialog.sessions.") || name.startsWith("dialog.select."),
  )
  const keys = names.flatMap((name) => {
    const value = TuiKeybind.defaultValue(name)
    if (!value || value === "none") return []
    return String(value)
      .split(",")
      .map((key) => ({ name, key: key.trim() }))
  })
  for (const { name, key } of keys) {
    if (!name.startsWith("dialog.sessions.")) continue
    // Tab / Shift+Tab move through the view's actions and Esc closes it (DialogSelect's own keys).
    const reserved = [TuiKeybind.LeaderDefault, "tab", "shift+tab", "escape"]
    expect({ name, key: reserved.includes(key) || key.startsWith("<leader>") }).toEqual({ name, key: false })
    const others = keys.filter((other) => other.key === key && other.name !== name).map((other) => other.name)
    expect({ name, key, others }).toEqual({ name, key, others: [] })
  }
  expect(TuiKeybind.defaultValue("dialog.sessions.stop_all")).toBe("none")
  expect(TuiKeybind.defaultValue("dialog.sessions.clear")).toBe("none")
})
