import { describe, expect, test } from "bun:test"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionSummary } from "../../src/session/summary"
import type { MessageID } from "../../src/session/schema"

// XCOD-333: the prompt a message belongs to, and the messages of that prompt's turn.

const msg = (id: string, role: "user" | "assistant", parts: { synthetic?: boolean; type?: string }[] = []) =>
  ({
    info: { id, role },
    parts: parts.map((part) => ({ type: part.type ?? "text", text: "x", synthetic: part.synthetic })),
  }) as unknown as SessionV1.WithParts

const ids = (list: SessionV1.WithParts[]) => list.map((m) => m.info.id)

describe("SessionSummary.promptTurn", () => {
  // An IDE prompt: the user's text plus the synthetic text the file part was read into.
  const prompt = msg("u1", "user", [{}, { synthetic: true }, { type: "file" }])
  const messages = [
    prompt,
    msg("a1", "assistant"),
    // A background subagent's result, then an auto-continue: both synthetic, both the same turn.
    msg("u2", "user", [{ synthetic: true }]),
    msg("a2", "assistant"),
    msg("u3", "user", [{ synthetic: true }]),
    msg("a3", "assistant"),
    msg("u4", "user", [{}]),
    msg("a4", "assistant"),
  ]

  test("a synthetic user message belongs to the prompt before it, whose turn runs to the next prompt", () => {
    const turn = SessionSummary.promptTurn(messages, "u3" as MessageID)!
    expect(turn.owner.info.id).toBe("u1")
    expect(ids(turn.messages)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"])
  })

  test("a prompt owns its own turn", () => {
    const turn = SessionSummary.promptTurn(messages, "u4" as MessageID)!
    expect(turn.owner.info.id).toBe("u4")
    expect(ids(turn.messages)).toEqual(["u4", "a4"])
  })

  test("no prompt before the message, or an unknown message: no turn", () => {
    expect(SessionSummary.promptTurn(messages.slice(2), "u3" as MessageID)).toBeUndefined()
    expect(SessionSummary.promptTurn(messages, "nope" as MessageID)).toBeUndefined()
  })
})
