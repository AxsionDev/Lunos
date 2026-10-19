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

// XCOD-262: the ticket proposed <leader>m, which is model_list. The Agent Monitor's default must not
// shadow any other default binding (dev already has unrelated duplicates, so this checks only its own).
test("agent_monitor's default collides with no other default keybind", () => {
  const keys = (value: unknown): string[] =>
    typeof value === "string"
      ? value.split(",").map((key) => key.trim())
      : Array.isArray(value)
        ? value.flatMap(keys)
        : []
  const own = keys(TuiKeybind.defaultValue("agent_monitor"))
  expect(own).toEqual(["<leader>o"])
  const clashes = Object.entries(TuiKeybind.Definitions)
    .filter(([name]) => name !== "agent_monitor")
    .filter(([, item]) => keys(item.default).some((key) => own.includes(key)))
    .map(([name]) => name)
  expect(clashes).toEqual([])
  expect(TuiKeybind.CommandMap.agent_monitor).toBe("agent.monitor")
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

// XCOD-262 + XCOD-265: the Agent Monitor's own keys are live together while its rail is focused, and
// Stop all / Clear ship unbound in both views. None may shadow another monitor key or the leader.
test("the Agent Monitor's keys collide with neither each other, the leader nor XCOD-265's actions", () => {
  const names = (Object.keys(TuiKeybind.Definitions) as (keyof typeof TuiKeybind.Definitions)[]).filter(
    (name) => name.startsWith("monitor.") || name.startsWith("dialog.sessions."),
  )
  const keys = names.flatMap((name) => {
    const value = TuiKeybind.defaultValue(name)
    if (!value || value === "none") return []
    return String(value)
      .split(",")
      .map((key) => ({ name, key: key.trim() }))
  })
  for (const { name, key } of keys.filter((entry) => entry.name.startsWith("monitor."))) {
    expect({ name, key: key === TuiKeybind.LeaderDefault || key.startsWith("<leader>") }).toEqual({ name, key: false })
    const others = keys.filter((other) => other.key === key && other.name !== name).map((other) => other.name)
    expect({ name, key, others }).toEqual({ name, key, others: [] })
  }
  for (const name of [
    "monitor.stop_all",
    "monitor.clear",
    "dialog.sessions.stop_all",
    "dialog.sessions.clear",
  ] as const)
    expect(TuiKeybind.defaultValue(name)).toBe("none")
})
