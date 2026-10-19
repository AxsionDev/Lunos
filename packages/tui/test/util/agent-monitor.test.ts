import { describe, expect, test } from "bun:test"
import type { SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { askText, build, leftOpensMonitor, number, RECENT_MS, route, tags } from "../../src/util/agent-monitor"

const NOW = 1_800_000_000_000

function item(id: string, input: Partial<SessionOverviewItem> = {}): SessionOverviewItem {
  return {
    id,
    kind: "session",
    title: id,
    directory: "/work/a",
    cost: 0,
    created: NOW - 1000,
    updated: NOW - 1000,
    state: "idle",
    permissions: 0,
    questions: 0,
    ...input,
  }
}

const ids = (rail: ReturnType<typeof build>) => rail.rows.map((row) => `${row.section}:${row.depth}:${row.item.id}`)

describe("Agent Monitor rail (XCOD-262)", () => {
  test("sections in order (Waiting, Running, Completed, Failed), newest first, each with its count", () => {
    const rail = build({
      now: NOW,
      sessions: [
        item("done", { state: "finished", updated: NOW - 5000 }),
        item("broke", { state: "failed" }),
        item("busy-old", { state: "running", updated: NOW - 9000 }),
        item("ask", { state: "waiting", permissions: 1, directory: "/work/b" }),
        item("busy-new", { state: "running", updated: NOW - 10 }),
        item("idle", { state: "idle", updated: NOW - 100 }),
      ],
    })
    expect(ids(rail)).toEqual([
      "waiting:0:ask",
      "running:0:busy-new",
      "running:0:busy-old",
      "completed:0:idle",
      "completed:0:done",
      "failed:0:broke",
    ])
    expect(rail.counts).toEqual({ waiting: 1, running: 2, completed: 2, failed: 1 })
  })

  test("Completed is the last 24 h; older ones are behind Show older, and a search still finds them", () => {
    const sessions = [
      item("recent", { state: "finished" }),
      item("old", { state: "finished", updated: NOW - RECENT_MS - 1 }),
    ]
    expect(ids(build({ now: NOW, sessions }))).toEqual(["completed:0:recent"])
    expect(build({ now: NOW, sessions }).older).toBe(1)
    expect(ids(build({ now: NOW, sessions, showOlder: true }))).toEqual(["completed:0:recent", "completed:0:old"])
    expect(ids(build({ now: NOW, sessions, search: "old" }))).toEqual(["completed:0:old"])
    // Running and waiting sessions are listed however old.
    expect(
      ids(build({ now: NOW, sessions: [item("long", { state: "running", updated: NOW - 3 * RECENT_MS })] })),
    ).toEqual(["running:0:long"])
  })

  test("a background subagent sits under its parent, and a waiting one brings its parent to Waiting", () => {
    const rail = build({
      now: NOW,
      sessions: [
        item("parent", { state: "finished" }),
        item("child", { kind: "subagent", parentID: "parent", state: "waiting", questions: 1 }),
        item("orphan", { kind: "subagent", parentID: "gone", state: "running" }),
      ],
    })
    expect(ids(rail)).toEqual(["waiting:0:parent", "waiting:1:child", "running:0:orphan"])
    expect(rail.counts.waiting).toBe(1)
  })

  test("/ filters by title, project, agent or tool", () => {
    const sessions = [
      item("a", { title: "refactor-auth", agent: "build" }),
      item("b", { title: "docs", kind: "external", tool: "claude" }),
    ]
    expect(ids(build({ now: NOW, sessions, search: "AUTH" }))).toEqual(["completed:0:a"])
    expect(ids(build({ now: NOW, sessions, search: "claude" }))).toEqual(["completed:0:b"])
  })
})

describe("rail numbers and @ tags (XCOD-262)", () => {
  test("numbers follow rail order and stick to their session when rows move", () => {
    const first = number(new Map(), ["a", "b", "c"])
    expect([...first]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
    // c turns Waiting and moves to the top; a new session d appears; b is gone.
    const next = number(first, ["c", "d", "a"])
    expect(next.get("c")).toBe(3)
    expect(next.get("a")).toBe(1)
    // b's number isn't handed to d: an "@2" typed for b must not reach d.
    expect(next.get("d")).toBe(4)
  })

  test("numbers stop at 99", () => {
    const order = Array.from({ length: 120 }, (_, index) => `s${index}`)
    const numbers = number(new Map(), order)
    expect(numbers.size).toBe(99)
    expect(numbers.get("s98")).toBe(99)
    expect(numbers.has("s99")).toBe(false)
  })

  test("@2 do X targets session 2 and sends 'do X'", () => {
    const numbers = new Map([
      [2, "ses_two"],
      [3, "ses_three"],
    ])
    expect(tags("@2 do X", numbers)).toEqual({ targets: ["ses_two"], unknown: [], text: "do X" })
    expect(tags("please @2, @3 and @2 run the tests", numbers)).toEqual({
      targets: ["ses_two", "ses_three"],
      unknown: [],
      text: "please , and run the tests",
    })
    expect(tags("@7 hello", numbers)).toEqual({ targets: [], unknown: [7], text: "hello" })
    // Not tags: an address, a file name, a number with three digits, a file mention.
    for (const text of ["mail me@2 now", "see @2x.png", "@123 go", "@src/app.ts"])
      expect(tags(text, numbers).targets).toEqual([])
    expect(tags("no tags here", numbers)).toEqual({ targets: [], unknown: [], text: "no tags here" })
  })
})

describe("delivery and opening rules (XCOD-262)", () => {
  test("one session is never driven by two processes", () => {
    expect(route(item("ses_a"))).toEqual({ type: "local" })
    expect(route(item("ses_a", { elsewhere: true, state: "running" }))).toEqual({ type: "peer" })
    expect(route(item("ses_a", { stale: true }))).toEqual({ type: "takeover" })
    expect(route(item("external:abc", { kind: "external", tool: "claude" }))).toEqual({ type: "tool-only" })
  })

  const base = {
    enabled: true,
    route: "home" as const,
    child: false,
    text: "",
    parts: 0,
    mode: "normal",
    autocomplete: false,
  }

  test("← opens the monitor only from an empty prompt on home or a top-level session", () => {
    expect(leftOpensMonitor(base)).toBe(true)
    expect(leftOpensMonitor({ ...base, route: "session" })).toBe(true)
    // Text, or an attachment with no text: ← moves the cursor.
    expect(leftOpensMonitor({ ...base, text: "fix it" })).toBe(false)
    expect(leftOpensMonitor({ ...base, parts: 1 })).toBe(false)
    // A subagent session keeps "previous child"; the diff viewer and other screens keep their ←.
    expect(leftOpensMonitor({ ...base, route: "session", child: true })).toBe(false)
    expect(leftOpensMonitor({ ...base, route: "other" })).toBe(false)
    // Shell mode, an open autocomplete, or "left_opens_monitor": false.
    expect(leftOpensMonitor({ ...base, mode: "shell" })).toBe(false)
    expect(leftOpensMonitor({ ...base, autocomplete: true })).toBe(false)
    expect(leftOpensMonitor({ ...base, enabled: false })).toBe(false)
  })

  test("a Waiting row shows the ask", () => {
    expect(askText({ permissions: [{ permission: "bash", patterns: ["git push origin main"] }], questions: [] })).toBe(
      "approve: bash git push origin main",
    )
    expect(askText({ permissions: [], questions: [{ questions: [{ question: "Which branch?" }] }] })).toBe(
      "asks: Which branch?",
    )
    expect(askText({ permissions: [], questions: [] })).toBeUndefined()
  })
})
