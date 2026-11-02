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

describe("locked models (XCOD-219)", () => {
  const config = {
    $locked: ["model", "agent.review.model", "subagent.model"],
    model: "mistral/mistral-large-latest",
    subagent: { model: "mistral/codestral-latest" },
    agent: { review: { model: "mistral/magistral-medium" }, build: { model: "openai/gpt-x" } },
  }

  test("model, small_model, subagent.model and agent.<name>.model are known lock keys", () => {
    expect(ConfigPolicy.unknownKeys(["model", "small_model", "subagent.model", "agent.review.model"])).toEqual([])
    expect(ConfigPolicy.unknownKeys(["agent.review.prompt"])).toEqual(["agent.review.prompt"])
  })

  test("a main agent runs on its own locked model, else the locked model", () => {
    expect(ConfigPolicy.lockedModel(config, "review")).toEqual({
      key: "agent.review.model",
      model: "mistral/magistral-medium",
    })
    // build sets its own model, but only `model` is locked for it.
    expect(ConfigPolicy.lockedModel(config, "build")).toEqual({ key: "model", model: "mistral/mistral-large-latest" })
    expect(ConfigPolicy.lockedModel(config)).toEqual({ key: "model", model: "mistral/mistral-large-latest" })
  })

  test("a subagent follows agent.<name>.model, else subagent.model; a model lock alone doesn't pin it", () => {
    expect(ConfigPolicy.lockedSubagentModel(config, "review")?.key).toBe("agent.review.model")
    expect(ConfigPolicy.lockedSubagentModel(config, "explore")).toEqual({
      key: "subagent.model",
      model: "mistral/codestral-latest",
    })
    expect(ConfigPolicy.lockedSubagentModel({ ...config, $locked: ["model"] }, "explore")).toBeUndefined()
  })

  test("nothing is locked without a lock, or when managed config leaves the key unset", () => {
    expect(ConfigPolicy.lockedModel({ ...config, $locked: [] }, "review")).toBeUndefined()
    expect(ConfigPolicy.lockedSubagentModel({ ...config, $locked: [] }, "review")).toBeUndefined()
    expect(ConfigPolicy.lockedModel({ $locked: ["model"] })).toBeUndefined()
  })

  // An agent's own locked model must not be tagged, or its mode falls back to `model` and is refused.
  test("the session pickers offer the locked model and every locked agent model", () => {
    expect([...ConfigPolicy.sessionModels(config)!.allowed]).toEqual([
      "mistral/mistral-large-latest",
      "mistral/magistral-medium",
    ])
    expect(ConfigPolicy.sessionModels({ ...config, $locked: ["agent.review.model"] })).toBeUndefined()
  })

  test("the reason is the policy message and names the locked model", () => {
    expect(ConfigPolicy.modelLockReason({ key: "model", model: "mistral/mistral-large-latest" })).toBe(
      "model is set by your organisation's policy and can't be changed here (it is set to mistral/mistral-large-latest)",
    )
  })
})

// XCOD-310: a workflow's default approval can be locked, and decodes as a field, not a model option.
describe("agent.<name>.permission_mode (XCOD-310)", () => {
  test("is a key an organisation can lock", () => {
    expect(ConfigPolicy.isKnown("agent.dev-cycle.permission_mode")).toBe(true)
    expect(ConfigPolicy.isKnown("agent.dev-cycle.permission_modes")).toBe(false)
  })

  test("decodes as manual or auto, kept out of the provider options", async () => {
    const { ConfigAgentV1 } = await import("@opencode-ai/core/v1/config/agent")
    const { Schema } = await import("effect")
    const decoded = Schema.decodeUnknownSync(ConfigAgentV1.Info)({ permission_mode: "auto" })
    expect(decoded.permission_mode).toBe("auto")
    expect(decoded.options?.permission_mode).toBeUndefined()
    expect(() => Schema.decodeUnknownSync(ConfigAgentV1.Info)({ permission_mode: "yolo" })).toThrow()
  })
})
