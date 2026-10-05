import { describe, expect, test } from "bun:test"
import { ConfigPolicy } from "@/config/policy"
import { ConfigManaged } from "@/config/managed"

describe("ConfigPolicy (XCOD-102)", () => {
  test("a lock covers its sub-keys", () => {
    expect(ConfigPolicy.isLocked(["memory"], "memory.enabled")).toBe(true)
    expect(ConfigPolicy.isLocked(["memory.enabled"], "memory")).toBe(false)
    expect(ConfigPolicy.isLocked(["share"], "shared")).toBe(false)
  })

  // XCOD-201: the forwarding region is part of the audit.forward lock.
  test("under a lock on audit or audit.forward, user config can't add or change the forwarding region", () => {
    const managed = { audit: { forward: { syslog: "udp://siem.internal:514", region: "eu" } } }
    type Doc = { audit: { forward?: { syslog?: string; region?: string } } }
    const user: Doc = { audit: { forward: { syslog: "udp://elsewhere:514", region: "us" } } }
    for (const lock of ["audit", "audit.forward"]) {
      const next = ConfigPolicy.apply(user as Record<string, unknown>, managed, [lock]) as Doc
      expect(next.audit.forward).toEqual({ syslog: "udp://siem.internal:514", region: "eu" })
    }
    const unset = ConfigPolicy.apply(
      user as Record<string, unknown>,
      { audit: { forward: { syslog: "udp://siem.internal:514" } } },
      ["audit.forward"],
    ) as Doc
    expect(unset.audit.forward).toEqual({ syslog: "udp://siem.internal:514" })
  })

  test("apply replaces dotted keys and leaves siblings alone", () => {
    const next: Record<string, unknown> = ConfigPolicy.apply(
      { memory: { enabled: true, scope: ["user"] } } as Record<string, unknown>,
      { memory: { enabled: false } },
      ["memory.enabled"],
    )
    expect(next).toEqual({ memory: { enabled: false, scope: ["user"] }, $locked: ["memory.enabled"] })
  })

  test("strip drops $locked before a write", () => {
    const doc: Record<string, unknown> = { $locked: ["share"], share: "manual" }
    expect(ConfigPolicy.strip(doc)).toEqual({ share: "manual" })
  })

  test("omit removes a dotted leaf only", () => {
    const doc: Record<string, unknown> = { memory: { enabled: true, scope: ["user"] } }
    expect(ConfigPolicy.omit(doc, "memory.enabled")).toEqual({ memory: { scope: ["user"] } })
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
