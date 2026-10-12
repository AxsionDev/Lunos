// XCOD-218: start (or resume) a Claude Code / Codex session in its own Lunos session view.
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { EXTERNAL_LABEL, refusalMessage, type ExternalTool } from "../util/external"

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
    return true
  }
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
