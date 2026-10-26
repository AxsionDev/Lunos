import { describe, expect, test } from "bun:test"
import { MODEL_WIDTH, row } from "../../src/component/dialog-background"

// XCOD-161: /tasks clipped the model column off whenever a job's title was long.
describe("/tasks rows", () => {
  test("the model is in the footer, beside status and elapsed time, which never shrinks", () => {
    expect(row({ agent: "explore", model: "mistral/codestral-latest", status: "running", elapsedMs: 75_000 })).toEqual({
      description: "explore",
      footer: "mistral/codestral-latest · running · 1m 15s",
    })
  })

  test("a long model id is shortened in the middle, deliberately, not clipped", () => {
    const model = "openrouter/anthropic/some-very-long-model-name-2026-10-01"
    const footer = row({ agent: "qa", model, status: "done", elapsedMs: 4_000 }).footer
    const shown = footer.split(" · ")[0]
    expect(shown).toHaveLength(MODEL_WIDTH)
    expect(shown).toContain("…")
    expect(shown.startsWith("openrouter/")).toBe(true)
    expect(shown.endsWith("2026-10-01")).toBe(true)
    expect(footer.endsWith(" · done · 4s")).toBe(true)
  })

  test("a job without a model, or without a time yet, shows what it has", () => {
    expect(row({ agent: "general", status: "running", elapsedMs: 3_000 }).footer).toBe("running · 3s")
    expect(row({ agent: "general", status: "pending", elapsedMs: "NaN" }).footer).toBe("pending")
  })
})
