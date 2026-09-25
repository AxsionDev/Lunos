import { createResource } from "solid-js"
import { useRenderer } from "@opentui/solid"
import path from "node:path"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { useClipboard } from "../context/clipboard"
import { Locale } from "../util/locale"
import { openFileInEditor } from "../editor"

const LABEL = { plan: "Plan", research: "Research", "dev-cycle": "Dev cycle" } as const

/**
 * This project's plans, research notes and dev-cycle records (XCOD-84). Enter opens the file
 * itself in $EDITOR (edits are saved to it); without an editor, the path is copied instead.
 */
export function DialogArtifacts() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const clipboard = useClipboard()
  const renderer = useRenderer()

  const [items] = createResource(async () => (await sdk.client.experimental.artifact.list()).data ?? [])

  const options = () =>
    (items() ?? []).map((item) => ({
      title: item.title,
      value: item.path,
      category: LABEL[item.kind],
      description: path.basename(path.dirname(item.path)) + "/" + path.basename(item.path),
      footer: Locale.datetime(Number(item.created)),
    }))

  return (
    <DialogSelect
      title="Artifacts"
      placeholder={items()?.length === 0 ? "No plans, research notes or dev-cycle records yet" : "Search artifacts"}
      options={options()}
      onSelect={async (option) => {
        const file = String(option.value)
        dialog.clear()
        const opened = await openFileInEditor({ file, renderer }).catch(() => false)
        if (opened) return
        await clipboard.write?.(file).catch(() => {})
        toast.show({ message: `No $EDITOR set. Copied the path: ${file}`, variant: "info" })
      }}
    />
  )
}
