import { describe, expect, test } from "bun:test"
import { parseRestartSlash, restartBanner, restartBusyMessage, restartDraft } from "../../src/util/restart"

describe("restartBanner (XCOD-129)", () => {
  test("names the running version", () => {
    expect(restartBanner({ from: "1.18.91", fresh: false, cancelled: [] }, "1.18.91")).toBe("Restarted — Lunos 1.18.91")
  })

  test("shows old → new after an update", () => {
    expect(restartBanner({ from: "1.18.90", fresh: false, cancelled: [] }, "1.18.91")).toBe(
      "Restarted — Lunos 1.18.90 → 1.18.91",
    )
  })

  test("says only the client restarted in attach mode, and lists what was cancelled", () => {
    expect(
      restartBanner(
        { from: "1.0.0", fresh: false, cancelled: ["the current turn", "job: index repo"], attach: "http://h:1" },
        "1.0.0",
      ),
    ).toBe(
      [
        "Restarted — Lunos 1.0.0",
        "Only this client restarted; the server at http://h:1 kept running.",
        "Cancelled: the current turn, job: index repo",
      ].join("\n"),
    )
  })
})

describe("parseRestartSlash (XCOD-129)", () => {
  test("recognises /restart and /restart --fresh only", () => {
    expect(parseRestartSlash("/restart")).toEqual({ fresh: false })
    expect(parseRestartSlash("  /restart --fresh ")).toEqual({ fresh: true })
    expect(parseRestartSlash("/restart now")).toBeUndefined()
    expect(parseRestartSlash("/restarts")).toBeUndefined()
    expect(parseRestartSlash("please /restart")).toBeUndefined()
  })
})

describe("restartDraft (XCOD-129)", () => {
  test("keeps an unsent prompt, as a copy", () => {
    const prompt = { input: "half a thought", parts: [] }
    const draft = restartDraft(prompt)
    expect(draft).toEqual(prompt)
    expect(draft).not.toBe(prompt)
  })

  test("drops empty prompts and the /restart command itself", () => {
    expect(restartDraft(undefined)).toBeUndefined()
    expect(restartDraft({ input: "  ", parts: [] })).toBeUndefined()
    expect(restartDraft({ input: "/restart --fresh", parts: [] })).toBeUndefined()
  })
})

describe("restartBusyMessage (XCOD-129)", () => {
  test("is undefined when nothing runs", () => {
    expect(restartBusyMessage({ busySessions: 0, runningJobs: [] })).toBeUndefined()
  })

  test("names the turn and the jobs", () => {
    expect(restartBusyMessage({ busySessions: 1, runningJobs: [] })).toBe(
      "The agent is mid-turn. Restarting now would cut it off.",
    )
    expect(restartBusyMessage({ busySessions: 1, runningJobs: ["a", "b"] })).toBe(
      "The agent is mid-turn, and 2 background jobs are running. Restarting now would cut them off.",
    )
  })
})
