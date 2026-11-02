import { afterEach, describe, expect, test } from "bun:test"
import { StartupTrace } from "../src/startup-trace"

afterEach(() => StartupTrace.reset())

describe("StartupTrace", () => {
  test("records phases in start order, with the first frame at the end of what blocked it", async () => {
    await StartupTrace.span("config", () => Bun.sleep(5))
    const end = StartupTrace.begin("server", { blocking: false })
    StartupTrace.trace("decide", () => 1)
    StartupTrace.firstFrame()
    end()

    const phases = StartupTrace.phases()
    expect(phases.map((phase) => phase.name)).toEqual(["config", "server", "decide", "first frame"])
    expect(phases[0]!.duration).toBeGreaterThanOrEqual(4)
    expect(phases.find((phase) => phase.name === "server")!.blocking).toBe(false)
    expect(phases.find((phase) => phase.name === "decide")!.blocking).toBe(true)
    expect(StartupTrace.firstFrameAt()).toBe(phases.at(-1)!.start)
  })

  test("a phase that ended after the first frame never blocked it", () => {
    const end = StartupTrace.begin("late")
    StartupTrace.firstFrame()
    const until = performance.now() + 2
    while (performance.now() < until) {}
    end()
    expect(StartupTrace.phases().find((phase) => phase.name === "late")!.blocking).toBe(false)
  })

  test("waitFirstFrame settles once the first frame is drawn, and only the first counts", async () => {
    const waited = StartupTrace.waitFirstFrame()
    StartupTrace.firstFrame()
    StartupTrace.firstFrame("again")
    await waited
    expect(
      StartupTrace.phases().filter((phase) => phase.name.startsWith("first frame") || phase.name === "again"),
    ).toHaveLength(1)
  })

  test("the start path leaves out module loading", () => {
    const phases: StartupTrace.Phase[] = [
      { name: "load cli modules", start: 0, duration: 300, blocking: true, thread: "main" },
      { name: "import tui", start: 300, duration: 50, blocking: true, thread: "main" },
      { name: "tui config", start: 350, duration: 10, blocking: true, thread: "main" },
      { name: "[server] GET /provider", start: 350, duration: 900, blocking: false, thread: "worker" },
    ]
    expect(StartupTrace.startPathMs(phases, 400)).toBe(50)
    expect(StartupTrace.startPathMs(phases, undefined)).toBeUndefined()
  })

  test("format and serialize", () => {
    StartupTrace.record("load cli modules", 0, 12)
    StartupTrace.add([{ name: "load server modules", start: 3, duration: 40, blocking: false, thread: "worker" }])
    StartupTrace.firstFrame()
    const text = StartupTrace.format()
    expect(text).toContain("load cli modules")
    expect(text).toContain("[server] load server modules")
    expect(text).toMatch(/first frame at [\d.]+ ms/)
    const json = JSON.parse(StartupTrace.serialize("/tmp/trace.json"))
    expect(json.firstFrame).toBe(StartupTrace.firstFrameAt())
    expect(json.phases).toHaveLength(3)
    expect(StartupTrace.serialize("/tmp/trace.txt")).toBe(text + "\n")
  })

  test("LUNOS_STARTUP_TRACE: on, off, or a file", () => {
    const before = process.env[StartupTrace.ENV]
    try {
      process.env[StartupTrace.ENV] = "1"
      expect(StartupTrace.enabled()).toBe(true)
      expect(StartupTrace.target()).toBeUndefined()
      process.env[StartupTrace.ENV] = "/tmp/startup.json"
      expect(StartupTrace.enabled()).toBe(true)
      expect(StartupTrace.target()).toBe("/tmp/startup.json")
      process.env[StartupTrace.ENV] = "0"
      expect(StartupTrace.enabled()).toBe(false)
      delete process.env[StartupTrace.ENV]
      expect(StartupTrace.enabled()).toBe(false)
    } finally {
      if (before === undefined) delete process.env[StartupTrace.ENV]
      else process.env[StartupTrace.ENV] = before
    }
  })
})

test("a phase still running when the timeline is read shows as such, and didn't block the frame", () => {
  StartupTrace.begin("plugins", { blocking: false })
  const end = StartupTrace.begin("slow")
  StartupTrace.firstFrame()
  const slow = StartupTrace.phases().find((phase) => phase.name === "slow")!
  expect(slow.running).toBe(true)
  expect(slow.blocking).toBe(false)
  expect(StartupTrace.format()).toContain("slow (still running)")
  end()
  expect(StartupTrace.phases().find((phase) => phase.name === "slow")!.running).toBeUndefined()
})
