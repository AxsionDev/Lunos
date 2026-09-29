import { describe, expect, test } from "bun:test"
import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { Residency } from "@opencode-ai/core/residency"

const eu: Residency.Policy = { allow: ["eu"] }
const tmp = () => `${require("os").tmpdir()}/residency-endpoints-${Math.random().toString(36).slice(2)}.log`
const read = async (file: string) => {
  let text = ""
  for (let i = 0; i < 100 && !text.trim(); i++) {
    await Bun.sleep(20)
    text = await Bun.file(file)
      .text()
      .catch(() => "")
  }
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe("residency endpoints (XCOD-121, XCOD-138)", () => {
  test("a built-in EU provider at its own API is allowed, with or without a baseURL", () => {
    expect(Residency.evaluate("mistral", eu).allowed).toBe(true)
    expect(Residency.evaluate("mistral", eu, "https://api.mistral.ai/v1").allowed).toBe(true)
    expect(Residency.evaluate("ovhcloud", eu, "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1").allowed).toBe(true)
  })

  test("XCOD-138: a built-in EU provider pointed at another host no longer passes an EU-only policy", () => {
    const decision = Residency.evaluate("mistral", eu, "https://evil.example.com/v1")
    expect(decision.allowed).toBe(false)
    expect(decision.region).toBe("unknown")
    // Nor does a host that merely contains the real one.
    expect(Residency.evaluate("mistral", eu, "https://api.mistral.ai.evil.example/v1").allowed).toBe(false)
  })

  test("a self-hosted endpoint is denied until declared, then allowed as declared", () => {
    const vllm = "http://10.0.0.5:8000/v1"
    const denied = Residency.evaluate("vllm", eu, vllm)
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toContain("residency.endpoints")
    const allowed = Residency.evaluate("vllm", { ...eu, endpoints: { vllm: { region: "eu" } } }, vllm)
    expect(allowed.allowed).toBe(true)
    expect(allowed.reason).toContain("declared")
  })

  test("a declaration can't change a built-in provider's claim for its own API", () => {
    const policy: Residency.Policy = { allow: ["eu"], endpoints: { anthropic: { region: "eu" } } }
    expect(Residency.evaluate("anthropic", policy).allowed).toBe(false)
    expect(Jurisdiction.resolve("anthropic", "https://api.anthropic.com", policy.endpoints).claim.basis).not.toBe(
      "declared",
    )
  })

  test("a declaration does cover a built-in provider at another host, e.g. a proxy in front of it", () => {
    const policy: Residency.Policy = { allow: ["eu"], endpoints: { mistral: { region: "eu", note: "eval proxy" } } }
    const decision = Residency.evaluate("mistral", policy, "http://host.docker.internal:9000/t/mistral/v1")
    expect(decision.allowed).toBe(true)
    expect(
      Jurisdiction.resolve("mistral", "http://host.docker.internal:9000/v1", policy.endpoints).claim,
    ).toMatchObject({
      basis: "declared",
      note: "eval proxy",
    })
  })

  test("the audit log records a declared endpoint as declared, with its host", async () => {
    const file = tmp()
    const wrapped = Residency.enforce({
      providerID: "vllm",
      baseURL: "http://gpu01.internal:8000/v1",
      resolved: Residency.resolve({ allow: ["eu"], endpoints: { vllm: { region: "eu", note: "vLLM in our DC" } } })!,
      defaultAuditPath: file,
      fetch: async () => new Response("ok"),
    })!
    await wrapped("http://gpu01.internal:8000/v1/chat/completions")
    expect((await read(file))[0]).toMatchObject({
      providerID: "vllm",
      region: "eu",
      basis: "declared",
      host: "gpu01.internal:8000",
      allowed: true,
    })
  })
})
