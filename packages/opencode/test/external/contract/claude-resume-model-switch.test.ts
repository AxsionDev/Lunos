import { expect } from "bun:test"
import { contract } from "../record/harness"

// XCOD-270, #243: a model chosen with /models applies when the next turn resumes the session.
contract("claude", "resume-model-switch", ([first, second]) => {
  for (const step of [first!, second!]) expect(step.result).toMatchObject({ type: "result", ok: true })
  expect(second!.argv).toContain("--resume")
  expect(second!.argv[second!.argv.indexOf("--model") + 1]).toBe(second!.step.model!)
  const model = (step: typeof first) => step!.events.find((event) => event.type === "init")
  expect(model(second)).toBeDefined()
  expect(model(second)).not.toEqual(model(first))
})
