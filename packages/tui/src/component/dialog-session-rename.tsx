import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useSync } from "../context/sync"
import { createMemo } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { RENAME_HINT, renameValue } from "../util/session"

interface DialogSessionRenameProps {
  session: string
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      // XCOD-308: the name sticks; empty goes back to the automatic name.
      description={() => <text fg={theme.textMuted}>{RENAME_HINT}</text>}
      onConfirm={(value) => {
        const title = renameValue(value, session()?.title)
        if (title !== undefined)
          void sdk.client.session
            .update({ sessionID: props.session, title }, { throwOnError: true })
            .catch((cause) => toast.show({ variant: "error", message: errorMessage(cause) }))
        dialog.clear()
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
