import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import type { DialogContext } from "../ui/dialog"
import type { useSDK } from "../context/sdk"
import type { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

// XCOD-132: the memory browser's Export action. The same choices as `lunos memory export`, asked one
// at a time: what to write, which memory, from when, and a passphrase when encrypting.

type Format = {
  format: "bundle" | "markdown"
  zip?: boolean
  encrypt?: boolean
  includeIndex?: boolean
  graph?: boolean
}

const FORMATS: DialogSelectOption<Format>[] = [
  {
    title: "Bundle folder",
    description: "facts, graph, notes and provenance (lunos-memory/1)",
    value: { format: "bundle" },
  },
  { title: "Bundle .zip", description: "the same, as one file", value: { format: "bundle", zip: true } },
  {
    title: "Encrypted bundle",
    description: ".zip.enc, locked with a passphrase that is never stored",
    value: { format: "bundle", zip: true, encrypt: true },
  },
  {
    title: "Bundle .zip with the engine index",
    description: "adds the database files, for a same-version restore",
    value: { format: "bundle", zip: true, includeIndex: true },
  },
  {
    title: "Bundle folder without the graph",
    description: "facts and notes only; doesn't start memory",
    value: { format: "bundle", graph: false },
  },
  { title: "Markdown", description: "one file per fact, for review in git", value: { format: "markdown" } },
]

const SCOPES: DialogSelectOption<"both" | "project" | "user">[] = [
  { title: "Project and user memory", value: "both" },
  { title: "Project memory", value: "project" },
  { title: "User memory", value: "user" },
]

function choose<T>(dialog: DialogContext, title: string, options: DialogSelectOption<T>[]) {
  return new Promise<T | undefined>((resolve) => {
    dialog.replace(
      () => <DialogSelect title={title} options={options} onSelect={(option) => resolve(option.value)} />,
      () => resolve(undefined),
    )
  })
}

export async function exportMemory(input: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  toast: ReturnType<typeof useToast>
}) {
  const { dialog, sdk, toast } = input
  const chosen = await choose(dialog, "Export memory", FORMATS)
  if (!chosen) return
  const scope = await choose(dialog, "Which memory", SCOPES)
  if (!scope) return
  let since: string | undefined
  if (chosen.format === "bundle") {
    const value = await DialogPrompt.show(dialog, "Only facts saved since", {
      placeholder: "A date such as 2026-09-01, or empty for all",
    })
    if (value === null) return
    since = value.trim() || undefined
    if (since && Number.isNaN(new Date(since).getTime())) {
      dialog.clear()
      toast.show({ variant: "error", title: "Not exported", message: `"${since}" is not a date` })
      return
    }
  }
  let passphrase: string | undefined
  if (chosen.encrypt) {
    const value = await DialogPrompt.show(dialog, "Passphrase (at least 8 characters, never stored)", {
      placeholder: "Passphrase",
    })
    if (value === null) return
    if (value.length < 8) {
      dialog.clear()
      toast.show({ variant: "error", title: "Not exported", message: "The passphrase needs at least 8 characters" })
      return
    }
    passphrase = value
  }
  dialog.clear()
  toast.show({ variant: "info", message: "Exporting memory…" })
  const result = await sdk.client.memory
    .export({
      memoryExportInput: {
        format: chosen.format,
        scope,
        since,
        zip: chosen.zip,
        passphrase,
        graph: chosen.graph,
        includeIndex: chosen.includeIndex,
      },
    })
    .catch((error) => ({ error, data: undefined }))
  if (result.error || !result.data) {
    toast.show({ variant: "error", title: "Could not export memory", message: errorMessage(result.error) })
    return
  }
  const done = result.data
  toast.show({
    variant: "success",
    title: "Memory exported",
    message:
      done.format === "markdown"
        ? `${done.facts} fact(s) to ${done.path}`
        : `${done.facts} fact(s), ${done.notes} note file(s), ${done.entities} entities to ${done.path}${done.decrypt ? `. Decrypt with: ${done.decrypt}` : ""}`,
    duration: 10_000,
  })
}
