import { describe, expect, test } from "bun:test"
import type { Report } from "../../../../script/marketplace-check"
import { guard, keyEnv, parse, prompt } from "../../../../script/marketplace-judge"

// XCOD-198 AC6: the model's answer is only accepted in a fixed shape, and never overrides the facts.
const report: Report = {
  kind: "plugin",
  name: "opencode-skillful",
  status: "community",
  facts: { repo_archived: true },
  findings: [{ severity: "warn", criterion: "3", message: "the repository is archived (no active maintainer)" }],
  verdict: "keep-with-warning",
}

describe("marketplace judgement (XCOD-198)", () => {
  test("the prompt carries only the check's facts and findings", () => {
    const text = prompt(report)
    expect(text).toContain('"repo_archived":true')
    expect(text).toContain("the repository is archived")
    expect(text).toContain("Use ONLY the facts below")
  })

  test("a well-formed answer is accepted, even with text around it", () => {
    const answer =
      'Here you go:\n{"name":"opencode-skillful","recommendation":"keep-with-warning","reasons":["archived repo"],"user_note":"No longer maintained."}\n'
    expect(parse(answer, "opencode-skillful")).toEqual({
      name: "opencode-skillful",
      recommendation: "keep-with-warning",
      reasons: ["archived repo"],
      user_note: "No longer maintained.",
    })
  })

  test("a malformed or off-target answer is dropped", () => {
    expect(parse("no json", "x")).toBeUndefined()
    expect(parse('{"name":"other","recommendation":"keep","reasons":[]}', "x")).toBeUndefined()
    expect(parse('{"name":"x","recommendation":"verify-it","reasons":[]}', "x")).toBeUndefined()
    expect(parse('{"name":"x","recommendation":"keep","reasons":"one"}', "x")).toBeUndefined()
  })

  test("propose-verified is withdrawn while the facts have open findings", () => {
    const judged = guard({ name: report.name, recommendation: "propose-verified", reasons: ["fine"] }, report)
    expect(judged.recommendation).toBe("keep-with-warning")
    expect(judged.reasons.at(-1)).toContain("(guard)")
  })

  test("the provider's key variable comes from the model id", () => {
    expect(keyEnv("mistral/mistral-small-latest")).toBe("MISTRAL_API_KEY")
    expect(keyEnv("scaleway/qwen")).toBe("SCALEWAY_API_KEY")
    expect(keyEnv("openai/gpt-5.3-codex")).toBe("OPENAI_API_KEY")
  })
})
