import { createMemo } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"

export function DialogMode() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.mode.list().map((item) => {
      return {
        value: item.name,
        title: item.name,
        description: item.native ? "native" : item.description,
      }
    }),
  )

  return (
    <DialogSelect
      title="Select mode"
      current={local.mode.current()?.name}
      options={options()}
      onSelect={(option) => {
        local.mode.set(option.value)
        dialog.clear()
      }}
    />
  )
}
