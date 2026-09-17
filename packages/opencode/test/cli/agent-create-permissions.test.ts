import { test, expect, describe } from "bun:test"
import {
  AVAILABLE_PERMISSIONS,
  DEFAULT_ALLOWED_PERMISSIONS,
  HIGH_RISK_PERMISSIONS,
  buildPermissionConfig,
  detectIntentMismatch,
  resolveSelectedPermissions,
} from "../../src/cli/cmd/agent"

describe("DEFAULT_ALLOWED_PERMISSIONS", () => {
  test("omits the high-risk permissions", () => {
    for (const permission of HIGH_RISK_PERMISSIONS) {
      expect(DEFAULT_ALLOWED_PERMISSIONS).not.toContain(permission)
    }
  })

  test("keeps read-only permissions available by default", () => {
    for (const permission of ["read", "grep", "glob", "webfetch", "websearch"]) {
      expect(DEFAULT_ALLOWED_PERMISSIONS).toContain(permission)
    }
  })

  test("only contains known permissions", () => {
    for (const permission of DEFAULT_ALLOWED_PERMISSIONS) {
      expect(AVAILABLE_PERMISSIONS).toContain(permission)
    }
  })
})

describe("resolveSelectedPermissions", () => {
  test("omitting --permissions falls back to conservative defaults, not everything", () => {
    expect(resolveSelectedPermissions(undefined)).toEqual(DEFAULT_ALLOWED_PERMISSIONS)
  })

  test("an empty --permissions value grants nothing extra rather than everything", () => {
    expect(resolveSelectedPermissions("")).toEqual(DEFAULT_ALLOWED_PERMISSIONS)
  })

  test("explicit opt-in is honored", () => {
    expect(resolveSelectedPermissions("read,edit,bash")).toEqual(["read", "edit", "bash"])
  })

  test("trims whitespace and drops empty entries", () => {
    expect(resolveSelectedPermissions(" read , grep ,, ")).toEqual(["read", "grep"])
  })

  test("deduplicates repeated entries", () => {
    expect(resolveSelectedPermissions("read,read,grep")).toEqual(["read", "grep"])
  })
})

describe("buildPermissionConfig", () => {
  test("denies every permission that was not selected", () => {
    const result = buildPermissionConfig(["read", "grep"])
    expect(result["edit"]).toBe("deny")
    expect(result["bash"]).toBe("deny")
    expect(result["task"]).toBe("deny")
    expect(result["read"]).toBeUndefined()
    expect(result["grep"]).toBeUndefined()
  })

  test("conservative defaults produce a non-empty deny block", () => {
    // AC#4: a newly created agent must carry a visible deny block for the
    // high-risk permissions unless the user explicitly enabled them.
    const result = buildPermissionConfig(DEFAULT_ALLOWED_PERMISSIONS)
    expect(Object.keys(result).length).toBeGreaterThan(0)
    for (const permission of HIGH_RISK_PERMISSIONS) {
      expect(result[permission]).toBe("deny")
    }
  })

  test("selecting everything writes no denies", () => {
    expect(buildPermissionConfig(AVAILABLE_PERMISSIONS)).toEqual({})
  })

  test("ignores unknown permission names", () => {
    const result = buildPermissionConfig(["read", "not-a-permission"])
    expect(result["not-a-permission"]).toBeUndefined()
  })
})

describe("detectIntentMismatch", () => {
  test("flags edit/bash granted to a research-sounding agent", () => {
    const result = detectIntentMismatch({
      text: "For research and understanding, no code changes.",
      selected: ["read", "edit", "bash"],
    })
    expect(result).toEqual(["bash", "edit"])
  })

  test("stays silent when a research-sounding agent is properly restricted", () => {
    const result = detectIntentMismatch({
      text: "Investigate and explain the codebase. Read-only.",
      selected: DEFAULT_ALLOWED_PERMISSIONS,
    })
    expect(result).toEqual([])
  })

  test("stays silent for an implementation agent with edit access", () => {
    const result = detectIntentMismatch({
      text: "Implements features and refactors modules across the codebase.",
      selected: ["read", "edit", "bash"],
    })
    expect(result).toEqual([])
  })

  test("matches intent language anywhere in the combined text", () => {
    const result = detectIntentMismatch({
      text: "Codebase auditor. Use when you need to investigate a subsystem.",
      selected: ["edit"],
    })
    expect(result).toEqual(["edit"])
  })
})
