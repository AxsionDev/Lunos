// XCOD-254: /models in a Claude Code / Codex session lists the tool's models, not Lunos's.
import { createResource } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { EXTERNAL_BADGE, externalOf, refusalMessage } from "../util/external"
import { externalModelOptions } from "../util/external-commands"

/** The tool's models; choosing one saves it on the session, and the tool uses it from the next turn. */
export function DialogExternalModel(props: { sessionID: string }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const marker = () => externalOf(sync.session.get(props.sessionID))
  const name = () => EXTERNAL_BADGE[marker()?.tool ?? "claude"]
  const [listed] = createResource(() =>
    sdk.client.experimental.external
      .models({ sessionID: props.sessionID }, { throwOnError: true })
      .then((result) => result.data)
      .catch((error: unknown) => ({ error: refusalMessage(error, `${name()} didn't list its models`) })),
  )

  const choose = (model: string | undefined, title: string) => {
    dialog.clear()
    void sdk.client.experimental.external
      .model({ sessionID: props.sessionID, ...(model ? { model } : {}) }, { throwOnError: true })
      .then(() => toast.show({ variant: "success", message: `${name()} uses ${title} from the next message` }))
      .catch((error: unknown) =>
        toast.show({ variant: "error", message: refusalMessage(error, "The model wasn't saved") }),
      )
  }

  const options = (): DialogSelectOption<string>[] => {
    const data = listed()
    if (!data || !("models" in data)) return []
    return externalModelOptions(data.models, name()).map((item) => ({
      ...item,
      onSelect: () => choose(item.value || undefined, item.title),
    }))
  }

  const fallback = () => {
    const data = listed()
    return !!data && "fallback" in data && data.fallback
  }

  const error = () => {
    const data = listed()
    return data && "error" in data ? data.error : undefined
  }

  return (
    <DialogSelect<string>
      title={`${name()} models`}
      options={options()}
      current={marker()?.model ?? ""}
      flat={true}
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text fg={theme.textMuted}>
            {listed.loading ? `Asking ${name()} for its models…` : (error() ?? `${name()} didn't list its models`)}
          </text>
        </box>
      }
      footer={
        fallback() ? (
          <text fg={theme.textMuted}>{name()} didn't list its models; these are its aliases.</text>
        ) : undefined
      }
    />
  )
}
