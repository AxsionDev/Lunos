import { describe, expect, test } from "bun:test"
import { updaterAction, updaterProgress } from "./updater-action"

describe("updaterAction", () => {
  test("disables update actions when the platform has no updater", () => {
    expect(updaterAction(undefined)).toEqual({ label: "settings.updates.action.checkNow" })
  })

  test("projects updater transitions into one settings action", () => {
    expect(updaterAction({ status: "idle" })).toEqual({
      label: "settings.updates.action.checkNow",
      run: "check",
    })
    expect(updaterAction({ status: "checking" })).toEqual({ label: "settings.updates.action.checking" })
    expect(updaterAction({ status: "downloading", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.downloading",
    })
    expect(updaterAction({ status: "ready", version: "2.0.0" })).toEqual({
      label: "toast.update.action.installRestart",
      run: "install",
    })
    expect(updaterAction({ status: "installing", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.installing",
    })
  })
})

describe("updaterProgress (XCOD-247)", () => {
  test("shows a step while checking, downloading or installing, and nothing otherwise", () => {
    expect(updaterProgress({ status: "checking" })).toEqual({ label: "settings.updates.action.checking" })
    expect(updaterProgress({ status: "downloading", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.downloading",
      version: "2.0.0",
      percent: undefined,
    })
    expect(updaterProgress({ status: "downloading", version: "2.0.0", percent: 41.6 })?.percent).toBe(42)
    expect(updaterProgress({ status: "installing", version: "2.0.0" })).toEqual({
      label: "settings.updates.action.installing",
      version: "2.0.0",
    })
    expect(updaterProgress({ status: "ready", version: "2.0.0" })).toBeUndefined()
    expect(updaterProgress({ status: "idle" })).toBeUndefined()
    expect(updaterProgress(undefined)).toBeUndefined()
  })
})
