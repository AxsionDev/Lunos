import { describe, expect, test } from "bun:test"
import { AuditLog } from "@/audit/log"
import { AuditForward } from "@/audit/forward"

describe("AuditLog.resolve (XCOD-103)", () => {
  test("off with no audit block and no residency policy", () => {
    expect(AuditLog.resolve({}).enabled).toBe(false)
  })

  test("on with a residency policy (its default), off when that policy opts out", () => {
    expect(AuditLog.resolve({ residency: { allow: ["eu"] } }).enabled).toBe(true)
    expect(AuditLog.resolve({ residency: { allow: ["eu"], audit: false } }).enabled).toBe(false)
    expect(AuditLog.resolve({ residency: { allow: ["eu"], audit: false }, audit: { enabled: true } }).enabled).toBe(
      true,
    )
  })

  test("audit.path wins over residency.auditPath", () => {
    expect(AuditLog.resolve({ residency: { auditPath: "/r.log" }, audit: { path: "/a.log" } }).file).toBe("/a.log")
    expect(AuditLog.resolve({ residency: { auditPath: "/r.log" } }).file).toBe("/r.log")
  })

  test("model calls are recorded without a residency policy, and never refused", () => {
    const resolved = AuditLog.residency({ audit: { enabled: true, path: "/a.log" } })
    expect(resolved).toMatchObject({ audit: true, enforce: false, auditPath: "/a.log" })
    expect(AuditLog.residency({})).toBeUndefined()
  })
})

describe("AuditForward (XCOD-103)", () => {
  test("destinations are 'unknown' to the residency policy; loopback is always allowed", () => {
    expect(AuditForward.allowed(new URL("udp://siem.internal:514"), undefined)).toBe(true)
    expect(AuditForward.allowed(new URL("udp://siem.internal:514"), ["eu"])).toBe(false)
    expect(AuditForward.allowed(new URL("udp://siem.internal:514"), ["eu", "unknown"])).toBe(true)
    expect(AuditForward.allowed(new URL("udp://127.0.0.1:514"), ["eu"])).toBe(true)
    expect(AuditForward.allowed(new URL("https://localhost:4318"), ["eu"])).toBe(true)
  })

  test("syslog lines are RFC 5424 with the audit facility and the JSON line as message", () => {
    const line = JSON.stringify({ v: 1, event: "tool.run" })
    expect(AuditForward.syslogMessage(line, "tool.run")).toMatch(/^<110>1 \S+ \S+ lunos \d+ tool\.run - \{"v":1/)
  })

  test("OTLP bodies carry each line verbatim with its event", () => {
    const line = JSON.stringify({ v: 1, event: "upgrade", timestamp: "2026-09-25T00:00:00.000Z" })
    const record = AuditForward.otlpBody([line]).resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.body.stringValue).toBe(line)
    expect(record.attributes).toEqual([{ key: "event", value: { stringValue: "upgrade" } }])
  })
})
