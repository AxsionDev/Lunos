import { expect } from "bun:test"
import { contract, unhandled } from "../record/harness"

// XCOD-270, #243: the shape of Codex's `model/list`, which `/models` offers.
contract("codex", "start-models", ([start]) => {
  const pages = start!.tool.filter((m) => m?.result && (Array.isArray(m.result.data) || Array.isArray(m.result.models)))
  expect(pages.length).toBeGreaterThan(0)
  const listed = pages.reduce((count, page) => count + (page.result.data ?? page.result.models).length, 0)
  expect(start!.models!.length).toBe(listed)
  expect(start!.models!.filter((model) => model.default).length).toBe(1)
  expect(start!.tool.filter((m) => m?.error)).toEqual([])
  expect(unhandled(start!)).toEqual([])
})
