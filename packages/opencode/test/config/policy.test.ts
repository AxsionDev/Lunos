import { describe, expect, test } from "bun:test"
import { ConfigPolicy } from "@/config/policy"
import { ConfigManaged } from "@/config/managed"

describe("ConfigPolicy (XCOD-102)", () => {
  test("a lock covers its sub-keys", () => {
    expect(ConfigPolicy.isLocked(["memory"], "memory.enabled")).toBe(true)
    expect(ConfigPolicy.isLocked(["memory.enabled"], "memory")).toBe(false)
    expect(ConfigPolicy.isLocked(["share"], "shared")).toBe(false)
  })

  test("apply replaces dotted keys and leaves siblings alone", () => {
    const next = ConfigPolicy.apply({ memory: { enabled: true, scope: ["user"] } }, { memory: { enabled: false } }, [
      "memory.enabled",
    ])
    expect(next).toEqual({ memory: { enabled: false, scope: ["user"] }, $locked: ["memory.enabled"] })
  })

  test("strip drops $locked before a write", () => {
    expect(ConfigPolicy.strip({ $locked: ["share"], share: "manual" })).toEqual({ share: "manual" })
  })

  test("unknown lock keys are reported, not dropped", () => {
    expect(ConfigPolicy.unknownKeys(["share", "future.key"])).toEqual(["future.key"])
  })

  test("Lunos managed paths per platform", () => {
    expect(ConfigManaged.systemManagedConfigDir("linux")).toBe("/etc/lunos")
    expect(ConfigManaged.systemManagedConfigDir("darwin")).toBe("/Library/Application Support/Lunos")
    expect(ConfigManaged.systemManagedConfigDir("linux", true)).toBe("/etc/opencode")
    expect(ConfigManaged.MANAGED_PLIST_DOMAIN).toBe("tech.lunos.managed")
  })

  test("the legacy location is read only when no Lunos location exists", () => {
    const pick = (present: string[]) =>
      ConfigManaged.pickManagedDir("/etc/lunos", "/etc/opencode", (dir) => present.includes(dir))
    expect(pick(["/etc/lunos", "/etc/opencode"])).toEqual({ dir: "/etc/lunos", legacy: false })
    expect(pick(["/etc/opencode"])).toEqual({ dir: "/etc/opencode", legacy: true })
    expect(pick([])).toEqual({ dir: "/etc/lunos", legacy: false })
  })
})
