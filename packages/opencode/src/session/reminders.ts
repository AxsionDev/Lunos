import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Session } from "./session"
import PROMPT_PLAN from "./prompt/plan.txt"
import BUILD_SWITCH from "./prompt/build-switch.txt"
import PLAN_MODE from "./prompt/plan-mode.txt"
import RESEARCH_MODE from "./prompt/research-mode.txt"
import DEV_CYCLE_MODE from "./prompt/dev-cycle-mode.txt"
import { DevCycle } from "./dev-cycle"

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // Research mode is independent of the plan-mode flag: its reminder carries
  // the output path, so it always follows the path-bearing shape below.
  if (input.agent.name === "research") {
    const ctx = yield* InstanceState.context
    const file = Session.research(input.session, ctx)
    const exists = yield* fsys.existsSafe(file)
    if (!exists) yield* fsys.ensureDir(path.dirname(file)).pipe(Effect.catch(Effect.die))
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: RESEARCH_MODE.replace("${researchInfo}", () =>
        exists
          ? `A research file already exists at ${file}. You can read it and make incremental edits using the edit tool.`
          : `No research file exists yet. You should create it at ${file} using the write tool.`,
      ),
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  // Like research, dev-cycle is independent of the plan-mode flag: its
  // reminder carries both the output path and the phase cursor, so it always
  // follows the path-bearing shape above.
  if (input.agent.name === "dev-cycle") {
    const ctx = yield* InstanceState.context
    const file = Session.devcycle(input.session, ctx)
    const exists = yield* fsys.existsSafe(file)
    if (!exists) yield* fsys.ensureDir(path.dirname(file)).pipe(Effect.catch(Effect.die))
    // Read every turn, never cache: the human edits this frontmatter to
    // approve or rewind a gate, and that must take effect on the next turn.
    // `readFileStringSafe` carries an Error channel (fs-util.ts:35) that this
    // file has no precedent for handling — `orElseSucceed` is verified in use
    // across packages/*/src (26 call sites, e.g. packages/core/src/npm.ts).
    // A file we cannot read degrades to the default cursor; it never throws.
    const contents = exists
      ? yield* fsys.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      : undefined
    const parsed = DevCycle.parseCursorResult(contents)
    const cursor = parsed.cursor
    // A file that exists and has content but whose frontmatter will not parse
    // reads exactly like a cycle genuinely sitting at phase 1, and the model
    // responds by redoing discovery over work that is already in flight.
    // Hand-editing this frontmatter is the mode's only human control surface
    // and the parser is strict on purpose, so this is one typo away
    // (`phase: Architect`, `phase: architect  # waiting`). Say the position is
    // unknown rather than assert a position nobody wrote.
    const unreadable = exists && !!contents?.trim() && !parsed.ok
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: DEV_CYCLE_MODE.replace("${cycleInfo}", () =>
        [
          exists
            ? `A cycle file already exists at ${file}. Read it and make incremental edits using the edit tool.`
            : `No cycle file exists yet. Create it at ${file} using the write tool, opening with the frontmatter block described below.`,
          `Current phase: ${cursor.phase}. Gate at the end of this phase: ${cursor.gate}.`,
          ...(unreadable
            ? [
                "The cycle file exists but its frontmatter could not be parsed. Treat this position as unknown -- ask the human where the cycle stands before acting on it, and do not redo an earlier phase on the assumption that it was never done.",
              ]
            : []),
        ].join("\n"),
      ),
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (!flags.experimentalPlanMode) {
    if (input.agent.name === "plan") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: PROMPT_PLAN,
        synthetic: true,
      })
    }
    const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
    if (wasPlan && input.agent.name === "build") {
      userMessage.parts.push({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: BUILD_SWITCH,
        synthetic: true,
      })
    }
    return input.messages
  }

  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
    const ctx = yield* InstanceState.context
    const plan = Session.plan(input.session, ctx)
    const exists = yield* fsys.existsSafe(plan)
    const part = yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text: exists
        ? `${BUILD_SWITCH}\n\nA plan file exists at ${plan}. You should execute on the plan defined within it`
        : BUILD_SWITCH,
      synthetic: true,
    })
    userMessage.parts.push(part)
    return input.messages
  }

  if (input.agent.name !== "plan" || assistantMessage?.info.agent === "plan") return input.messages

  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  const part = yield* sessions.updatePart({
    id: PartID.ascending(),
    messageID: userMessage.info.id,
    sessionID: userMessage.info.sessionID,
    type: "text",
    text: PLAN_MODE.replace("${planInfo}", () =>
      exists
        ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
        : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
    ),
    synthetic: true,
  })
  userMessage.parts.push(part)
  return input.messages
})

export * as SessionReminders from "./reminders"
