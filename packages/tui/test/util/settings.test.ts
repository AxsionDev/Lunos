import { describe, expect, test } from "bun:test"
import { badge, cycle, editText, filterRows, nextTab, parseSettingsSlash } from "../../src/util/settings"

const row = (key: string, label: string, description = "", extra: Record<string, unknown> = {}) => ({
  key,
  label,
  description,
  kind: "string",
  display: "",
  source: "default",
  locked: false,
  ...extra,
})

describe("/settings (XCOD-128)", () => {
  test("/settings key=value and /config key=value set one value", () => {
    expect(parseSettingsSlash("/settings share=disabled")).toEqual({ key: "share", value: "disabled" })
    expect(parseSettingsSlash("/config  compaction.auto = false ")).toEqual({ key: "compaction.auto", value: "false" })
    expect(parseSettingsSlash('/settings residency.allow=["eu"]')).toEqual({ key: "residency.allow", value: '["eu"]' })
  })

  test("bare /settings is left to the slash list, and a missing = is explained", () => {
    expect(parseSettingsSlash("/settings")).toBeUndefined()
    expect(parseSettingsSlash("/settingsx a=b")).toBeUndefined()
    expect(parseSettingsSlash("/settings share")).toEqual({
      error: "Use /settings key=value, e.g. /settings share=disabled",
    })
  })

  test("typing filters by label, key and description, name matches first", () => {
    const rows = [
      row("share", "Share"),
      row("audit.enabled", "Audit enabled", "Also on whenever a residency policy is set"),
      row("residency", "Residency"),
      row("residency.allow", "Residency allow"),
    ]
    expect(filterRows(rows, "resid").map((r) => r.key)).toEqual(["residency", "residency.allow", "audit.enabled"])
    expect(filterRows(rows, "").length).toBe(4)
  })

  test("space flips booleans and cycles enums", () => {
    expect(cycle({ ...row("snapshot", "Snapshot"), kind: "boolean", value: true })).toBe("false")
    expect(cycle({ ...row("snapshot", "Snapshot"), kind: "boolean", value: undefined })).toBe("true")
    const share = { ...row("share", "Share"), kind: "enum", values: ["manual", "auto", "disabled"], value: "disabled" }
    expect(cycle(share)).toBe("manual")
    const autoupdate = {
      ...row("autoupdate", "Autoupdate"),
      kind: "enum",
      values: [true, false, "notify"],
      value: true,
    }
    expect(cycle(autoupdate)).toBe("false")
    expect(cycle(row("model", "Model"))).toBeUndefined()
  })

  test("badges name the layer, and a lock says so in text, not only colour", () => {
    expect(badge({ source: "project", locked: false })).toBe("project")
    expect(badge({ source: "managed", locked: true })).toBe("🔒 managed")
  })

  test("tabs wrap around, and lists edit as comma-separated text", () => {
    expect(nextTab("usage", 1)).toBe("status")
    expect(nextTab("status", -1)).toBe("usage")
    expect(editText({ ...row("residency.allow", "Residency allow"), value: ["eu", "us"] })).toBe("eu, us")
    expect(editText({ ...row("x", "X"), value: { a: 1 } })).toBe('{"a":1}')
  })
})
