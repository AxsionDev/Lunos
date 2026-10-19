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
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSettings } from "./dialog-settings"
import { activityRows, idsFor, overviewRows } from "../util/memory-stats"

// XCOD-252: /memory opens on Overview, with Activity and Facts (the browser below) beside it.
// The range applies to everything time-based and is kept for the session.
type Tab = "overview" | "activity" | "facts"
const TABS: Tab[] = ["overview", "activity", "facts"]
const TAB_LABEL: Record<Tab, string> = { overview: "Overview", activity: "Activity", facts: "Facts" }
const RANGES = [7, 30, 90, undefined] as const
let range: number | undefined = 30

// XCOD-94: the memory browser. Lists every remembered fact with where it came from (read from
// the provenance ledger, so opening it never starts memory), shows the entities and relationships
// around the highlighted fact, and forgets a fact on a double press of the forget key. Export
// (XCOD-132) writes all of memory out as a bundle or Markdown, with the CLI's options. Import
// (XCOD-133) previews an import, with approve/reject per row, before anything is written. Outdate
// (XCOD-136) marks a fact as no longer true on a double press: it is kept, but not recalled. Each
// fact shows its state: outdated, expired, quarantined (failed the ledger's integrity check), and
// whether the agent inferred it.
export function DialogMemory(props: { tab?: Tab; filter?: { label: string; ids: string[] }; from?: Tab } = {}) {
  const dialog = useDialog()
  const [tab, setTab] = createSignal<Tab>(props.tab ?? "overview")
  const [days, setDays] = createSignal<number | undefined>(range)
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

  // Analytics, computed locally by the server from the ledger and the local audit log.
  const [stats, statsActions] = createResource(
    () => ({ days: days() }),
    (input) =>
      sdk.client.memory
        .stats(input.days ? { days: String(input.days) } : {}, { throwOnError: true })
        .then((result) => result.data)
        .catch((error) => {
          setLoadError(error)
          return undefined
        }),
  )
  const filterIDs = createMemo(() => (props.filter ? new Set(props.filter.ids) : undefined))
  const shownFacts = createMemo(() => {
    const all = memory()?.facts ?? []
    const only = filterIDs()
    return only ? all.filter((fact) => only.has(fact.id)) : all
  })

  const title = () => {
    const strip = TABS.map((item) => (item === tab() ? `[${TAB_LABEL[item]}]` : TAB_LABEL[item])).join("  ")
    const label = days() ? `${days()}d` : "all"
    const off = memory()?.on === false ? " (off)" : ""
    const filter = props.filter ? ` · ${props.filter.label} (${props.filter.ids.length}) · ← clears` : ""
    return `Memory${off}  ${strip}  · ${label}${filter}`
  }
  const nextTab = () => {
    if (props.filter) return dialog.replace(() => <DialogMemory tab={TABS[(TABS.indexOf(tab()) + 1) % TABS.length]} />)
    setTab(TABS[(TABS.indexOf(tab()) + 1) % TABS.length]!)
  }
  const nextRange = () => {
    range = RANGES[(RANGES.indexOf(days() as (typeof RANGES)[number]) + 1) % RANGES.length]
    setDays(range)
  }
  const drill = (group: string, label: string) => {
    const data = stats()
    if (!data) return
    const from = tab()
    dialog.replace(
      () => <DialogMemory tab="facts" filter={{ label, ids: idsFor(data, group) }} from={from} />,
      undefined,
      {
        back: () => dialog.replace(() => <DialogMemory tab={from} />),
      },
    )
  }
  const factText = (id: string) => memory()?.facts.find((fact) => fact.id === id)?.text

  // Show the first fact's provenance and connections without a keypress.
  createEffect(() => {
    const facts = shownFacts()
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
    const facts = shownFacts()
    const connections = related()
    const recalls = stats()?.facts ?? {}
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
              recalls[fact.id]
                ? `recalled ${recalls[fact.id]!.recalls}× in this range · last ${recalls[fact.id]!.last.slice(0, 16).replace("T", " ")}`
                : stats()?.recall.audit
                  ? "not recalled in this range"
                  : "recalls aren't recorded (the audit log is off)",
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

  // XCOD-252: forgets every fact a drill-down lists, after the count is typed back. One forget per
  // fact, so the audit log gets one entry each, as when they're forgotten one by one.
  const forgetAll = async () => {
    const facts = shownFacts()
    const scopes = [...new Set(facts.map((fact) => fact.scope))].join(" and ")
    const typed = await DialogPrompt.show(dialog, `Forget ${facts.length} facts from ${scopes} memory?`, {
      placeholder: `type ${facts.length} to confirm`,
    })
    if (typed?.trim() !== String(facts.length)) {
      if (typed !== null) toast.show({ variant: "warning", message: "Nothing was forgotten: the count didn't match." })
      return dialog.replace(() => <DialogMemory tab="facts" filter={props.filter} from={props.from} />)
    }
    let done = 0
    for (const fact of facts) {
      const result = await sdk.client.memory.forget({ id: fact.id }).catch((error) => ({ error }))
      if (result.error) {
        toast.show({ variant: "error", title: `Stopped after ${done}`, message: errorMessage(result.error) })
        break
      }
      done++
    }
    if (done === facts.length)
      toast.show({
        variant: "success",
        title: "Forgotten",
        message: `${done} facts. Later sessions won't recall them.`,
      })
    // Back where the drill-down started, with counts read again.
    dialog.replace(() => <DialogMemory tab={props.from ?? "overview"} />)
  }

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

  const tabActions = [
    {
      command: "dialog.memory.tab",
      title: "next tab",
      withoutSelection: true,
      onTrigger: nextTab,
    },
    {
      command: "dialog.memory.range",
      title: "range",
      withoutSelection: true,
      onTrigger: nextRange,
    },
  ]

  const statsOptions = createMemo<DialogSelectOption<string>[]>(() => {
    const data = stats()
    if (!data) return []
    const rows = tab() === "overview" ? overviewRows(data) : activityRows(data, factText)
    const off =
      tab() === "overview" && !data.status.on
        ? [{ title: "Set up memory in Settings → Memory", value: "+settings", category: "Status" }]
        : []
    return [
      ...rows.map((row) => ({ title: row.title, value: row.value, category: row.category, footer: row.footer })),
      ...off,
    ]
  })

  if (tab() !== "facts")
    return (
      <DialogSelect
        title={title()}
        placeholder={
          tab() === "overview" ? "What's in memory, where it came from" : "How memory grows and what is recalled"
        }
        options={statsOptions()}
        skipFilter
        emptyView={
          loadError() ? (
            emptyView()
          ) : (
            <box paddingLeft={4} paddingRight={4}>
              <text fg={theme.textMuted}>Loading…</text>
            </box>
          )
        }
        onSelect={(option) => {
          if (option.value === "+settings")
            return dialog.replace(() => <DialogSettings tab="settings" focus="memory.enabled" />)
          const data = stats()
          if (!data) return
          const row = (tab() === "overview" ? overviewRows(data) : activityRows(data, factText)).find(
            (item) => item.value === option.value,
          )
          if (row?.group) drill(row.group, row.title.replace(/\s+/g, " ").split(":")[0]!.slice(0, 48))
        }}
        actions={tabActions}
      />
    )

  return (
    <DialogSelect
      title={title()}
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
        ...tabActions,
        {
          command: "dialog.memory.forget_all",
          title: `forget all ${shownFacts().length} shown`,
          hidden: !props.filter,
          withoutSelection: true,
          disabled: () => memory()?.on !== true || !shownFacts().length,
          onTrigger: () => void forgetAll(),
        },
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
