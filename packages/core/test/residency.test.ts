import { describe, expect, test } from "bun:test"
import { Residency } from "@opencode-ai/core/residency"

const EU_ONLY: Residency.Policy = { allow: ["eu"] }

describe("Residency.evaluate", () => {
  describe("under an EU-only policy", () => {
    test("permits EU-resident providers", () => {
      for (const id of ["mistral", "scaleway", "ovhcloud", "hetzner"]) {
        const decision = Residency.evaluate(id, EU_ONLY)
        expect(decision.allowed).toBe(true)
        expect(decision.region).toBe("eu")
      }
    })

    // The regression this guards against is subtle and would gut the epic: Scaleway, OVHcloud
    // and Hetzner are dispatched through the shared `openai-compatible` plugin. If the policy
    // ever evaluated the *plugin* id instead of the *provider* id, they would resolve as
    // untagged and be denied — the residency feature would block precisely the EU providers it
    // exists to enable, while still appearing to work.
    test("evaluates the catalog provider id, not the shared plugin id", () => {
      expect(Residency.evaluate("scaleway", EU_ONLY).allowed).toBe(true)
      expect(Residency.evaluate("openai-compatible", EU_ONLY).allowed).toBe(false)
    })

    test("blocks US providers", () => {
      const decision = Residency.evaluate("anthropic", EU_ONLY)
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("us")
    })
  })

  describe("fails closed", () => {
    test("denies providers with no recorded jurisdiction", () => {
      const decision = Residency.evaluate("some-unknown-provider", EU_ONLY)
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("no recorded data-processing jurisdiction")
    })

    // Azure *can* be EU. Nothing observable here proves this deployment chose an EU region, and
    // a policy that lets an unverified US-region resource through while reporting success is
    // worse than no policy at all.
    test("denies configurable providers whose region cannot be verified", () => {
      for (const id of ["azure", "amazon-bedrock", "google-vertex", "sap-ai-core"]) {
        const decision = Residency.evaluate(id, EU_ONLY)
        expect(decision.allowed).toBe(false)
        expect(decision.region).toBe("configurable")
      }
    })

    test("tells a configurable provider's user how to actually reach the EU", () => {
      expect(Residency.evaluate("amazon-bedrock", EU_ONLY).reason).toContain("eu-central-1")
    })

    test("denies gateways, which cannot guarantee any single jurisdiction", () => {
      const decision = Residency.evaluate("openrouter", EU_ONLY)
      expect(decision.allowed).toBe(false)
      expect(decision.reason).toContain("gateway")
    })
  })

  describe("explicit widening", () => {
    test("permits configurable providers once the deployer opts in", () => {
      expect(Residency.evaluate("azure", { allow: ["eu", "configurable"] }).allowed).toBe(true)
    })

    // Two different things are easily conflated here, and the difference matters:
    //
    //   - A provider *recorded as* `unknown` (openai-compatible, gateways) is one we have
    //     looked at and concluded we cannot determine. A deployer may knowingly opt into those.
    //   - A provider with *no entry at all* is one nobody has assessed. No policy can opt into
    //     that, because there is nothing to opt into — it is denied even by `allow: ["unknown"]`.
    test("permits providers recorded as unknown only when explicitly allowed", () => {
      expect(Residency.evaluate("openai-compatible", { allow: ["unknown"] }).allowed).toBe(true)
      expect(Residency.evaluate("openai-compatible", EU_ONLY).allowed).toBe(false)
    })

    test("denies never-assessed providers under any policy, including allow-unknown", () => {
      const everyRegion: Residency.Policy = { allow: ["eu", "us", "other", "configurable", "unknown"] }
      expect(Residency.evaluate("nope", everyRegion).allowed).toBe(false)
      expect(Residency.evaluate("nope", { allow: ["unknown"] }).allowed).toBe(false)
    })
  })

  test("every denial explains itself", () => {
    for (const id of ["anthropic", "azure", "openrouter", "not-a-provider"]) {
      const decision = Residency.evaluate(id, EU_ONLY)
      expect(decision.allowed).toBe(false)
      expect(decision.reason.length).toBeGreaterThan(40)
    }
  })
})

describe("Residency.DeniedError", () => {
  test("carries the decision and surfaces the reason in the message", () => {
    const decision = Residency.evaluate("anthropic", EU_ONLY)
    const err = new Residency.DeniedError(decision)

    expect(err.message).toContain("Blocked by data-residency policy")
    expect(err.message).toContain(decision.reason)
    expect(err.decision.providerID).toBe("anthropic")
  })
})

describe("Residency.record", () => {
  const at = new Date("2026-09-21T12:00:00.000Z")

  test("captures provider, jurisdiction and timestamp", () => {
    const entry = Residency.record("scaleway", "https://api.scaleway.ai/v1/chat/completions", true, at)

    expect(entry).toEqual({
      timestamp: "2026-09-21T12:00:00.000Z",
      providerID: "scaleway",
      region: "eu",
      basis: "both",
      host: "api.scaleway.ai",
      allowed: true,
    })
  })

  // An audit trail of what left and where it went must not itself become a copy of what left.
  test("records only the host, never the path or body", () => {
    const entry = Residency.record("anthropic", "https://api.anthropic.com/v1/messages?key=secret", false, at)

    expect(entry.host).toBe("api.anthropic.com")
    expect(JSON.stringify(entry)).not.toContain("secret")
    expect(JSON.stringify(entry)).not.toContain("messages")
  })

  test("survives an unparseable url rather than throwing mid-request", () => {
    expect(Residency.record("anthropic", "", true, at).host).toBe("unknown")
  })

  test("serialises as one JSON line per call", () => {
    const text = Residency.line(Residency.record("mistral", "https://api.mistral.ai/v1", true, at))

    expect(text.endsWith("\n")).toBe(true)
    expect(JSON.parse(text.trim()).providerID).toBe("mistral")
  })
})

describe("Residency.enforce", () => {
  const tmp = () => `${require("os").tmpdir()}/residency-enforce-${Math.random().toString(36).slice(2)}.log`
  const read = async (file: string) => {
    await Bun.sleep(20)
    const text = await Bun.file(file)
      .text()
      .catch(() => "")
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  test("a denied provider throws before any fetch exists, and the refusal is audited", async () => {
    const file = tmp()
    let called = false
    expect(() =>
      Residency.enforce({
        providerID: "anthropic",
        baseURL: "https://api.anthropic.com/v1",
        resolved: Residency.resolve({ allow: ["eu"] })!,
        defaultAuditPath: file,
        fetch: async () => {
          called = true
          return new Response()
        },
      }),
    ).toThrow(Residency.DeniedError)
    expect(called).toBe(false)
    expect(await read(file)).toMatchObject([{ providerID: "anthropic", host: "api.anthropic.com", allowed: false }])
  })

  test("an allowed provider's calls go through the inner fetch and are audited by host", async () => {
    const file = tmp()
    const seen: string[] = []
    const wrapped = Residency.enforce({
      providerID: "mistral",
      baseURL: "https://api.mistral.ai/v1",
      resolved: Residency.resolve({ allow: ["eu"] })!,
      defaultAuditPath: file,
      fetch: async (input) => {
        seen.push(String(input))
        return new Response("ok")
      },
    })!
    await wrapped("https://api.mistral.ai/v1/chat/completions?secret=x")
    expect(seen).toEqual(["https://api.mistral.ai/v1/chat/completions?secret=x"])
    expect(await read(file)).toMatchObject([{ providerID: "mistral", host: "api.mistral.ai", allowed: true }])
  })

  test("audit: false keeps enforcement but leaves the fetch untouched", () => {
    const inner = async () => new Response()
    const out = Residency.enforce({
      providerID: "mistral",
      baseURL: "",
      resolved: Residency.resolve({ allow: ["eu"], audit: false })!,
      defaultAuditPath: tmp(),
      fetch: inner,
    })
    expect(out).toBe(inner)
  })

  test("no residency block resolves to no policy", () => {
    expect(Residency.resolve(undefined)).toBeUndefined()
  })
})

describe("share hosts (XCOD-80)", () => {
  const EU = Residency.resolve({ allow: ["eu"] })!
  test("upstream's share service is denied under an EU-only policy", () => {
    expect(Residency.evaluate("share:opncd", EU.policy).allowed).toBe(false)
  })

  test('a self-hosted enterprise.url share server needs an explicit "unknown", like any self-hosted endpoint', () => {
    expect(Residency.evaluate("share:enterprise", EU.policy).allowed).toBe(false)
    expect(Residency.evaluate("share:enterprise", { allow: ["eu", "unknown"] }).allowed).toBe(true)
  })

  test("share hosts don't appear in the provider jurisdiction table", async () => {
    const { Jurisdiction } = await import("@opencode-ai/core/jurisdiction")
    expect(Jurisdiction.taggedProviders()).not.toContain("share:opncd")
    expect(Jurisdiction.isTagged("share:opncd")).toBe(true)
  })
})
