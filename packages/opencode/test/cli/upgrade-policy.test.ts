import { describe, expect, test } from "bun:test"
import { updateAction } from "../../src/cli/upgrade"

describe("updateAction", () => {
  test("never installs when autoupdate is unset, patch releases included", () => {
    expect(updateAction(undefined, "1.18.38", "1.18.39")).toBe("notify")
    expect(updateAction(undefined, "1.18.38", "1.19.0")).toBe("notify")
    expect(updateAction(undefined, "1.18.38", "2.0.0")).toBe("notify")
  })

  test("notify only announces", () => {
    expect(updateAction("notify", "1.18.38", "1.18.39")).toBe("notify")
  })

  test("an explicit true installs patch releases and announces the rest", () => {
    expect(updateAction(true, "1.18.38", "1.18.39")).toBe("install")
    expect(updateAction(true, "1.18.38", "1.19.0")).toBe("notify")
  })

  test("a dev build never gets a reminder instead of throwing", () => {
    expect(updateAction(undefined, "local", "1.18.40")).toBe("none")
  })

  test("false and up-to-date do nothing", () => {
    expect(updateAction(false, "1.18.38", "1.18.39")).toBe("none")
    expect(updateAction(undefined, "1.18.38", "1.18.38")).toBe("none")
  })
})
