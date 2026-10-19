// XCOD-262: the Agent Monitor's prompts to an existing session. An idle session runs the prompt now;
// a busy one holds it until its turn ends, oldest first, one per turn; a prompt is never an approval.
// This process's "own API" is a stub that records the calls (the real routes are tested where defined).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { GlobalBus } from "../../src/bus/global"
import { SessionLive } from "../../src/session/live"
import { SessionPeerControl } from "../../src/session/peer-control"
import { SessionPromptQueue } from "../../src/session/prompt-queue"

let calls: { method: string; path: string; directory: string | null; body: any }[] = []
let questions: unknown[] = []

beforeEach(() => {
  calls = []
  questions = []
  SessionLive.start()
  SessionPeerControl.useHandler(async (request) => {
    const url = new URL(request.url)
    const text = request.method === "POST" ? await request.text() : ""
    calls.push({
      method: request.method,
      path: url.pathname,
      directory: url.searchParams.get("directory"),
      body: text ? JSON.parse(text) : undefined,
    })
    if (url.pathname === "/question") return Response.json(questions)
    return Response.json(true)
  })
})

afterEach(() => {
  SessionPromptQueue.reset()
  SessionLive.reset()
  SessionPeerControl.useHandler(undefined)
})

function status(sessionID: string, type: "busy" | "idle") {
  GlobalBus.emit("event", {
    directory: "/work/a",
    payload: { type: "session.status", properties: { sessionID, status: { type } } },
  })
}

const sent = () => calls.filter((call) => call.path.endsWith("/prompt_async")).map((call) => call.body.parts[0].text)
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("SessionPromptQueue.decide (XCOD-262)", () => {
  test("a prompt never answers a permission: it is held, or stops the turn, but never replies", () => {
    expect(SessionPromptQueue.decide({ busy: true, permissions: 1 })).toBe("queued")
    expect(SessionPromptQueue.decide({ busy: true, permissions: 2, interrupt: true })).toBe("interrupted")
    // Even with a question open next to it, the permission wins: the text isn't sent as any reply.
    expect(SessionPromptQueue.decide({ busy: true, permissions: 1, question: { questions: 1, custom: true } })).toBe(
      "queued",
    )
  })

  test("one open question that takes a typed answer gets the prompt as its answer", () => {
    expect(SessionPromptQueue.decide({ busy: true, permissions: 0, question: { questions: 1, custom: true } })).toBe(
      "answered",
    )
    // Options only, or several questions at once: the text can't stand for the answer, so it waits.
    expect(SessionPromptQueue.decide({ busy: true, permissions: 0, question: { questions: 1, custom: false } })).toBe(
      "queued",
    )
    expect(SessionPromptQueue.decide({ busy: true, permissions: 0, question: { questions: 2, custom: true } })).toBe(
      "queued",
    )
  })

  test("idle runs now; busy waits, or with interrupt stops the turn", () => {
    expect(SessionPromptQueue.decide({ busy: false, permissions: 0 })).toBe("now")
    expect(SessionPromptQueue.decide({ busy: true, permissions: 0 })).toBe("queued")
    expect(SessionPromptQueue.decide({ busy: true, permissions: 0, interrupt: true })).toBe("interrupted")
  })
})

describe("SessionPromptQueue.submit (XCOD-262)", () => {
  test("an idle session gets the prompt now, with its own agent, through its own API", async () => {
    expect(
      await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "hello", agent: "build" }),
    ).toEqual({ delivery: "now" })
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/session/ses_a/prompt_async",
        directory: "/work/a",
        body: { agent: "build", parts: [{ type: "text", text: "hello" }] },
      },
    ])
  })

  test("queue ordering: held while busy, first in first out, one prompt per finished turn", async () => {
    status("ses_a", "busy")
    expect(await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "one" })).toEqual({
      delivery: "queued",
      position: 1,
    })
    expect(await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "two" })).toEqual({
      delivery: "queued",
      position: 2,
    })
    expect(sent()).toEqual([])
    // The row shows how many are held, and other Lunos processes see it too.
    expect(SessionLive.get("ses_a").queued).toBe(2)

    status("ses_a", "idle")
    await settle()
    expect(sent()).toEqual(["one"])
    expect(SessionLive.get("ses_a").queued).toBe(1)

    // "one" is running now; "two" waits for that turn to end.
    status("ses_a", "busy")
    await settle()
    expect(sent()).toEqual(["one"])
    status("ses_a", "idle")
    await settle()
    expect(sent()).toEqual(["one", "two"])
    expect(SessionLive.get("ses_a").queued).toBeUndefined()
    expect(SessionPromptQueue.list("ses_a")).toEqual([])
  })

  test("queues are per session: another session's turn ending sends nothing", async () => {
    status("ses_a", "busy")
    status("ses_b", "busy")
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "for a" })
    status("ses_b", "idle")
    await settle()
    expect(sent()).toEqual([])
  })

  test("Ctrl+Enter: the prompt jumps the queue and stopping the turn sends it", async () => {
    status("ses_a", "busy")
    await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "later" })
    expect(
      await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "now", interrupt: true }),
    ).toEqual({ delivery: "interrupted", position: 1 })
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/session/ses_a/abort", directory: "/work/a" })
    // The abort ends the turn.
    status("ses_a", "idle")
    await settle()
    expect(sent()).toEqual(["now"])
  })

  test("waiting on a permission: the prompt is held, and no permission route is ever called", async () => {
    status("ses_a", "busy")
    GlobalBus.emit("event", {
      directory: "/work/a",
      payload: { type: "permission.asked", properties: { id: "per_1", sessionID: "ses_a" } },
    })
    expect(await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "yes do it" })).toEqual({
      delivery: "queued",
      position: 1,
    })
    expect(calls.some((call) => call.path.startsWith("/permission"))).toBe(false)
  })

  test("waiting on a question: the prompt is its answer", async () => {
    status("ses_a", "busy")
    GlobalBus.emit("event", {
      directory: "/work/a",
      payload: { type: "question.asked", properties: { id: "que_1", sessionID: "ses_a" } },
    })
    questions = [
      { id: "que_other", sessionID: "ses_b", questions: [{}] },
      { id: "que_1", sessionID: "ses_a", questions: [{ question: "Which branch?" }] },
    ]
    expect(await SessionPromptQueue.submit({ sessionID: "ses_a", directory: "/work/a", text: "main" })).toEqual({
      delivery: "answered",
    })
    expect(calls.at(-1)).toEqual({
      method: "POST",
      path: "/question/que_1/reply",
      directory: "/work/a",
      body: { answers: [["main"]] },
    })
  })
})
