import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import type { MemoryImportPreview, MemoryImportRow } from "@opencode-ai/sdk/v2"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import type { DialogContext } from "../ui/dialog"
import { useDialog } from "../ui/dialog"
import type { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { isRecord } from "../util/record"

// XCOD-133: the memory browser's Import action. Imported memory is untrusted, so it is previewed
// first: every row is new, a conflict, a duplicate or rejected, with the reason. New rows start
// approved; Enter approves or rejects one row, the "all" action every row that can be written, and
// nothing is written until "import". The server reads, verifies and screens the input again when
// importing and writes only the rows named here: never text this dialog sends.

type Input = { path: string; scope?: "project" | "user"; asFacts?: boolean; passphrase?: string }

const MODES: DialogSelectOption<Omit<Input, "path">>[] = [
  {
    title: "As they are",
    description: "bundle facts keep their scope; AGENTS.md, CLAUDE.md and Claude Code memory become notes",
    value: {},
  },
  {
    title: "As facts, into project memory",
    description: "other agents' files become facts, not notes",
    value: { asFacts: true, scope: "project" },
  },
  {
    title: "As facts, into user memory",
    description: "everything goes to user memory",
    value: { asFacts: true, scope: "user" },
  },
]

const ORDER = ["new", "conflict", "duplicate", "rejected"] as const
const CATEGORY: Record<MemoryImportRow["status"], string> = {
  new: "New",
  conflict: "Conflicts: the same subject, a different value",
  duplicate: "Duplicates",
  rejected: "Rejected by the write guard",
}

function selectable(row: MemoryImportRow) {
  return row.status === "new" || row.status === "conflict" || (row.status === "duplicate" && !!row.near)
}

function tag(error: unknown): string | undefined {
  if (isRecord(error) && typeof error._tag === "string") return error._tag
  if (error instanceof Error && isRecord(error.cause) && isRecord(error.cause.body)) return tag(error.cause.body)
}

function choose<T>(dialog: DialogContext, title: string, options: DialogSelectOption<T>[]) {
  return new Promise<T | undefined>((resolve) => {
    dialog.replace(
      () => <DialogSelect title={title} options={options} onSelect={(option) => resolve(option.value)} />,
      () => resolve(undefined),
    )
  })
}

export async function importMemory(input: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  toast: ReturnType<typeof useToast>
  onDone?: () => void
}) {
  const { dialog, sdk, toast } = input
  const value = await DialogPrompt.show(dialog, "Import memory from", {
    placeholder: "A bundle (folder, .zip or .zip.enc), a Markdown file or folder, AGENTS.md or CLAUDE.md",
  })
  if (value === null || !value.trim()) return
  const mode = await choose(dialog, "Import how", MODES)
  if (!mode) return
  const request: Input = { path: value.trim(), ...mode }
  const load = () =>
    sdk.client.memory.importPreview({ memoryImportInput: request }).catch((error) => ({ error, data: undefined }))
  dialog.clear()
  toast.show({ variant: "info", message: "Reading and screening the import…" })
  let result = await load()
  if (result.error && tag(result.error) === "MemoryPassphraseRequiredError") {
    const passphrase = await DialogPrompt.show(dialog, "Passphrase for the encrypted bundle (never stored)", {
      placeholder: "Passphrase",
    })
    if (passphrase === null || !passphrase) return
    request.passphrase = passphrase
    dialog.clear()
    result = await load()
  }
  if (result.error || !result.data) {
    dialog.clear()
    toast.show({
      variant: "error",
      title: "Nothing was imported",
      message: errorMessage(result.error),
      duration: 10_000,
    })
    return
  }
  const preview = result.data
  dialog.replace(() => (
    <DialogMemoryImportPreview preview={preview} request={request} sdk={sdk} onDone={input.onDone} />
  ))
}

function DialogMemoryImportPreview(props: {
  preview: MemoryImportPreview
  request: Input
  sdk: ReturnType<typeof useSDK>
  onDone?: () => void
}) {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  dialog.setSize("large")
  const rows = createMemo(() => ORDER.flatMap((status) => props.preview.rows.filter((row) => row.status === status)))
  const [approved, setApproved] = createSignal(
    new Set(props.preview.rows.filter((row) => row.status === "new").map((row) => row.key)),
  )
  const [busy, setBusy] = createSignal(false)

  const toggle = (key: string) =>
    setApproved((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const options = createMemo<DialogSelectOption<string>[]>(() =>
    rows().map((row) => {
      const mark = selectable(row) ? (approved().has(row.key) ? "[x]" : "[ ]") : "   "
      return {
        title: `${mark} ${row.text.replace(/\s+/g, " ")}`,
        value: row.key,
        category: CATEGORY[row.status],
        description: `${row.scope} ${row.kind}`,
        details: [
          `${row.reason} · ${row.file}${row.note ? ` → .opencode/memory/${row.note}` : ""}`,
          ...(row.otherText && row.status !== "duplicate" ? [`vs ${row.otherText.replace(/\s+/g, " ")}`] : []),
        ],
      }
    }),
  )

  const counts = props.preview.counts
  const footer = (
    <box paddingLeft={4} paddingRight={4} flexDirection="column">
      <text fg={theme.textMuted}>
        {`${props.preview.label} · sha256 ${props.preview.sha256.slice(0, 12)}… · ${counts.new} new, ${counts.conflict} conflict, ${counts.duplicate} duplicate, ${counts.rejected} rejected`}
      </text>
      <text fg={theme.textMuted}>
        {`Graph extraction: up to ${approved().size} call(s) to ${props.preview.extractionModel}. Embeddings: ${props.preview.embedding}, ${props.preview.remoteEmbeddingCalls} remote calls.`}
      </text>
      <For each={props.preview.warnings}>{(warning) => <text fg={theme.warning}>{warning}</text>}</For>
      <Show when={props.preview.limit}>
        <text fg={theme.error} attributes={TextAttributes.BOLD}>
          {props.preview.limit}
        </text>
      </Show>
    </box>
  )

  const apply = async () => {
    if (busy() || !approved().size || props.preview.limit) return
    setBusy(true)
    const result = await props.sdk.client.memory
      .import({ memoryImportApplyInput: { ...props.request, accept: [...approved()] } })
      .catch((error) => ({ error, data: undefined }))
    setBusy(false)
    dialog.clear()
    if (result.error || !result.data) {
      toast.show({
        variant: "error",
        title: "Nothing was imported",
        message: errorMessage(result.error),
        duration: 10_000,
      })
      return
    }
    const done = result.data
    toast.show({
      variant: done.failed.length ? "warning" : "success",
      title: "Memory imported",
      message: `${done.facts} fact(s)${done.noteParagraphs ? `, ${done.noteParagraphs} note paragraph(s)` : ""}${done.notes.length ? ` in ${done.notes.join(", ")}` : ""}${done.failed.length ? `; ${done.failed.length} not imported: ${done.failed[0].reason}` : ""}`,
      duration: 10_000,
    })
    props.onDone?.()
  }

  return (
    <DialogSelect
      title={`Import preview: nothing is written until you import${busy() ? " (importing…)" : ""}`}
      placeholder="Search rows…"
      options={options()}
      footer={footer}
      preserveSelection
      onSelect={(option) => {
        const row = props.preview.rows.find((item) => item.key === option.value)
        if (row && selectable(row)) toggle(row.key)
      }}
      actions={[
        {
          command: "dialog.memory.import.all",
          title: "all",
          withoutSelection: true,
          onTrigger: () => {
            const keys = props.preview.rows.filter(selectable).map((row) => row.key)
            const all = keys.every((key) => approved().has(key))
            setApproved(new Set(all ? [] : keys))
          },
        },
        {
          command: "dialog.memory.import.apply",
          title: "import",
          withoutSelection: true,
          disabled: () => busy() || !approved().size || !!props.preview.limit,
          onTrigger: () => void apply(),
        },
      ]}
    />
  )
}
