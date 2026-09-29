import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useCommandShortcut } from "../keymap"
import { errorMessage } from "../util/error"
import { exportMemory } from "./dialog-memory-export"
import { importMemory } from "./dialog-memory-import"

// XCOD-94: the memory browser. Lists every remembered fact with where it came from (read from
// the provenance ledger, so opening it never starts memory), shows the entities and relationships
// around the highlighted fact, and forgets a fact on a double press of the forget key. Export
// (XCOD-132) writes all of memory out as a bundle or Markdown, with the CLI's options. Import
// (XCOD-133) previews an import, with approve/reject per row, before anything is written. Outdate
// (XCOD-136) marks a fact as no longer true on a double press: it is kept, but not recalled. Each
// fact shows its state: outdated, expired, quarantined (failed the ledger's integrity check), and
// whether the agent inferred it.
export function DialogMemory() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const forgetHint = useCommandShortcut("dialog.memory.forget")
  const outdateHint = useCommandShortcut("dialog.memory.outdate")
  const [toOutdate, setToOutdate] = createSignal<string>()
  dialog.setSize("large")

  const [loadError, setLoadError] = createSignal<unknown>()
  const [toForget, setToForget] = createSignal<string>()
  const [highlighted, setHighlighted] = createSignal<string>()

  const [memory, { refetch }] = createResource(() =>
    sdk.client.memory
      .list({}, { throwOnError: true })
      .then((result) => result.data)
      // Catch so the rejected resource never reaches the memos below and tears down the dialog.
      .catch((error) => {
        setLoadError(error)
        return undefined
      }),
  )

  // Show the first fact's provenance and connections without a keypress.
  createEffect(() => {
    const facts = memory()?.facts ?? []
    if (!facts.some((fact) => fact.id === highlighted())) setHighlighted(facts[0]?.id)
  })

  // Connections for the highlighted fact. Loading them starts memory, so only while it is on.
  const [related] = createResource(
    () => (memory()?.on ? highlighted() : undefined),
    (id) =>
      sdk.client.memory
        .related({ id }, { throwOnError: true })
        .then((result) => ({ id, lines: result.data ?? [] }))
        .catch((error) => ({ id, lines: [`Could not load connections: ${errorMessage(error)}`] })),
  )

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const facts = memory()?.facts ?? []
    const connections = related()
    return facts.map((fact) => {
      const isForgetting = toForget() === fact.id
      const isOutdating = toOutdate() === fact.id
      const state =
        fact.state === "active"
          ? ""
          : fact.state === "outdated"
            ? `outdated ${fact.invalidAt?.slice(0, 10) ?? ""}${fact.replacedBy ? ` → ${fact.replacedBy}` : ""}`
            : fact.state === "quarantined"
              ? `QUARANTINED: ${fact.quarantined ?? ""}`
              : `expired ${fact.expires?.slice(0, 10) ?? ""}`
      const details =
        highlighted() === fact.id
          ? [
              ...(state ? [state] : []),
              ...(fact.kind === "inferred" ? ["inferred by the agent"] : []),
              fact.importedFrom
                ? `imported · ${fact.scope} memory · ${fact.date.slice(0, 10)} · from ${fact.importedFrom}${fact.originSource ? ` · originally ${fact.originSource}, ${fact.originDate?.slice(0, 10)}` : ""}`
                : `${fact.scope} memory · ${fact.date.slice(0, 10)} · from ${fact.source} · ${fact.agent} · ${fact.sessionID}`,
              ...(connections?.id === fact.id
                ? connections.lines.length
                  ? connections.lines.map((line) => `  ${line}`)
                  : ["  No connections in the graph"]
                : memory()?.on
                  ? ["  Loading connections…"]
                  : []),
            ]
          : undefined
      return {
        title: isForgetting
          ? `Press ${forgetHint()} again to forget`
          : isOutdating
            ? `Press ${outdateHint()} again to mark outdated`
            : `${fact.state === "active" ? "" : `[${fact.state === "purge" ? "expired" : fact.state}] `}${fact.text.replace(/\s+/g, " ")}`,
        bg: isForgetting ? theme.error : isOutdating ? theme.warning : undefined,
        value: fact.id,
        category: fact.scope === "project" ? "Project memory" : "User memory",
        details,
      }
    })
  })

  const emptyView = () => {
    if (loadError())
      return (
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.error} attributes={TextAttributes.BOLD}>
            Could not load memory
          </text>
          <text fg={theme.textMuted}>{errorMessage(loadError())}</text>
        </box>
      )
    if (memory.loading) return undefined
    return (
      <box paddingLeft={4} paddingRight={4}>
        <text fg={theme.textMuted}>
          {memory()?.on ? "Nothing remembered yet." : `Nothing remembered. Memory is off: ${memory()?.reason ?? ""}`}
        </text>
      </box>
    )
  }

  return (
    <DialogSelect
      title={memory()?.on === false ? "Memory (off)" : "Memory"}
      placeholder="Search facts…"
      options={options()}
      emptyView={emptyView()}
      onMove={(option) => {
        setToForget(undefined)
        setToOutdate(undefined)
        setHighlighted(option.value)
      }}
      onSelect={(option) => setHighlighted(option.value)}
      actions={[
        {
          command: "dialog.memory.export",
          title: "export",
          disabled: () => !memory()?.facts.length,
          onTrigger: () => exportMemory({ dialog, sdk, toast }),
        },
        {
          command: "dialog.memory.import",
          title: "import",
          withoutSelection: true,
          disabled: () => memory()?.on !== true,
          onTrigger: () =>
            importMemory({
              dialog,
              sdk,
              toast,
              onDone: () => dialog.replace(() => <DialogMemory />),
            }),
        },
        {
          command: "dialog.memory.outdate",
          title: "outdate",
          disabled: () => memory()?.on !== true,
          onTrigger: async (option) => {
            const fact = memory()?.facts.find((item) => item.id === option.value)
            if (fact?.state !== "active") {
              toast.show({
                variant: "error",
                title: "Not active",
                message: "Only an active fact can be marked outdated.",
              })
              return
            }
            setToForget(undefined)
            if (toOutdate() !== option.value) return setToOutdate(option.value)
            setToOutdate(undefined)
            const result = await sdk.client.memory.outdate({ id: option.value }).catch((error) => ({ error }))
            if (result.error) {
              toast.show({ variant: "error", title: "Could not mark it outdated", message: errorMessage(result.error) })
              return
            }
            toast.show({
              variant: "success",
              title: "Outdated",
              message: "Kept for history; later sessions won't recall it.",
            })
            await refetch()
          },
        },
        {
          command: "dialog.memory.forget",
          title: "forget",
          disabled: () => memory()?.on !== true,
          onTrigger: async (option) => {
            if (toForget() !== option.value) return setToForget(option.value)
            setToForget(undefined)
            const result = await sdk.client.memory.forget({ id: option.value }).catch((error) => ({ error }))
            if (result.error) {
              toast.show({ variant: "error", title: "Could not forget the fact", message: errorMessage(result.error) })
              return
            }
            toast.show({ variant: "success", title: "Forgotten", message: "Later sessions won't recall it." })
            await refetch()
          },
        },
      ]}
    />
  )
}
