import type { Message, Part, Session } from "@opencode-ai/sdk/v2"

export type EmbedMessage = { info: Message; parts: Part[] }

export type EmbedSession = Partial<Session> & { id: string }

export function toData(session: EmbedSession, messages: EmbedMessage[]) {
  const sorted = [...messages].sort((a, b) => a.info.time.created - b.info.time.created)
  const full = { directory: "", title: "", version: "", time: { created: 0, updated: 0 }, ...session } as Session
  return {
    data: {
      session: [full],
      session_status: {},
      session_diff: {},
      message: { [full.id]: sorted.map((m) => m.info) } as Record<string, Message[]>,
      part: Object.fromEntries(sorted.map((m) => [m.info.id, m.parts])) as Record<string, Part[]>,
    },
    userMessageIDs: sorted.filter((m) => m.info.role === "user").map((m) => m.info.id),
  }
}
