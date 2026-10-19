import { describe, expect, test } from "bun:test"
import type { SessionOverviewItem } from "@opencode-ai/sdk/v2/client"
import {
  ask,
  insertMention,
  mentionAt,
  mentionOptions,
  number,
  rail,
  RECENT_MS,
  route,
  tags,
  untag,
} from "./monitor-model"

const NOW = 1_800_000_000_000

function item(id: string, input: Partial<SessionOverviewItem> = {}): SessionOverviewItem {
  return {
    id,
    kind: "session",
    title: id,
    directory: "/work/a",
    project: { id: "prj_a", name: "alpha", worktree: "/work/a" },
    cost: 0,
    created: NOW - 1000,
    updated: NOW - 1000,
    state: "idle",
    permissions: 0,
    questions: 0,
    ...input,
  } as SessionOverviewItem
}

const ids = (value: ReturnType<typeof rail>) => value.rows.map((row) => `${row.section}:${row.depth}:${row.item.id}`)

describe("Sessions window monitor rail (XCOD-262)", () => {
  test("sections in order (Waiting, Running, Completed, Failed), newest first, each with its count", () => {
    const value = rail({
      now: NOW,
      sessions: [
        item("done", { state: "finished", updated: NOW - 5000 }),
        item("broke", { state: "failed" }),
        item("busy-old", { state: "running", updated: NOW - 9000 }),
        item("ask", { state: "waiting", permissions: 1 }),
        item("busy-new", { state: "running", updated: NOW - 10 }),
        item("idle", { state: "idle", updated: NOW - 100 }),
      ],
    })
    expect(ids(value)).toEqual([
      "waiting:0:ask",
      "running:0:busy-new",
      "running:0:busy-old",
      "completed:0:idle",
      "completed:0:done",
      "failed:0:broke",
    ])
    expect(value.counts).toEqual({ waiting: 1, running: 2, completed: 2, failed: 1 })
  })

  test("Completed is the last 24 h; older ones are behind Show older, and a search still finds them", () => {
    const sessions = [
      item("recent", { state: "finished" }),
      item("old", { state: "finished", updated: NOW - RECENT_MS - 1 }),
    ]
    expect(ids(rail({ now: NOW, sessions }))).toEqual(["completed:0:recent"])
    expect(rail({ now: NOW, sessions }).older).toBe(1)
    expect(ids(rail({ now: NOW, sessions, showOlder: true }))).toEqual(["completed:0:recent", "completed:0:old"])
    expect(ids(rail({ now: NOW, sessions, search: "old" }))).toEqual(["completed:0:old"])
    expect(
      ids(rail({ now: NOW, sessions: [item("long", { state: "running", updated: NOW - 3 * RECENT_MS })] })),
    ).toEqual(["running:0:long"])
  })

  test("a subagent sits under its parent, and a waiting one brings its parent to Waiting", () => {
    const value = rail({
      now: NOW,
      sessions: [
        item("parent", { state: "finished" }),
        item("child", { kind: "subagent", parentID: "parent", state: "waiting", questions: 1 }),
        item("orphan", { kind: "subagent", parentID: "gone", state: "running" }),
      ],
    })
    expect(ids(value)).toEqual(["waiting:0:parent", "waiting:1:child", "running:0:orphan"])
    expect(value.counts.waiting).toBe(1)
  })

  test("archived sessions aren't in the rail; the search reaches title, project and tool", () => {
    const sessions = [
      item("kept", { title: "refactor-auth", state: "finished" }),
      item("gone", { state: "finished", archived: NOW }),
      item("external:cc", { kind: "external", tool: "claude", title: "docs" }),
    ]
    expect(ids(rail({ now: NOW, sessions }))).toEqual(["completed:0:kept", "completed:0:external:cc"])
    expect(ids(rail({ now: NOW, sessions, search: "AUTH" }))).toEqual(["completed:0:kept"])
    expect(ids(rail({ now: NOW, sessions, search: "claude code" }))).toEqual(["completed:0:external:cc"])
  })
})

describe("rail numbers, @ tags and chips (XCOD-262)", () => {
  test("numbers follow rail order, stick to their session when rows move, and stop at 99", () => {
    const first = number(new Map(), ["a", "b", "c"])
    expect([...first]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ])
    const next = number(first, ["c", "d", "a"])
    expect(next.get("c")).toBe(3)
    expect(next.get("d")).toBe(4)
    const many = number(
      new Map(),
      Array.from({ length: 120 }, (_, index) => `s${index}`),
    )
    expect(many.size).toBe(99)
    expect(many.has("s99")).toBe(false)
  })

  test("@2 do X targets session 2; unknown numbers are reported; addresses and files aren't tags", () => {
    const numbers = new Map([
      [2, "ses_two"],
      [3, "ses_three"],
    ])
    expect(tags("@2 do X", numbers)).toEqual({ targets: ["ses_two"], unknown: [], text: "do X" })
    expect(tags("@2 @3 @2 run the tests", numbers)).toEqual({
      targets: ["ses_two", "ses_three"],
      unknown: [],
      text: "run the tests",
    })
    expect(tags("@7 hello", numbers)).toEqual({ targets: [], unknown: [7], text: "hello" })
    for (const text of ["mail me@2 now", "see @2x.png", "@123 go", "@src/app.ts"])
      expect(tags(text, numbers).targets).toEqual([])
  })

  test("removing a chip takes that session's tags out of the text, and only those", () => {
    expect(untag("@2 @3 run it", 2)).toBe("@3 run it")
    expect(untag("run it @3, then @2", 3)).toBe("run it , then @2")
    expect(untag("@23 go", 2)).toBe("@23 go")
  })
})

describe("the sessions autocomplete (XCOD-262)", () => {
  const rows = rail({
    now: NOW,
    sessions: [
      item("ses_a", { title: "Refactor parser", state: "running", updated: NOW - 1 }),
      item("ses_b", { title: "Deploy script", state: "waiting", permissions: 1 }),
      item("external:cc", { kind: "external", tool: "claude", title: "Claude Code api", state: "running" }),
      item("ses_c", { title: "Write docs", project: { id: "prj_b", name: "beta", worktree: "/work/b" } }),
    ],
  }).rows
  const numbers = number(
    new Map(),
    rows.map((row) => row.item.id),
  )

  test("@ at a word start opens it; an address or a finished word doesn't", () => {
    expect(mentionAt("hello @dep", 10)).toEqual({ start: 6, query: "dep" })
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" })
    expect(mentionAt("mail me@x", 9)).toBeUndefined()
    expect(mentionAt("@dep done", 9)).toBeUndefined()
  })

  test("by number, then title or project; Claude Code rows with no Lunos session aren't offered", () => {
    expect(mentionOptions(rows, numbers, "dep").map((option) => option.item.id)).toEqual(["ses_b"])
    expect(mentionOptions(rows, numbers, "beta").map((option) => option.item.id)).toEqual(["ses_c"])
    expect(mentionOptions(rows, numbers, "1").map((option) => option.number)).toEqual([1])
    expect(mentionOptions(rows, numbers, "").map((option) => option.item.id)).toEqual(["ses_b", "ses_a", "ses_c"])
  })

  test("the pick replaces what was typed with its number", () => {
    expect(insertMention("ask @dep now", { start: 4, query: "dep" }, 1)).toEqual({ text: "ask @1 now", caret: 6 })
    expect(insertMention("@ref", { start: 0, query: "ref" }, 2)).toEqual({ text: "@2 ", caret: 3 })
  })
})

describe("delivery (XCOD-262)", () => {
  test("one session is never driven by two processes", () => {
    expect(route(item("ses_a"))).toEqual({ type: "local" })
    expect(route(item("ses_a", { elsewhere: true, state: "running" }))).toEqual({ type: "peer" })
    expect(route(item("ses_a", { stale: true }))).toEqual({ type: "takeover" })
    expect(route(item("external:abc", { kind: "external", tool: "claude" }))).toEqual({ type: "tool-only" })
  })

  test("a Waiting row shows its first approval, else its first question", () => {
    expect(
      ask({ permissions: [{ id: "per_1", permission: "bash", patterns: ["git push origin main"] }], questions: [] }),
    ).toEqual({ type: "permission", id: "per_1", text: "bash git push origin main" })
    expect(ask({ permissions: [], questions: [{ id: "que_1", questions: [{ question: "Which branch?" }] }] })).toEqual({
      type: "question",
      id: "que_1",
      text: "Which branch?",
    })
    expect(ask({ permissions: [], questions: [] })).toBeUndefined()
    expect(ask(undefined)).toBeUndefined()
  })
})
