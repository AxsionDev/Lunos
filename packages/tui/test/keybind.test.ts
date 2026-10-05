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
