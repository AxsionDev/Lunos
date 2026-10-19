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
