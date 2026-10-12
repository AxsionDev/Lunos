import { describe, expect, test } from "bun:test"
import {
  badge,
  cycle,
  editText,
  filterRows,
  hasSection,
  nextTab,
  parseSettingsSlash,
  sectionLabel,
} from "../../src/util/settings"

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

describe("section screens (XCOD-231)", () => {
  const rows = [
    row("subagent", "Subagent", "", { kind: "object" }),
    row("subagent.model", "Subagent model"),
    row("subagent.dynamic.allow", "Subagent dynamic allow", "", { kind: "list" }),
    row("compaction", "Compaction", "", { kind: "object" }),
    row("compaction.auto", "Compaction auto", "", { kind: "boolean" }),
    row("agent", "Agent", "", { kind: "object" }),
    row("agent_import", "Agent import"),
  ]
  test("an object with fields of its own has a screen; a free-form record doesn't", () => {
    expect(hasSection(rows[0], rows)).toBe(true)
    expect(hasSection(rows[3], rows)).toBe(true)
    // `agent_import` starts with "agent" but isn't one of its fields.
    expect(hasSection(rows[5], rows)).toBe(false)
    expect(hasSection(rows[1], rows)).toBe(false)
  })
  test("fields are named without the section in front, and the Subagent screen's in plain words", () => {
    expect(sectionLabel(rows[1], rows[0])).toBe("Model")
    expect(sectionLabel(rows[2], rows[0])).toBe("Allowed models")
    expect(sectionLabel(rows[4], rows[3])).toBe("Auto")
    expect(sectionLabel(row("x.y", "Other"), rows[3])).toBe("Other")
  })
})
