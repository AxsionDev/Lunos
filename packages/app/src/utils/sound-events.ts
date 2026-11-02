// XCOD-311: which sound an alert plays, the same rules as the TUI's notifications
// (packages/tui/src/feature-plugins/system/notifications.ts). Undefined plays nothing.

type Channel = { enabled: boolean; sound: string }

export type SoundChoices = {
  agent: Channel
  subagent: Channel
  permissions: Channel
  question: Channel
  waiting: Channel
}

const play = (channel: Channel) => (channel.enabled ? channel.sound : undefined)

type Accessors = Record<
  "agentEnabled" | "subagentEnabled" | "permissionsEnabled" | "questionEnabled" | "waitingEnabled",
  () => boolean
> &
  Record<"agent" | "subagent" | "permissions" | "question" | "waiting", () => string>

/** The settings' current choices (`useSettings().sounds`). */
export function soundChoices(sounds: Accessors): SoundChoices {
  return {
    agent: { enabled: sounds.agentEnabled(), sound: sounds.agent() },
    subagent: { enabled: sounds.subagentEnabled(), sound: sounds.subagent() },
    permissions: { enabled: sounds.permissionsEnabled(), sound: sounds.permissions() },
    question: { enabled: sounds.questionEnabled(), sound: sounds.question() },
    waiting: { enabled: sounds.waitingEnabled(), sound: sounds.waiting() },
  }
}

/**
 * A subagent asking for approval or an answer is blocked until you act: "Waiting for action", when
 * that sound is on. Otherwise an approval keeps the approval sound it always had.
 */
export function askSound(type: "permission" | "question", subagent: boolean, sounds: SoundChoices) {
  if (subagent && sounds.waiting.enabled) return sounds.waiting.sound
  return play(type === "permission" ? sounds.permissions : sounds.question)
}

/** A main session finishing is "Lunos finished"; a subagent's is "Subagent finished". */
export function doneSound(subagent: boolean, sounds: SoundChoices) {
  return play(subagent ? sounds.subagent : sounds.agent)
}
