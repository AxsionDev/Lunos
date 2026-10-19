// XCOD-205: the /sessions view. Every session on this machine across projects, in the user's groups,
// shared with the desktop/web Sessions window through the same server API.
import { TextAttributes } from "@opentui/core"
import type { SessionGroup, SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useEvent } from "../context/event"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useCommandShortcut } from "../keymap"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import { useStartExternal } from "./dialog-external"
import { useTuiConfig } from "../config"
import { externalAccent, type ExternalTool } from "../util/external"
import {
  STATE_GLYPH,
  ago,
  build,
  clearPlan,
  clearQuestion,
  groupKey,
  inView,
  kindLabel,
  money,
  nextStateFilter,
  projectName,
  stateLabel,
  stopAndClearQuestion,
  stopPlan,
  stopQuestion,
  stopSummary,
  stoppable,
  toolOnly,
  topLevel,
  waiting,
  type Line,
  type StateFilter,
  queuedDeleteNote,
} from "../util/sessions-overview"

// Events after which the overview is re-read. The same list the desktop/web window uses.
const REFRESH_ON = new Set([
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.error",
  "permission.asked",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
  "session.group.updated",
  "session.live.updated",
  "server.instance.disposed",
  "global.disposed",
])

// Kept across re-opening the view (a rename or "move to group" prompt replaces it for a moment).
const [stateFilter, setStateFilter] = createSignal<StateFilter>("all")
const [ungroupedCollapsed, setUngroupedCollapsed] = createSignal(false)
// XCOD-265: the last Clear, for Undo, and the rows Stop all couldn't stop (with why). Kept here, not in
// the view, because every confirmation replaces the view and re-creates it.
const [lastClear, setLastClear] = createSignal<{ ids: string[]; at: number }>()
const [failedStops, setFailedStops] = createSignal<Record<string, string>>({})
/** How long Undo stays offered after a Clear. */
const UNDO_MS = 2 * 60 * 1000

export function DialogSessions(props: { select?: string }) {
  const dialog = useDialog()
  const route = useRoute()
  const sdk = useSDK()
  const event = useEvent()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const externalTool = (item: { kind: string; tool?: string }): ExternalTool | undefined =>
    item.kind !== "external"
      ? undefined
      : item.tool === "codex"
        ? "codex"
        : item.tool?.startsWith("claude")
          ? "claude"
          : undefined
  const startExternal = useStartExternal()
  const deleteHint = useCommandShortcut("dialog.sessions.group.delete")
  const project = useProject()
  const archivedView = () => stateFilter() === "archived"

  const [data, setData] = createStore({
    groups: [] as SessionGroup[],
    sessions: [] as SessionOverviewItem[],
    loaded: false,
  })
  const [search, setSearch] = createSignal("")
  const [now, setNow] = createSignal(Date.now())
  const [toDelete, setToDelete] = createSignal<string>()
  const [error, setError] = createSignal<string>()

  const fail = (cause: unknown) => toast.show({ variant: "error", message: errorMessage(cause) })

  let inflight = false
  let again = false
  async function load() {
    if (inflight) {
      again = true
      return
    }
    inflight = true
    try {
      const result = await sdk.client.experimental.session.overview(archivedView() ? { archived: true } : undefined, {
        throwOnError: true,
      })
      batch(() => {
        setData("groups", reconcile(result.data.groups, { key: "id" }))
        setData("sessions", reconcile(result.data.sessions, { key: "id" }))
        setData("loaded", true)
      })
      setNow(Date.now())
      setError(undefined)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      inflight = false
      if (again) {
        again = false
        void load()
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  function refresh() {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void load()
    }, 150)
  }

  onMount(() => {
    dialog.setSize("xlarge")
    void load()
  })
  // XCOD-265: Show archived reads a different list.
  createEffect(on(archivedView, () => void load(), { defer: true }))
  // Groups changed in the desktop app, the web UI or another TUI arrive as session.group.updated.
  onCleanup(event.subscribe((item) => REFRESH_ON.has(item.type) && refresh()))
  // Cost and "last activity" move without events from other processes; a slow poll keeps them honest.
  const poll = setInterval(refresh, 15_000)
  onCleanup(() => {
    clearInterval(poll)
    if (timer) clearTimeout(timer)
  })

  const lines = createMemo(() =>
    build({
      groups: data.groups,
      sessions: data.sessions,
      search: search(),
      state: stateFilter(),
      ungroupedCollapsed: ungroupedCollapsed(),
    }),
  )
  const byKey = createMemo(() => new Map(lines().map((line) => [line.key, line])))
  const line = (option: DialogSelectOption<string> | undefined) => (option ? byKey().get(option.value) : undefined)
  const sessionOf = (option: DialogSelectOption<string> | undefined) => {
    const found = line(option)
    return found?.type === "session" ? found.item : undefined
  }
  const groupOf = (option: DialogSelectOption<string> | undefined) => {
    const found = line(option)
    return found?.type === "group" ? found : undefined
  }

  function stateColor(item: SessionOverviewItem) {
    if (item.state === "waiting") return theme.warning
    if (item.state === "running") return theme.success
    if (item.state === "failed") return theme.error
    return theme.textMuted
  }

  // While searching or filtering, group names become plain headings, so the first row is the
  // first hit (Enter opens it). Otherwise a group is a row of its own, to collapse, rename or delete.
  const filtering = createMemo(() => !!search().trim() || stateFilter() !== "all")
  const options = createMemo((): DialogSelectOption<string>[] => {
    let heading: string | undefined
    return lines().flatMap((entry): DialogSelectOption<string>[] => {
      if (entry.type === "group") {
        const name = entry.group?.name ?? "Ungrouped"
        heading = `${name} (${entry.count})`
        if (filtering()) return []
        const deleting = entry.group && toDelete() === entry.group.id
        return [
          {
            value: entry.key,
            title: deleting
              ? `Press ${deleteHint()} again to delete "${name}" (its sessions go to Ungrouped)`
              : `${entry.collapsed ? "▸" : "▾"} ${name}`,
            description: deleting ? undefined : `${entry.count} ${entry.count === 1 ? "session" : "sessions"}`,
            footer: entry.collapsed ? "collapsed" : undefined,
            bg: deleting ? theme.error : undefined,
            titleWidth: 100,
          },
        ]
      }
      const item = entry.item
      const kind = kindLabel(item)
      const title = `${entry.depth ? "  ↳ " : ""}${item.title}`
      return [
        {
          value: entry.key,
          title,
          // XCOD-260: an accent dot before an external session; its tool is named in the description.
          titleView: externalTool(item) ? (
            <>
              <span
                style={{
                  fg: externalAccent(theme, externalTool(item)!, tuiConfig.external_accent !== false) ?? theme.text,
                }}
              >
                ●{" "}
              </span>
              {title}
            </>
          ) : undefined,
          category: filtering() ? heading : undefined,
          titleWidth: 40,
          description: [projectName(item), kind].filter(Boolean).join(" · "),
          footer: [
            failedStops()[item.id] && stoppable(item) ? `couldn't stop: ${failedStops()[item.id]}` : undefined,
            item.archived ? `archived ${ago(item.archived, now())}` : stateLabel(item),
            item.agent,
            item.model ? Locale.truncateMiddle(item.model, 24) : undefined,
            ago(item.updated, now()),
            money(item.cost),
          ]
            .filter(Boolean)
            .join(" · "),
          gutter: () => <text fg={stateColor(item)}>{STATE_GLYPH[item.state]}</text>,
        },
      ]
    })
  })

  const reopen = (select?: string) => dialog.replace(() => <DialogSessions select={select} />)

  // Back from a prompt, the row it was about is selected again once the list has loaded.
  let list: DialogSelectRef<string> | undefined
  let pending = props.select
  createEffect(() => {
    if (!pending || !list || !byKey().has(pending)) return
    list.moveTo(pending)
    pending = undefined
  })
  const currentSessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)

  async function open(item: SessionOverviewItem) {
    if (toolOnly(item)) {
      if (item.state === "running" || (item.tool !== "claude" && item.tool !== "codex")) {
        toast.show({
          variant: "info",
          message: `That ${item.tool ?? "external"} session is running in its own process.`,
        })
        return
      }
      // Opens it in a Lunos session view, as `/external resume` does. The tool only starts with
      // the next prompt sent there.
      await startExternal(item.tool as ExternalTool, item.id.replace(/^external:/, ""))
      return
    }
    // XCOD-234: another Lunos runs it, and its pending request lives there: answer it from here.
    if (item.elsewhere && item.state === "waiting") return answerElsewhere(item)
    dialog.clear()
    // A session waiting for approval opens at its prompt: the session view shows the pending request.
    route.navigate({ type: "session", sessionID: item.id })
  }

  /** XCOD-234: the Lunos that runs the session checks and audits the answer. */
  async function answerElsewhere(item: SessionOverviewItem) {
    const asks = await sdk.client.experimental.peer
      .asks({ sessionID: item.id }, { throwOnError: true })
      .then((result) => result.data)
      .catch((cause) => (fail(cause), undefined))
    const request = asks?.permissions[0]
    const question = asks?.questions[0]
    if (!request && !question) return reopen(item.id)
    const what = request
      ? `${request.permission}${request.patterns.length ? `: ${request.patterns.join(", ")}` : ""}`
      : (question!.questions[0]?.question ?? "a question")
    const choice = await new Promise<string | undefined>((resolve) =>
      dialog.replace(
        () => (
          <DialogSelect<string>
            title={`"${Locale.truncate(item.title, 30)}" (another Lunos) asks: ${Locale.truncate(what, 60)}`}
            options={
              request
                ? [
                    { value: "once", title: "Allow once" },
                    { value: "always", title: "Allow always" },
                    { value: "reject", title: "Deny" },
                  ]
                : [{ value: "dismiss", title: "Dismiss (answer it in the Lunos that runs it)" }]
            }
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(undefined),
      ),
    )
    if (choice === undefined) return reopen(item.id)
    const reply = request
      ? sdk.client.experimental.peer.permissionReply(
          { sessionID: item.id, requestID: request.id, reply: choice as "once" | "always" | "reject" },
          { throwOnError: true },
        )
      : sdk.client.experimental.peer.questionReject(
          { sessionID: item.id, requestID: question!.id },
          { throwOnError: true },
        )
    await reply.catch(fail)
    reopen(item.id)
  }

  async function toggle(entry: Extract<Line, { type: "group" }>) {
    if (!entry.group) {
      setUngroupedCollapsed((value) => !value)
      return
    }
    const groupID = entry.group.id
    const collapsed = !entry.group.collapsed
    setData("groups", (group) => group.id === groupID, "collapsed", collapsed)
    await sdk.client.experimental.sessionGroup.update({ groupID, collapsed }, { throwOnError: true }).catch(fail)
    refresh()
  }

  async function createGroup(select?: string) {
    const name = await DialogPrompt.show(dialog, "New group", { placeholder: "Group name" })
    if (!name?.trim()) return reopen(select)
    const result = await sdk.client.experimental.sessionGroup
      .create({ name: name.trim() }, { throwOnError: true })
      .catch((cause) => (fail(cause), undefined))
    reopen(result?.data ? groupKey(result.data.id) : select)
    return result?.data
  }

  async function move(item: SessionOverviewItem) {
    const NEW = "new"
    const UNGROUPED = "ungrouped"
    const choice = await new Promise<string | undefined>((resolve) =>
      dialog.replace(
        () => (
          <DialogSelect<string>
            title={`Move "${Locale.truncate(item.title, 40)}" to group`}
            current={item.groupID ?? UNGROUPED}
            options={[
              ...data.groups.map((group) => ({ value: group.id, title: group.name })),
              { value: UNGROUPED, title: "Ungrouped" },
              { value: NEW, title: "New group…" },
            ]}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(undefined),
      ),
    )
    if (choice === undefined) return reopen(item.id)
    let groupID: string | undefined = choice === UNGROUPED ? undefined : choice
    if (choice === NEW) {
      const name = await DialogPrompt.show(dialog, "New group", { placeholder: "Group name" })
      if (!name?.trim()) return reopen(item.id)
      const created = await sdk.client.experimental.sessionGroup
        .create({ name: name.trim() }, { throwOnError: true })
        .catch((cause) => (fail(cause), undefined))
      if (!created?.data) return reopen(item.id)
      groupID = created.data.id
    }
    await sdk.client.experimental.sessionGroup
      .move({ sessionIDs: [item.id], ...(groupID ? { groupID } : {}) }, { throwOnError: true })
      .catch(fail)
    reopen(item.id)
  }

  async function rename(option: DialogSelectOption<string>) {
    const group = groupOf(option)?.group
    if (group) {
      const name = await DialogPrompt.show(dialog, "Rename group", { value: group.name })
      if (name?.trim() && name.trim() !== group.name)
        await sdk.client.experimental.sessionGroup
          .update({ groupID: group.id, name: name.trim() }, { throwOnError: true })
          .catch(fail)
      return reopen(option.value)
    }
    const item = sessionOf(option)
    if (!item || toolOnly(item)) return
    const title = await DialogPrompt.show(dialog, "Rename session", { value: item.title })
    if (title?.trim() && title.trim() !== item.title)
      await sdk.client.session.update({ sessionID: item.id, title: title.trim() }, { throwOnError: true }).catch(fail)
    reopen(option.value)
  }

  async function removeGroup(option: DialogSelectOption<string>) {
    const group = groupOf(option)?.group
    if (!group) return
    if (toDelete() !== group.id) {
      setToDelete(group.id)
      return
    }
    setToDelete(undefined)
    await sdk.client.experimental.sessionGroup.delete({ groupID: group.id }, { throwOnError: true }).catch(fail)
    refresh()
  }

  async function stop(item: SessionOverviewItem) {
    // XCOD-234: a Claude Code / Codex session Lunos started, stopped like `lunos external stop`.
    const request = item.elsewhere
      ? sdk.client.experimental.peer.stop({ sessionID: item.id }, { throwOnError: true })
      : toolOnly(item)
        ? sdk.client.experimental.external.stop(
            { sessionID: item.id.replace(/^external:/, "") },
            { throwOnError: true },
          )
        : sdk.client.session.abort({ sessionID: item.id }, { throwOnError: true })
    await request
      .then(() => toast.show({ variant: "info", message: `Stopped "${Locale.truncate(item.title, 40)}"` }))
      .catch(fail)
    refresh()
  }

  /** XCOD-265: the rows Stop all and Clear list act on (state filter and search; collapsed groups count). */
  const viewItems = () =>
    inView({ groups: data.groups, sessions: data.sessions, search: search(), state: stateFilter() })

  /** Asks once; the first option is the default and Esc cancels. */
  function confirm<T extends string>(message: string, options: { value: T; title: string }[]) {
    return new Promise<T | undefined>((resolve) =>
      dialog.replace(
        () => (
          <DialogSelect<T | "cancel">
            title={message}
            titleView={
              <box flexShrink={1} paddingRight={2}>
                <text fg={theme.text} wrapMode="word">
                  {message}
                </text>
              </box>
            }
            renderFilter={false}
            options={[...options, { value: "cancel" as const, title: "Cancel" }]}
            onSelect={(option) => resolve(option.value === "cancel" ? undefined : (option.value as T))}
          />
        ),
        () => resolve(undefined),
      ),
    )
  }

  async function stopAll() {
    const plan = stopPlan(viewItems())
    if (plan.targets.length === 0)
      return toast.show({ variant: "info", message: "Nothing in this view is running or waiting." })
    const here = (item: SessionOverviewItem) => !!item.project && item.project.id === project.project()
    const local = plan.targets.filter(here)
    const choice = await confirm(stopQuestion(plan), [
      { value: "all", title: `Stop ${plan.targets.length}` },
      // XCOD-265: the view spans several projects; this Lunos's project alone is offered too.
      ...(plan.projects.length > 1 && local.length > 0
        ? [{ value: "project" as const, title: `Stop all in this project only (${local.length})` }]
        : []),
    ])
    if (!choice) return reopen()
    const targets = choice === "project" ? local : plan.targets
    setFailedStops({})
    const result = await sdk.client.experimental.sessionBulk
      .stop({ sessionIDs: targets.map((item) => item.id) }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result) {
      setFailedStops(Object.fromEntries(result.failed.map((item) => [item.id, item.reason])))
      toast.show({ variant: result.failed.length ? "warning" : "success", message: stopSummary(result) })
    }
    reopen()
  }

  function cleared(ids: string[], prefix = "") {
    setLastClear({ ids, at: Date.now() })
    toast.show({
      variant: "success",
      message: `${prefix}Cleared ${ids.length} from the list · "undo" brings ${ids.length === 1 ? "it" : "them"} back`,
      duration: 8000,
    })
  }

  async function clearList() {
    const plan = clearPlan(viewItems())
    const running = stopPlan(plan.staying).targets.length
    if (plan.targets.length === 0 && running === 0)
      return toast.show({ variant: "info", message: "Nothing in this view to clear." })
    const choice =
      plan.targets.length === 0
        ? await confirm(clearQuestion(plan), [{ value: "stop" as const, title: "Stop all & clear" }])
        : await confirm(clearQuestion(plan), [
            { value: "clear" as const, title: `Clear ${plan.targets.length}` },
            ...(running ? [{ value: "stop" as const, title: "Stop all & clear" }] : []),
          ])
    if (!choice) return reopen()
    if (choice === "stop") return stopAllAndClear(true)
    const result = await sdk.client.experimental.sessionBulk
      .archive({ sessionIDs: plan.targets.map((item) => item.id) }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result) cleared(result.archived)
    reopen()
  }

  async function stopAllAndClear(confirmed = false) {
    const items = viewItems()
    const stop = stopPlan(items).targets
    const clear = clearPlan(items).targets
    if (stop.length + clear.length === 0)
      return toast.show({ variant: "info", message: "Nothing in this view to stop or clear." })
    if (!confirmed) {
      const choice = await confirm(stopAndClearQuestion(items), [
        { value: "go" as const, title: `Stop ${stop.length} and clear ${stop.length + clear.length}` },
      ])
      if (!choice) return reopen()
    }
    setFailedStops({})
    const result = await sdk.client.experimental.sessionBulk
      .archive({ sessionIDs: [...stop, ...clear].map((item) => item.id), stop: true }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result) {
      const failed = result.failed ?? []
      setFailedStops(Object.fromEntries(failed.map((item) => [item.id, item.reason])))
      cleared(result.archived, `${stopSummary({ stopped: result.stopped ?? [], failed })} · `)
    }
    reopen()
  }

  const undoable = () => {
    const last = lastClear()
    return !!last && last.ids.length > 0 && Date.now() - last.at < UNDO_MS
  }

  async function undo() {
    const last = lastClear()
    if (!last) return
    setLastClear(undefined)
    const result = await sdk.client.experimental.sessionBulk
      .unarchive({ sessionIDs: last.ids }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result) toast.show({ variant: "success", message: `Brought back ${result.archived.length}` })
    refresh()
  }

  async function unarchive(item: SessionOverviewItem) {
    const result = await sdk.client.experimental.sessionBulk
      .unarchive({ sessionIDs: [item.id] }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result?.archived.length)
      toast.show({ variant: "success", message: `"${Locale.truncate(item.title, 40)}" is back in the list` })
    refresh()
  }

  /** XCOD-265: permanent, so the count is typed back, as Forget all in the memory browser. */
  async function deleteArchived() {
    const items = topLevel(viewItems().filter((item) => !!item.archived))
    if (items.length === 0) return toast.show({ variant: "info", message: "No archived sessions in this view." })
    const projects = [...new Set(items.map((item) => projectName(item)))].join(", ")
    const count = items.length
    // XCOD-269: prompts queued for them and never sent go with them.
    const queued = queuedDeleteNote(items.reduce((sum, item) => sum + (item.queued ?? 0), 0))
    const typed = await DialogPrompt.show(dialog, `Delete ${count} archived ${count === 1 ? "session" : "sessions"}?`, {
      placeholder: `type ${count} to confirm`,
      description: () => (
        <text fg={theme.textMuted} wrapMode="word">
          Their history is deleted for good; this can't be undone. Projects: {projects}
          {queued ? ` ${queued}` : ""}
        </text>
      ),
    })
    if (typed?.trim() !== String(count)) {
      if (typed !== null) toast.show({ variant: "warning", message: "Nothing was deleted: the count didn't match." })
      return reopen()
    }
    const result = await sdk.client.experimental.sessionBulk
      .delete({ sessionIDs: items.map((item) => item.id) }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result) {
      const skipped = result.skipped.length ? ` · ${result.skipped.length} skipped` : ""
      toast.show({ variant: "success", message: `Deleted ${result.deleted.length} for good${skipped}` })
    }
    reopen()
  }

  const waitingCount = createMemo(() => waiting(data.sessions))
  const titleView = (
    <text fg={theme.text} attributes={TextAttributes.BOLD}>
      {archivedView() ? "Archived sessions — all projects" : "Sessions — all projects"}
      <span style={{ fg: theme.textMuted }}>
        {" · "}
        {data.sessions.length} {data.sessions.length === 1 ? "session" : "sessions"}
      </span>
      {waitingCount() > 0 ? (
        <span style={{ fg: theme.warning }}>
          {" · "}
          {STATE_GLYPH.waiting} {waitingCount()} waiting
        </span>
      ) : null}
      {stateFilter() !== "all" ? <span style={{ fg: theme.accent }}> · state: {stateFilter()}</span> : null}
    </text>
  )

  return (
    <DialogSelect<string>
      title="Sessions"
      titleView={titleView}
      placeholder="Search by name, project, state or group"
      options={options()}
      skipFilter={true}
      preserveSelection={true}
      fill={true}
      ref={(ref) => (list = ref)}
      // The session open behind the view is marked, as in the switcher.
      current={props.select ? undefined : currentSessionID()}
      onFilter={setSearch}
      onMove={() => setToDelete(undefined)}
      emptyView={
        <box paddingLeft={4} paddingRight={4} paddingTop={1}>
          <text fg={theme.textMuted}>
            {error()
              ? `Couldn't load sessions: ${error()}`
              : !data.loaded
                ? "Loading sessions…"
                : search() || (stateFilter() !== "all" && !archivedView())
                  ? "No sessions match"
                  : archivedView()
                    ? "No archived sessions"
                    : "No sessions yet"}
          </text>
        </box>
      }
      onSelect={(option) => {
        const entry = line(option)
        if (!entry) return
        if (entry.type === "group") return void toggle(entry)
        void open(entry.item)
      }}
      footerHints={[{ title: "open", label: "enter" }]}
      actions={[
        {
          command: "dialog.sessions.move",
          hidden: archivedView(),
          title: "move",
          disabled: (option) => !sessionOf(option),
          onTrigger: (option) => {
            const item = sessionOf(option)
            if (item) void move(item)
          },
        },
        {
          command: "dialog.sessions.group.new",
          hidden: archivedView(),
          title: "new group",
          withoutSelection: true,
          onTrigger: (option) => void createGroup(option?.value),
        },
        {
          command: "dialog.sessions.rename",
          hidden: archivedView(),
          title: "rename",
          disabled: (option) => {
            const entry = line(option)
            if (!entry) return true
            return entry.type === "group" ? !entry.group : toolOnly(entry.item)
          },
          onTrigger: (option) => void rename(option),
        },
        {
          command: "dialog.sessions.group.delete",
          hidden: archivedView(),
          title: "delete",
          disabled: (option) => !groupOf(option)?.group,
          onTrigger: (option) => void removeGroup(option),
        },
        {
          command: "dialog.sessions.stop",
          hidden: archivedView(),
          title: "stop",
          disabled: (option) => {
            const item = sessionOf(option)
            return !item || !stoppable(item)
          },
          onTrigger: (option) => {
            const item = sessionOf(option)
            if (item && stoppable(item)) void stop(item)
          },
        },
        {
          command: "dialog.sessions.state",
          title: "state",
          withoutSelection: true,
          onTrigger: () => setStateFilter((value) => nextStateFilter(value)),
        },
        // XCOD-265: unbound by default, so `menu` keeps them in the footer and the Tab menu.
        {
          command: "dialog.sessions.stop_all",
          title: "stop all",
          menu: true,
          hidden: archivedView(),
          withoutSelection: true,
          onTrigger: () => void stopAll(),
        },
        {
          command: "dialog.sessions.clear",
          title: "clear list",
          menu: true,
          hidden: archivedView(),
          withoutSelection: true,
          onTrigger: () => void clearList(),
        },
        {
          command: "dialog.sessions.stop_all_clear",
          title: "stop all & clear",
          menu: true,
          hidden: archivedView(),
          withoutSelection: true,
          onTrigger: () => void stopAllAndClear(),
        },
        {
          command: "dialog.sessions.undo",
          title: "undo",
          menu: true,
          hidden: archivedView() || !undoable(),
          withoutSelection: true,
          onTrigger: () => void undo(),
        },
        {
          command: "dialog.sessions.unarchive",
          title: "unarchive",
          menu: true,
          hidden: !archivedView(),
          disabled: (option) => !sessionOf(option)?.archived,
          onTrigger: (option) => {
            const item = sessionOf(option)
            if (item) void unarchive(item)
          },
        },
        {
          command: "dialog.sessions.delete_archived",
          title: "delete archived",
          menu: true,
          hidden: !archivedView(),
          withoutSelection: true,
          onTrigger: () => void deleteArchived(),
        },
        {
          command: "dialog.sessions.archived",
          title: archivedView() ? "back to list" : "show archived",
          menu: true,
          withoutSelection: true,
          onTrigger: () => setStateFilter(archivedView() ? "all" : "archived"),
        },
      ]}
    />
  )
}
