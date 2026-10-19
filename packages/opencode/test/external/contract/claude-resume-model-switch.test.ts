import { expect } from "bun:test"
import { contract } from "../record/harness"

// XCOD-270, #243: a model chosen with /models applies when the next turn resumes the session.
contract("claude", "resume-model-switch", ([first, second]) => {
  for (const step of [first!, second!]) expect(step.result).toMatchObject({ type: "result", ok: true })
  expect(second!.argv).toContain("--resume")
  expect(second!.argv[second!.argv.indexOf("--model") + 1]).toBe(second!.step.model!)
  const model = (step: typeof first) => {
    const init = step!.events.find((event) => event.type === "init")
    return init?.type === "init" ? init.model : undefined
  }
  // The resumed session runs the model asked for (an alias like `sonnet` names its full id).
  expect(model(second)).toContain(second!.step.model!.replace(/\[.*\]$/, ""))
  expect(model(second)).not.toBe(model(first))
})
