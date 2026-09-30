import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { newVersionMessage, newVersionNotice, updateRestartHint } from "@opencode-ai/core/installation/version"
import { Installation } from "../../src/installation"
import { checkLatest, notice } from "../../src/cli/upgrade"
import { isUpToDate, manualUpdateCommand, UpgradeCommand, upToDateMessage } from "../../src/cli/cmd/upgrade"

const file = () => path.join(Global.Path.state, "update-check.json")
const t0 = 1_000_000_000_000

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
afterEach(() => {
  latest.mockRestore()
  delete process.env.LUNOS_OFFLINE
})

describe("checkLatest (XCOD-147)", () => {
  test("asks the registry on every start, not once a day", async () => {
    expect(await checkLatest(t0)).toBe("9.9.9")
    expect(await checkLatest(t0 + 60_000)).toBe("9.9.9")
    expect(calls).toBe(2)
  })

  test("falls back to the last known version when the registry fails", async () => {
    await checkLatest(t0)
    latest.mockImplementation(async () => {
      throw new Error("offline")
    })
    expect(await checkLatest(t0 + 60_000)).toBe("9.9.9")
  })

  test("gives up after the timeout and uses the cached version", async () => {
    await checkLatest(t0)
    latest.mockImplementation(() => new Promise(() => {}))
    const started = performance.now()
    expect(await checkLatest(t0 + 60_000, 50)).toBe("9.9.9")
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("stops waiting when told to (a finished CLI command) and uses the cache", async () => {
    await checkLatest(t0)
    latest.mockImplementation(() => new Promise(() => {}))
    const started = performance.now()
    expect(await checkLatest(t0 + 60_000, 60_000, Bun.sleep(20))).toBe("9.9.9")
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("a failure with nothing cached is silent", async () => {
    latest.mockImplementation(async () => {
      throw new Error("offline")
    })
    expect(await checkLatest(t0)).toBeUndefined()
  })
})

describe("notice (plain CLI stderr line)", () => {
  test("prints the exact line at most once a day, while still checking every time", async () => {
    const lines: string[] = []
    const write = (line: string) => void lines.push(line)
    await notice({ now: t0, current: "1.18.40", write })
    await notice({ now: t0 + 60_000, current: "1.18.40", write })
    expect(lines).toEqual(['There is a new version: 9.9.9 — please run "lunos update"\n'])
    expect(calls).toBe(2)
    await notice({ now: t0 + 25 * 3_600_000, current: "1.18.40", write })
    expect(lines).toHaveLength(2)
  })

  test("says nothing when already current", async () => {
    const lines: string[] = []
    await notice({ now: t0, current: "9.9.9", write: (line) => void lines.push(line) })
    expect(lines).toEqual([])
  })

  test("a dev build makes no request", async () => {
    await notice({ now: t0, current: "local", write: () => {} })
    expect(calls).toBe(0)
  })

  test("offline mode makes no request and prints nothing", async () => {
    process.env.LUNOS_OFFLINE = "1"
    const lines: string[] = []
    await notice({ now: t0, current: "1.18.40", write: (line) => void lines.push(line) })
    expect(calls).toBe(0)
    expect(lines).toEqual([])
  })
})

describe("copy", () => {
  test("the TUI notice, wide and narrow, never truncates the version", () => {
    expect(newVersionMessage("1.18.43")).toBe("There is a new version: 1.18.43 — please run lunos update")
    expect(newVersionNotice("1.18.43", 120)).toBe("↑ There is a new version: 1.18.43 — please run lunos update")
    expect(newVersionNotice("1.18.43", 100)).toBe("↑ There is a new version: 1.18.43 — please run lunos update")
    expect(newVersionNotice("1.18.43", 99)).toBe("↑ New version: 1.18.43 · lunos update")
    expect(newVersionNotice("10.123.4567", 80)).toContain("10.123.4567")
  })

  test("the update-complete hint points at /restart with the new version (XCOD-129)", () => {
    expect(updateRestartHint("1.18.44")).toBe("Run /restart to use 1.18.44.")
  })
})

describe("lunos update", () => {
  test("is the command name, with upgrade as an alias", () => {
    expect(UpgradeCommand.command).toBe("update [target]")
    expect(UpgradeCommand.aliases).toEqual(["upgrade"])
  })

  test("up to date", () => {
    expect(upToDateMessage("1.18.43")).toBe("Lunos is up to date (1.18.43).")
    expect(isUpToDate("1.18.43", "1.18.43", false)).toBe(true)
    expect(isUpToDate("1.18.44", "1.18.43", false)).toBe(true)
    expect(isUpToDate("1.18.42", "1.18.43", false)).toBe(false)
    // An explicit older target is a downgrade the user asked for, not "up to date".
    expect(isUpToDate("1.18.44", "1.18.43", true)).toBe(false)
    expect(isUpToDate("local", "1.18.43", false)).toBe(false)
  })

  test("the manual hint for npm allows the install script (XCOD-111)", () => {
    expect(manualUpdateCommand("npm", "1.18.43")).toBe("npm i -g lunos-ai@1.18.43 --allow-scripts=lunos-ai")
    expect(manualUpdateCommand("bun", "1.18.43")).toBe("bun install -g lunos-ai@1.18.43")
  })
})
