import { describe, expect, test } from "bun:test"
import { MemorySetup } from "../src/memory-setup"

describe("memory setup wizard (XCOD-249)", () => {
  test("the recommended answers on a fresh install turn memory on, on this machine, encrypted", () => {
    const draft = MemorySetup.initial(undefined)
    expect(draft).toEqual({ enabled: true, backend: { type: "embedded" }, encryption: "os-keychain" })
    expect(MemorySetup.writes(draft, undefined, [])).toEqual([
      { key: "memory.enabled", value: "true" },
      { key: "memory.encryption", value: "os-keychain" },
    ])
  })

  test("pressing Enter through an unchanged setup writes nothing", () => {
    const memory = { enabled: true, encryption: "os-keychain" as const, retention: { days: 30 } }
    expect(MemorySetup.writes(MemorySetup.initial(memory), memory, [])).toEqual([])
  })

  test("a team Neo4j database writes its fields; going back to this machine resets the type", () => {
    const draft = {
      ...MemorySetup.initial(undefined),
      backend: {
        type: "neo4j" as const,
        url: "bolt+s://g:7687",
        username: "{env:U}",
        password: "{env:P}",
        jurisdiction: "EU-DE",
      },
      encryption: "off" as const,
    }
    expect(MemorySetup.writes(draft, undefined, []).map((write) => write.key)).toEqual([
      "memory.enabled",
      "memory.backend.type",
      "memory.backend.url",
      "memory.backend.username",
      "memory.backend.password",
      "memory.backend.jurisdiction",
    ])
    const memory = { enabled: true, backend: { type: "neo4j" }, encryption: "off" as const }
    expect(MemorySetup.writes(MemorySetup.initial(undefined), memory, [])).toContainEqual({
      key: "memory.backend.type",
      value: "embedded",
    })
  })

  test("locked keys are skipped; memory locked off stops the wizard", () => {
    const rows = [{ key: "memory.model", locked: true }]
    expect(MemorySetup.locked(rows, "memory.model")).toBe(true)
    const draft = { ...MemorySetup.initial(undefined), model: "openai/gpt-x" }
    expect(MemorySetup.writes(draft, undefined, rows).some((write) => write.key === "memory.model")).toBe(false)
    expect(MemorySetup.blocked([{ key: "memory.enabled", locked: true }], { enabled: false })).toContain("organisation")
    expect(MemorySetup.blocked([{ key: "memory.enabled", locked: true }], { enabled: true })).toBeUndefined()
  })

  test("removing a retention limit or a model unsets the key", () => {
    const memory = { enabled: true, model: "a/b", retention: { days: 90 }, encryption: "off" as const }
    const draft = { ...MemorySetup.initial(memory), model: undefined, retentionDays: undefined }
    expect(MemorySetup.writes(draft, memory, [])).toEqual([
      { key: "memory.model", unset: true },
      { key: "memory.retention.days", unset: true },
    ])
  })

  test("the summary names what would still win over the saved settings", () => {
    expect(
      MemorySetup.conflicts(
        [
          { key: "memory.enabled", source: "project" },
          { key: "memory.model", override: "LUNOS_DISABLE_MEMORY is set" },
        ],
        "user",
      ),
    ).toEqual([
      "memory.enabled is set in the project config, which wins over the user config",
      "memory.model: LUNOS_DISABLE_MEMORY is set",
    ])
  })

  test("status line", () => {
    expect(MemorySetup.status(undefined)).toBe("Memory: off")
    expect(MemorySetup.status({ enabled: true, model: "mistral/ministral-8b", encryption: "os-keychain" })).toBe(
      "Memory: on · this machine · model mistral/ministral-8b · encrypted",
    )
    expect(MemorySetup.status({ enabled: true }, "LUNOS_DISABLE_MEMORY")).toBe("Memory: off (LUNOS_DISABLE_MEMORY)")
  })
})
