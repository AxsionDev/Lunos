import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Installation } from "../../src/installation"
import { cachedLatest } from "../../src/cli/upgrade"

const file = () => path.join(Global.Path.state, "update-check.json")

describe("cachedLatest", () => {
  let calls = 0
  let latest: ReturnType<typeof spyOn>
  beforeEach(async () => {
    await Bun.file(file())
      .delete()
      .catch(() => {})
    calls = 0
    latest = spyOn(Installation, "latest").mockImplementation(async () => {
      calls++
      return "9.9.9"
    })
  })
  afterEach(() => latest.mockRestore())

  test("hits the registry at most once a day", async () => {
    const t0 = 1_000_000_000_000
    expect(await cachedLatest(t0)).toBe("9.9.9")
    expect(await cachedLatest(t0 + 60_000)).toBe("9.9.9")
    expect(await cachedLatest(t0 + 23 * 3_600_000)).toBe("9.9.9")
    expect(calls).toBe(1)
    await cachedLatest(t0 + 25 * 3_600_000)
    expect(calls).toBe(2)
  })

  test("keeps the last known version when the registry is unreachable", async () => {
    const t0 = 1_000_000_000_000
    await cachedLatest(t0)
    latest.mockImplementation(async () => {
      throw new Error("offline")
    })
    expect(await cachedLatest(t0 + 25 * 3_600_000)).toBe("9.9.9")
  })
})
