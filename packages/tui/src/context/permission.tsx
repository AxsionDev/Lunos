import { useArgs } from "./args"
import { useKV } from "./kv"
import { createSimpleContext } from "./helper"

/** `normal` is Manual approval: every action an `ask` rule covers asks first. */
export type PermissionMode = "auto" | "normal"
type Model = { providerID: string; modelID: string }
/** XCOD-310: what one workflow (primary agent) uses in one session. */
export type WorkflowChoice = { approval?: PermissionMode; model?: Model }
type SessionState = { workflow?: string; agents?: Record<string, WorkflowChoice> }

/** kv.json key: per session, the workflow its last prompt ran and each workflow's model and approval. */
export const WORKFLOW_STATE_KEY = "workflow_state"
/** The state of the prompt on home, before a session exists; the new session takes it over. */
export const DRAFT_SESSION = ""

/**
 * XCOD-310: model and approval mode per session and workflow, kept in kv.json so a session's
 * choices survive a restart. What applies when nothing is stored (the workflow's
 * `agent.<name>.permission_mode`, an organisation lock, `--auto`) is resolved by the reader
 * (util/approval), which has the config.
 */
export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const kv = useKV()
    const all = (): Record<string, SessionState> => kv.get(WORKFLOW_STATE_KEY, {})
    function update(sessionID: string, fn: (state: SessionState) => SessionState) {
      kv.set(WORKFLOW_STATE_KEY, { ...all(), [sessionID]: fn(JSON.parse(JSON.stringify(all()[sessionID] ?? {}))) })
    }
    function choose(sessionID: string, agent: string, value: WorkflowChoice) {
      update(sessionID, (state) => ({
        ...state,
        agents: { ...state.agents, [agent]: { ...state.agents?.[agent], ...value } },
      }))
    }
    return {
      /** `--auto`: every workflow starts in Auto unless its config or a lock says otherwise. */
      get auto() {
        return !!args.auto
      },
      workflow(sessionID: string) {
        return all()[sessionID]?.workflow
      },
      setWorkflow(sessionID: string, agent: string) {
        if (all()[sessionID]?.workflow === agent) return
        update(sessionID, (state) => ({ ...state, workflow: agent }))
      },
      choice(sessionID: string, agent: string): WorkflowChoice | undefined {
        return all()[sessionID]?.agents?.[agent]
      },
      setApproval(sessionID: string, agent: string, approval: PermissionMode) {
        choose(sessionID, agent, { approval })
      },
      setModel(sessionID: string, agent: string, model: Model) {
        choose(sessionID, agent, { model: { providerID: model.providerID, modelID: model.modelID } })
      },
      /** A session created from home takes over what was chosen there; home starts afresh. */
      adopt(sessionID: string) {
        const draft = all()[DRAFT_SESSION]
        if (!draft || all()[sessionID]) return
        const { [DRAFT_SESSION]: _, ...rest } = all()
        kv.set(WORKFLOW_STATE_KEY, { ...rest, [sessionID]: draft })
      },
    }
  },
})
