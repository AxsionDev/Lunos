import { describe, expect, test } from "bun:test"
import { checkDetails, checkLines } from "../../src/component/dialog-memory-setup"

describe("XCOD-263: the memory check's result in the setup wizard", () => {
  test("a failure shows the reason and the fix, and never an empty reason", () => {
    expect(
      checkLines({ ok: false, error: "Couldn't remember the test fact: during extraction, x", fix: "Pick another" }),
    ).toEqual(["✗ Couldn't remember the test fact: during extraction, x", "Fix: Pick another"])
    expect(checkLines({ ok: false, error: "  " })).toEqual(["✗ The check failed and gave no reason"])
    expect(checkLines({ ok: false })).toEqual(["✗ The check failed and gave no reason"])
  })

  test("Details lists stage, type, cause, model and log, skipping the unknown ones", () => {
    expect(
      checkDetails({
        ok: false,
        stage: "extraction",
        type: "CognifyFailedError",
        cause: null,
        model: "mistral/mistral-small-latest",
        log: "/m/logs/x.log",
      }),
    ).toEqual([
      { title: "Stage", value: "extraction" },
      { title: "Type", value: "CognifyFailedError" },
      { title: "Model", value: "mistral/mistral-small-latest" },
      { title: "Log", value: "/m/logs/x.log" },
    ])
  })
})
