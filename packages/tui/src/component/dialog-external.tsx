// XCOD-218: start (or resume) a Claude Code / Codex session in its own Lunos session view.
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { createResource } from "solid-js"
import { useProject } from "../context/project"
import { EXTERNAL_LABEL, refusalMessage, toolUnavailable, type ExternalTool } from "../util/external"

/** Creates the external session (the server applies the policy and residency gate) and opens it. */
export function useStartExternal() {
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()
  const dialog = useDialog()
  return async (tool: ExternalTool, session?: string) => {
    const res = await sdk.client.session
      .create({ metadata: { external: { tool, ...(session ? { session } : {}) } } })
      .catch((error: unknown) => ({ data: undefined, error }))
    if (!res.data) {
      toast.show({
        variant: "error",
        title: `${EXTERNAL_LABEL[tool]} can't start`,
        message: refusalMessage(res.error, `Starting ${EXTERNAL_LABEL[tool]} failed`),
        duration: 10000,
      })
      return false
    }
    dialog.clear()
    route.navigate({ type: "session", sessionID: res.data.id })
    return res.data.id
  }
}

/**
 * XCOD-250: `/claude [task]` and `/codex [task]`. Not installed or not signed in: says how to fix it
 * and starts nothing. Refused by policy: tries anyway, so the server refuses with the reason and
 * audits it (`external.denied`). Otherwise a task starts a new session with it, and no task opens the
 * picker (new session, or continue a recent one of that tool in this project).
 */
export function useExternalCommand() {
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()
  const start = useStartExternal()
  return async (tool: ExternalTool, text: string) => {
    const tools = await sdk.client.experimental.external.tools().catch(() => undefined)
    const state = tools?.data?.find((item) => item.tool === tool)
    const unavailable = toolUnavailable(tool, state)
    if (unavailable && !state?.refused) {
      toast.show({
        variant: "warning",
        title: `${EXTERNAL_LABEL[tool]} can't start`,
        message: [unavailable, state?.hint].filter(Boolean).join("\n"),
        duration: 10000,
      })
      return
    }
    if (!text && !state?.refused) return void dialog.replace(() => <DialogExternalPick tool={tool} />)
    const sessionID = await start(tool)
    if (!sessionID || !text) return
    // No agent: the current mode (plan, say) mustn't refuse every approval the tool asks for.
    await sdk.client.session
      .prompt({ sessionID, parts: [{ type: "text", text }] }, { throwOnError: true })
      .catch((error: unknown) =>
        toast.show({
          variant: "error",
          title: "Failed to send the task",
          message: refusalMessage(error, String(error)),
        }),
      )
  }
}

/** New session, or one of this tool's recent sessions in this project, newest first. */
export function DialogExternalPick(props: { tool: ExternalTool }) {
  const sdk = useSDK()
  const project = useProject()
  const route = useRoute()
  const dialog = useDialog()
  const start = useStartExternal()
  const [recent] = createResource(async () => {
    const overview = await sdk.client.experimental.session.overview().catch(() => undefined)
    const directory = project.instance.directory()
    return (overview?.data?.sessions ?? [])
      .filter((item) => item.kind === "external" && item.tool === props.tool && item.directory === directory)
      .toSorted((a, b) => b.updated - a.updated)
      .slice(0, 10)
  })
  const options = () => [
    { value: "", title: "New session", description: `start ${EXTERNAL_LABEL[props.tool]} here` },
    ...(recent() ?? []).map((item) => ({
      value: item.id,
      title: item.title,
      category: "Continue",
      description: new Date(item.updated).toLocaleString(),
    })),
  ]
  // A Lunos session view of the tool opens as it is, context and all; a session Lunos only has in
  // its registry (started by `lunos external run`) is resumed in a new view by the tool's own id.
  const pick = (id: string) => {
    if (!id) return void start(props.tool)
    if (id.startsWith("external:")) return void start(props.tool, id.slice("external:".length))
    dialog.clear()
    route.navigate({ type: "session", sessionID: id })
  }
  return (
    <DialogSelect title={EXTERNAL_LABEL[props.tool]} options={options()} onSelect={(option) => pick(option.value)} />
  )
}

export function DialogExternal() {
  const dialog = useDialog()
  const start = useStartExternal()
  const options = [
    { value: "claude", title: "Claude Code", description: "new session with your own Claude Code" },
    { value: "codex", title: "Codex CLI", description: "new session with your own Codex CLI" },
    { value: "resume:claude", title: "Resume a Claude Code session…", description: "by its session id" },
    { value: "resume:codex", title: "Resume a Codex session…", description: "by its thread id" },
  ]
  return (
    <DialogSelect
      title="External session"
      options={options}
      onSelect={async (option) => {
        const [first, second] = option.value.split(":")
        if (first !== "resume") return void start(first as ExternalTool)
        const tool = second as ExternalTool
        const id = await DialogPrompt.show(dialog, `Resume ${EXTERNAL_LABEL[tool]} session`, {
          placeholder: "session id",
        })
        if (id?.trim()) await start(tool, id.trim())
      }}
    />
  )
}
