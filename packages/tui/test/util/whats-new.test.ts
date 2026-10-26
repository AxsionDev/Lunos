import { expect, test } from "bun:test"
import { whatsNewOnStart } from "../../src/util/whats-new"

test("XCOD-248: the panel shows once per newer version, never on first install, a downgrade or a dev build", () => {
  expect(whatsNewOnStart({ current: "1.18.48", seen: "1.18.44", enabled: true })).toEqual({
    record: "1.18.48",
    show: { since: "1.18.44", to: "1.18.48" },
  })
  expect(whatsNewOnStart({ current: "1.18.48", seen: "1.18.48", enabled: true })).toEqual({})
  expect(whatsNewOnStart({ current: "1.18.47", seen: "1.18.48", enabled: true })).toEqual({})
  expect(whatsNewOnStart({ current: "1.18.48", seen: undefined, enabled: true })).toEqual({
    record: "1.18.48",
    hint: true,
  })
  expect(whatsNewOnStart({ current: "local", seen: "1.18.44", enabled: true })).toEqual({})
  // Turned off: recorded (so turning it back on doesn't replay old versions), but no panel.
  expect(whatsNewOnStart({ current: "1.18.48", seen: "1.18.44", enabled: false })).toEqual({ record: "1.18.48" })
})
