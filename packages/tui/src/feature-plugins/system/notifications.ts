import type { Event } from "@opencode-ai/sdk/v2"
import type { TuiAttentionSoundName, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { BUDGET_TOAST_TITLE } from "../../util/budget-toast"

const id = "internal:notifications"

type SessionError = Extract<Event, { type: "session.error" }>["properties"]["error"]

/**
 * XCOD-311: a subagent's approval or question is "waiting" (it's blocked until you act), one sound
 * per ask; the main session's keep their own. When and whether to notify comes from
 * `attention.notify_when` / `notify_subagents` (a subagent finishing only), read on every alert so
 * /settings applies at once.
 */
function notify(
  api: TuiPluginApi,
  sessionID: string | undefined,
  message: string,
  sound: TuiAttentionSoundName,
  options: { subagentSound?: TuiAttentionSoundName; title?: string; finished?: boolean } = {},
) {
  const session = sessionID ? api.state.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  const attention = api.tuiConfig.attention
  void api.attention.notify({
    title: options.title ?? session?.title,
    message,
    notification:
      isSubagent && !(options.finished && attention?.notify_subagents)
        ? false
        : { when: attention?.notify_when ?? "blurred" },
    sound: { name: isSubagent ? (options.subagentSound ?? sound) : sound, when: "always" },
  })
}

function sessionErrorMessage(error: SessionError) {
  if (error?.name === "MessageAbortedError") return "Session aborted"
  const data = error?.data
  if (data && typeof data === "object" && "message" in data && data.message === "SSE read timed out") {
    return "Model stopped responding"
  }
  return "Session error"
}

const tui: TuiPlugin = async (api) => {
  const active = new Set<string>()
  const errored = new Set<string>()
  const questions = new Set<string>()
  const permissions = new Set<string>()

  api.event.on("question.asked", (event) => {
    if (questions.has(event.properties.id)) return
    questions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Question needs input", "question", { subagentSound: "waiting" })
  })

  api.event.on("question.replied", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("question.rejected", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("permission.asked", (event) => {
    if (permissions.has(event.properties.id)) return
    permissions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Permission needs input", "permission", { subagentSound: "waiting" })
  })

  api.event.on("permission.replied", (event) => {
    permissions.delete(event.properties.requestID)
  })

  api.event.on("session.status", (event) => {
    const sessionID = event.properties.sessionID
    if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
      active.add(sessionID)
      errored.delete(sessionID)
      return
    }

    if (event.properties.status.type !== "idle") return
    if (!active.has(sessionID)) return
    active.delete(sessionID)

    if (errored.has(sessionID)) {
      errored.delete(sessionID)
      return
    }

    const session = api.state.session.get(sessionID)
    notify(api, sessionID, "Session done", session?.parentID ? "subagent_done" : "done", { finished: true })
  })

  // XCOD-311: a budget threshold reached, or the warning that a turn goes over. The server says so
  // with a toast (SessionPrompt.budgetCheck); a refusal ("stop") is an error toast, not a warning.
  api.event.on("tui.toast.show", (event) => {
    if (event.properties.title !== BUDGET_TOAST_TITLE || event.properties.variant !== "warning") return
    notify(api, undefined, event.properties.message, "budget_warning", { title: BUDGET_TOAST_TITLE })
  })

  api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    if (!sessionID) return
    if (!active.has(sessionID)) return
    errored.add(sessionID)
    notify(api, sessionID, sessionErrorMessage(event.properties.error), "error")
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
