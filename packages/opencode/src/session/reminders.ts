import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
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
import DELEGATE from "./prompt/delegate.txt"
import DYNAMIC_WORKFLOW from "./prompt/dynamic-workflow.txt"
import { DevCycle } from "./dev-cycle"
import { DynamicWorkflows } from "./workflows"

/**
 * XCOD-287: Build splits development work across subagents by default. Only for a top-level Build
 * session that may launch a subagent; `subagent.delegate: false` turns it off.
 */
export function delegates(input: {
  agent: Agent.Info
  session: Pick<Session.Info, "parentID">
  config: { subagent?: { delegate?: boolean } }
  subagents: readonly Pick<Agent.Info, "name">[]
}) {
  if (input.agent.name !== "build" || input.session.parentID) return false
  if (input.config.subagent?.delegate === false) return false
  return input.subagents.some(
    (subagent) => Permission.evaluate("task", subagent.name, input.agent.permission).action !== "deny",
  )
}

export function delegateReminder(background: boolean) {
  return DELEGATE.replace("${backgroundInfo}", () =>
    background
      ? "Launch them with background: true and carry on with your own part; you are notified as each one finishes, so never sleep, poll or ask for status."
      : "Wait for their results before you build on them.",
  )
}

/**
 * XCOD-303: the orchestrator reminder for a Build turn running as a Dynamic workflow (it replaces
 * the delegation reminder). qa gets the project's pinned checks itself (`qaProof`, prompt.ts).
 */
export function dynamicReminder(input: { background: boolean; maxParallel: number }) {
  return DYNAMIC_WORKFLOW.replace("${maxParallel}", () => String(input.maxParallel))
    .replace("${maxRedispatch}", () => String(DynamicWorkflows.MAX_REDISPATCH))
    .replace("${backgroundInfo}", () =>
      input.background
        ? "Launch them with background: true; you are notified as each one finishes, so never sleep, poll or ask for status. When nothing is left to do until they report, end your turn saying you are waiting for them."
        : "Wait for their results before you build on them.",
    )
}

/** XCOD-303: Dev-Cycle's build phase, done by the main agent itself or (Dynamic workflows) by a builder subagent. */
export function devCycleSteps(dynamic: boolean) {
  if (!dynamic)
    return {
      buildStep:
        "Implement the approved plan yourself; you hold the plan context and the write permissions. Then dispatch the `qa` subagent to review and test what you wrote -- it must be a different agent from the one that wrote the code, because the point is fresh eyes.",
      fixStep: "fix it.",
    }
  return {
    buildStep:
      "Dynamic workflows are on, so you don't write the code: dispatch a builder subagent (`general`, or a project agent whose description fits better) to implement the approved plan. Paste the approved plan and the context it needs into its prompt; it can't see this conversation and may not be able to read the cycle file. Parts of the plan that touch different files may go to separate builders in parallel. Then dispatch the `qa` subagent to review and test what the builder wrote -- it must be a different agent from the one that wrote the code, because the point is fresh eyes. Your own edit tools work on the cycle file only, and you can't run commands.",
    fixStep: "dispatch a builder subagent to fix it (pass its task_id so the same one continues).",
  }
}

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
  /** XCOD-287: the delegation reminder, when `delegates()` says so. Built per request, never saved. */
  delegate?: string
  /** XCOD-303: whether this turn runs as a Dynamic workflow (Dev-Cycle's build phase goes to a subagent). */
  dynamic?: boolean
}) {
  const flags = yield* RuntimeFlags.Service
  const fsys = yield* FSUtil.Service
  const sessions = yield* Session.Service
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage) return input.messages

  // Research and dev-cycle run on every step of the agent loop, and the loop
  // reloads messages from storage each step. Their reminders are therefore
  // built per request and never saved: saving one per step stacked a new copy
  // onto the user message every tool call (27 copies, ~96 KB, in one turn).
  const inject = (text: string) =>
    userMessage.parts.push({
      id: PartID.ascending(),
      messageID: userMessage.info.id,
      sessionID: userMessage.info.sessionID,
      type: "text",
      text,
      synthetic: true,
    })

  if (input.delegate) inject(input.delegate)

  // Research mode is independent of the plan-mode flag: its reminder carries
  // the output path, so it always follows the path-bearing shape below.
  if (input.agent.name === "research") {
    const ctx = yield* InstanceState.context
    const file = Session.research(input.session, ctx)
    const exists = yield* fsys.existsSafe(file)
    if (!exists) yield* fsys.ensureDir(path.dirname(file)).pipe(Effect.catch(Effect.die))
    inject(
      RESEARCH_MODE.replace("${researchInfo}", () =>
        exists
          ? `A research file already exists at ${file}. You can read it and make incremental edits using the edit tool.`
          : `No research file exists yet. You should create it at ${file} using the write tool.`,
      ),
    )
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
    // Read every step, never cache: the human edits this frontmatter to
    // approve or rewind a gate, and that must take effect on the next step.
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
    const steps = devCycleSteps(input.dynamic === true)
    inject(
      DEV_CYCLE_MODE.replace("${buildStep}", () => steps.buildStep)
        .replace("${fixStep}", () => steps.fixStep)
        .replace("${cycleInfo}", () =>
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
    )
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
