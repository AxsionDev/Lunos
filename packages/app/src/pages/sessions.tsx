import type {
  SessionGroup,
  SessionOverview,
  SessionOverviewItem,
  SessionPeerAsks as PeerAsks,
} from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { showToast } from "@/utils/toast"
import { SessionPermissionDock } from "./session/composer/session-permission-dock"
import {
  build,
  clearPlan,
  GROUP_COLORS,
  inView,
  money as formatMoney,
  projectKey,
  projectName,
  STATE_ORDER,
  stopPlan,
  topLevel,
  UNGROUPED,
  waiting,
  type Filter,
  type Row,
  type Section,
} from "./sessions/sessions-model"
import { useBulkConfirm } from "./sessions/bulk-confirm"
import { useOpenSession } from "./sessions/open-session"

// Events after which the overview is re-read. Everything else is noise for this page.
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
  "server.connected",
])

const DRAG_TYPE = "application/x-lunos-session"

/** How long Undo stays offered after a Clear (XCOD-265), as in /sessions. */
const UNDO_MS = 2 * 60 * 1000

/**
 * XCOD-205: every session on this machine, across projects, in the user's groups. The same page
 * is the web UI's /sessions and the desktop app's Sessions window.
 */
export function SessionsPage() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const platform = usePlatform()
  const openSession = useOpenSession()

  const ctx = createMemo(() => (server.current ? global.ensureServerCtx(server.current) : undefined))
  const client = () => ctx()?.sdk.client

  const [data, setData] = createStore<SessionOverview & { loaded: boolean }>({
    groups: [],
    sessions: [],
    loaded: false,
  })
  const [filter, setFilter] = createStore<Filter>({ search: "", state: "all", group: "all" })
  const [ui, setUi] = createStore({
    newGroup: "",
    renamingGroup: undefined as string | undefined,
    renamingSession: undefined as string | undefined,
    draft: "",
    dropTarget: undefined as string | undefined,
    // XCOD-234: what a session another Lunos runs is waiting for, shown under its row.
    peerAsks: undefined as { sessionID: string; asks: PeerAsks } | undefined,
    responding: false,
  })
  const [error, setError] = createSignal<string>()
  // XCOD-265: the last Clear, for Undo, and the rows Stop all couldn't stop (with why).
  const [lastClear, setLastClear] = createSignal<string[]>()
  const [failedStops, setFailedStops] = createSignal<Record<string, string>>({})
  const archivedView = () => filter.state === "archived"
  const confirm = useBulkConfirm()

  const fail = (cause: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: cause instanceof Error ? cause.message : String((cause as any)?.data?.message ?? cause),
    })

  let inflight = false
  let again = false
  const load = async () => {
    const sdk = client()
    if (!sdk) return
    if (inflight) {
      again = true
      return
    }
    inflight = true
    // XCOD-265: Show archived reads a different list; a load started for the other one is dropped.
    const archived = archivedView()
    try {
      const result = await sdk.experimental.session.overview(archived ? { archived: true } : undefined)
      if (result.data && archived === archivedView()) {
        setData({ groups: result.data.groups, sessions: result.data.sessions, loaded: true })
        setError(undefined)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inflight = false
      if (again || archived !== archivedView()) {
        again = false
        void load()
      }
    }
  }

  createEffect(
    on(
      archivedView,
      () => {
        setData({ sessions: [], loaded: false })
        void load()
      },
      { defer: true },
    ),
  )

  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void load()
    }, 150)
  }

  onMount(() => {
    const current = ctx()
    if (!current) return
    void load()
    const off = current.sdk.event.listen((event) => {
      if (REFRESH_ON.has(event.details.type)) refresh()
    })
    void current.sdk.event.start()
    // Cost and "last activity" move without events from other processes; a slow poll keeps them honest.
    const poll = setInterval(refresh, 15_000)
    onCleanup(() => {
      off()
      clearInterval(poll)
      if (timer) clearTimeout(timer)
    })
  })

  const sections = createMemo(() => build({ groups: data.groups, sessions: data.sessions, filter }))
  const waitingCount = createMemo(() => waiting(data.sessions))

  const groupActions = {
    create: async () => {
      const name = ui.newGroup.trim()
      if (!name) return
      await client()
        ?.experimental.sessionGroup.create({ name }, { throwOnError: true })
        .then(() => setUi("newGroup", ""))
        .catch(fail)
      refresh()
    },
    rename: async (group: SessionGroup) => {
      const name = ui.draft.trim()
      setUi("renamingGroup", undefined)
      if (!name || name === group.name) return
      await client()?.experimental.sessionGroup.update({ groupID: group.id, name }, { throwOnError: true }).catch(fail)
      refresh()
    },
    recolor: async (group: SessionGroup, color: string) => {
      await client()?.experimental.sessionGroup.update({ groupID: group.id, color }, { throwOnError: true }).catch(fail)
      refresh()
    },
    toggle: async (group: SessionGroup) => {
      // Read before the optimistic write: `group` is a store proxy and sees the new value afterwards.
      const collapsed = !group.collapsed
      const groupID = group.id
      setData("groups", (item) => item.id === groupID, "collapsed", collapsed)
      await client()?.experimental.sessionGroup.update({ groupID, collapsed }, { throwOnError: true }).catch(fail)
      refresh()
    },
    remove: async (group: SessionGroup) => {
      await client()?.experimental.sessionGroup.delete({ groupID: group.id }, { throwOnError: true }).catch(fail)
      refresh()
    },
    move: async (sessionID: string, groupID: string | undefined) => {
      setData("sessions", (item) => item.id === sessionID, "groupID", groupID)
      await client()
        ?.experimental.sessionGroup.move({ sessionIDs: [sessionID], groupID }, { throwOnError: true })
        .catch(fail)
      refresh()
    },
  }

  const sessionActions = {
    open: (item: SessionOverviewItem) => {
      // An "external:" row is a tool session with no Lunos session to open (XCOD-218 ones have one).
      if (item.id.startsWith("external:")) return
      // XCOD-235: the desktop Sessions window hands it to the main window.
      if (platform.openSessionInMain) {
        void platform.openSessionInMain(item.directory, item.id).catch(fail)
        return
      }
      openSession({ sessionID: item.id, directory: item.directory, worktree: item.project?.worktree })
    },
    rename: async (item: SessionOverviewItem) => {
      const title = ui.draft.trim()
      setUi("renamingSession", undefined)
      if (!title || title === item.title) return
      await client()
        ?.session.update({ sessionID: item.id, directory: item.directory, title }, { throwOnError: true })
        .catch(fail)
      refresh()
    },
    stop: async (item: SessionOverviewItem) => {
      // XCOD-234: a Claude Code / Codex session Lunos started, stopped like `lunos external stop`;
      // a session another Lunos runs, stopped by that Lunos.
      const request = item.elsewhere
        ? client()?.experimental.peer.stop({ sessionID: item.id }, { throwOnError: true })
        : item.id.startsWith("external:")
          ? client()?.experimental.external.stop(
              { sessionID: item.id.slice("external:".length) },
              { throwOnError: true },
            )
          : client()?.session.abort({ sessionID: item.id, directory: item.directory }, { throwOnError: true })
      await request?.catch(fail)
      refresh()
    },
  }

  // XCOD-234: answering a session another Lunos runs; that Lunos checks and audits the answer.
  const peerActions = {
    load: async (item: SessionOverviewItem) => {
      if (ui.peerAsks?.sessionID === item.id) return setUi("peerAsks", undefined)
      const result = await client()
        ?.experimental.peer.asks({ sessionID: item.id }, { throwOnError: true })
        .catch((error) => void fail(error))
      if (result) setUi("peerAsks", { sessionID: item.id, asks: result.data })
    },
    after: async (item: SessionOverviewItem) => {
      setUi("responding", false)
      setUi("peerAsks", undefined)
      refresh()
      if (item.state === "waiting") await peerActions.load(item)
    },
    permission: async (item: SessionOverviewItem, requestID: string, reply: "once" | "always" | "reject") => {
      setUi("responding", true)
      await client()
        ?.experimental.peer.permissionReply({ sessionID: item.id, requestID, reply }, { throwOnError: true })
        .catch(fail)
      await peerActions.after(item)
    },
    dismiss: async (item: SessionOverviewItem, requestID: string) => {
      setUi("responding", true)
      await client()
        ?.experimental.peer.questionReject({ sessionID: item.id, requestID }, { throwOnError: true })
        .catch(fail)
      await peerActions.after(item)
    },
  }

  // XCOD-265: Stop all, Clear list, Stop all & clear, Undo, Unarchive and Delete archived, over the
  // rows in the current view, with the same counts and wording as /sessions in the TUI.
  const viewItems = createMemo(() => inView({ groups: data.groups, sessions: data.sessions, filter }))
  const t = language.t
  const list = (parts: string[]) => new Intl.ListFormat(language.intl(), { type: "unit", style: "long" }).format(parts)
  /** "4 running, 2 waiting for an answer, 1 Claude Code" */
  const breakdown = (plan: ReturnType<typeof stopPlan>) =>
    list([
      ...(plan.running ? [t("sessions.bulk.stop.running", { count: plan.running })] : []),
      ...(plan.waiting ? [t("sessions.bulk.stop.waiting", { count: plan.waiting })] : []),
      ...plan.tools.map((tool) =>
        t("sessions.bulk.stop.tool", { count: tool.count, tool: tool.name ?? t("sessions.kind.external") }),
      ),
    ])
  /** "Stopped 7 · 1 couldn't be stopped (another Lunos didn't respond)" */
  const stopSummary = (result: { stopped: string[]; failed: { id: string; reason: string }[] }) =>
    [
      t("sessions.bulk.stopped", { count: result.stopped.length }),
      ...(result.failed.length
        ? [
            t("sessions.bulk.stopFailed", {
              count: result.failed.length,
              reasons: [...new Set(result.failed.map((item) => item.reason))].join("; "),
            }),
          ]
        : []),
    ].join(" · ")
  const info = (title: string) => showToast({ title })

  let undoTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(undoTimer))
  const cleared = (ids: string[], stopped?: { summary: string; failed: boolean }) => {
    setLastClear(ids)
    clearTimeout(undoTimer)
    undoTimer = setTimeout(() => setLastClear(undefined), UNDO_MS)
    showToast({
      variant: stopped?.failed ? "error" : "success",
      title: stopped?.summary ?? t("sessions.bulk.cleared", { count: ids.length }),
      description: stopped ? t("sessions.bulk.cleared", { count: ids.length }) : undefined,
      duration: 8000,
      actions: [{ label: t("sessions.bulk.undo"), onClick: () => void bulkActions.undo() }],
    })
  }

  const bulkActions = {
    stopAll: async () => {
      const plan = stopPlan(viewItems())
      const total = plan.targets.length
      if (total === 0) return info(t("sessions.bulk.nothingToStop"))
      // The window spans every project; when the view does too, Stop all can be kept to one of them.
      const scopes =
        plan.projects.length > 1
          ? [
              { value: "", label: t("sessions.bulk.stop.allProjects", { count: total }) },
              ...plan.projects.map((project) => ({
                value: project.key,
                label: t("sessions.bulk.stop.inProject", { project: project.name, count: project.count }),
              })),
            ]
          : undefined
      const pick = (scope: string | undefined) =>
        scope ? plan.targets.filter((item) => projectKey(item) === scope) : plan.targets
      const choice = await confirm({
        title: language.plural("sessions.bulk.stop.question", total),
        lines: [
          t("sessions.bulk.stop.breakdown", { list: breakdown(plan) }),
          ...(plan.elsewhere ? [language.plural("sessions.bulk.stop.elsewhere", plan.elsewhere)] : []),
        ],
        confirm: (scope) => t("sessions.bulk.stop.confirm", { count: pick(scope).length }),
        scopes,
        scopeLabel: t("sessions.bulk.stop.scope"),
      })
      if (!choice) return
      setFailedStops({})
      const result = await client()
        ?.experimental.sessionBulk.stop(
          { sessionIDs: pick(choice.scope).map((item) => item.id) },
          { throwOnError: true },
        )
        .then((response) => response.data)
        .catch((cause) => void fail(cause))
      if (result) {
        setFailedStops(Object.fromEntries(result.failed.map((item) => [item.id, item.reason])))
        showToast({ variant: result.failed.length ? "error" : "success", title: stopSummary(result) })
      }
      refresh()
    },
    clear: async () => {
      const plan = clearPlan(viewItems())
      const running = stopPlan(plan.staying).targets.length
      if (plan.targets.length === 0 && running === 0) return info(t("sessions.bulk.nothingToClear"))
      // Nothing finished, only running ones: the one thing to offer is Stop all & clear.
      if (plan.targets.length === 0) return bulkActions.stopAndClear()
      const choice = await confirm({
        title: language.plural("sessions.bulk.clear.question", plan.targets.length),
        lines: [
          t("sessions.bulk.clear.note"),
          ...(plan.staying.length ? [language.plural("sessions.bulk.clear.staying", plan.staying.length)] : []),
        ],
        confirm: t("sessions.bulk.clear.confirm", { count: plan.targets.length }),
      })
      if (!choice) return
      const result = await client()
        ?.experimental.sessionBulk.archive({ sessionIDs: plan.targets.map((item) => item.id) }, { throwOnError: true })
        .then((response) => response.data)
        .catch((cause) => void fail(cause))
      if (result) cleared(result.archived)
      refresh()
    },
    stopAndClear: async () => {
      const items = viewItems()
      const stop = stopPlan(items)
      const clear = clearPlan(items).targets
      const total = stop.targets.length + clear.length
      if (total === 0) return info(t("sessions.bulk.nothingToStopOrClear"))
      const step1 = !stop.targets.length
        ? t("sessions.bulk.stopAndClear.step1None")
        : stop.elsewhere
          ? t("sessions.bulk.stopAndClear.step1Elsewhere", { list: breakdown(stop), count: stop.elsewhere })
          : t("sessions.bulk.stopAndClear.step1", { list: breakdown(stop) })
      const choice = await confirm({
        title: language.plural("sessions.bulk.stopAndClear.question", stop.targets.length, { total }),
        lines: [step1, t("sessions.bulk.stopAndClear.step2", { count: total })],
        confirm: t("sessions.bulk.stopAndClear.confirm", { stop: stop.targets.length, total }),
      })
      if (!choice) return
      setFailedStops({})
      const result = await client()
        ?.experimental.sessionBulk.archive(
          { sessionIDs: [...stop.targets, ...clear].map((item) => item.id), stop: true },
          { throwOnError: true },
        )
        .then((response) => response.data)
        .catch((cause) => void fail(cause))
      if (result) {
        const failed = result.failed ?? []
        setFailedStops(Object.fromEntries(failed.map((item) => [item.id, item.reason])))
        cleared(result.archived, {
          summary: stopSummary({ stopped: result.stopped ?? [], failed }),
          failed: failed.length > 0,
        })
      }
      refresh()
    },
    undo: async () => {
      const ids = lastClear()
      if (!ids) return
      setLastClear(undefined)
      const result = await client()
        ?.experimental.sessionBulk.unarchive({ sessionIDs: ids }, { throwOnError: true })
        .then((response) => response.data)
        .catch((cause) => void fail(cause))
      if (result)
        showToast({ variant: "success", title: t("sessions.bulk.restored", { count: result.archived.length }) })
      refresh()
    },
    unarchive: async (item: SessionOverviewItem) => {
      const result = await client()
        ?.experimental.sessionBulk.unarchive({ sessionIDs: [item.id] }, { throwOnError: true })
        .then((response) => response.data)
        .catch((cause) => void fail(cause))
      if (result?.archived.length)
        showToast({ variant: "success", title: t("sessions.bulk.unarchived", { title: item.title }) })
      refresh()
    },
    /** Permanent, so the count is typed back. Only rows that are archived can be reached. */
    deleteArchived: async () => {
      const items = topLevel(viewItems().filter((item) => !!item.archived))
      if (items.length === 0) return info(t("sessions.bulk.noArchived"))
      const count = items.length
      const choice = await confirm({
        title: language.plural("sessions.bulk.delete.question", count),
        lines: [
          t("sessions.bulk.delete.warning"),
          t("sessions.bulk.delete.projects", { projects: list([...new Set(items.map((item) => projectName(item)))]) }),
        ],
        confirm: t("sessions.bulk.delete.confirm", { count }),
        typed: { value: String(count), placeholder: t("sessions.bulk.delete.placeholder", { count }) },
      })
      if (!choice) return
      const result = await client()
        ?.experimental.sessionBulk.delete({ sessionIDs: items.map((item) => item.id) }, { throwOnError: true })
        .then((response) => response.data)
        .catch((cause) => void fail(cause))
      if (result)
        showToast({
          variant: "success",
          title: [
            t("sessions.bulk.deleted", { count: result.deleted.length }),
            ...(result.skipped.length ? [t("sessions.bulk.skipped", { count: result.skipped.length })] : []),
          ].join(" · "),
        })
      refresh()
    },
  }

  const stateLabel = (item: SessionOverviewItem) =>
    item.stale
      ? language.t("sessions.state.stale")
      : item.elsewhere && item.state === "running"
        ? language.t("sessions.state.elsewhere")
        : language.t(`sessions.state.${item.state}`)

  const money = (value: number) => formatMoney(value, language.intl())
  const ago = (time: number) => {
    const seconds = Math.round((time - Date.now()) / 1000)
    const format = new Intl.RelativeTimeFormat(language.intl(), { numeric: "auto" })
    const abs = Math.abs(seconds)
    if (abs < 60) return format.format(seconds, "second")
    if (abs < 3600) return format.format(Math.round(seconds / 60), "minute")
    if (abs < 86400) return format.format(Math.round(seconds / 3600), "hour")
    return format.format(Math.round(seconds / 86400), "day")
  }

  const SessionRow = (props: { item: SessionOverviewItem; child?: boolean }) => {
    const item = () => props.item
    const external = () => item().id.startsWith("external:")
    return (
      <li
        class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 hover:bg-v2-background-bg-raised"
        classList={{ "ml-6": props.child }}
        data-session-id={item().id}
        data-state={item().state}
        draggable={!props.child}
        onDragStart={(event) => {
          event.dataTransfer?.setData(DRAG_TYPE, item().id)
          event.dataTransfer?.setData("text/plain", item().title)
        }}
      >
        <span
          class="inline-block size-2 shrink-0 rounded-full"
          classList={{
            "bg-v2-state-fg-warning": item().state === "waiting",
            "bg-v2-state-fg-success": item().state === "running",
            "bg-v2-state-fg-danger": item().state === "failed",
            "bg-v2-border-border-base": item().state === "idle" || item().state === "finished",
          }}
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-1 flex-col">
          <Show
            when={ui.renamingSession === item().id}
            fallback={
              <span class="truncate text-14-medium text-v2-text-text-strong" title={item().title}>
                {item().title}
              </span>
            }
          >
            <input
              class="rounded border border-v2-border-border-base bg-transparent px-1 text-14-regular"
              aria-label={language.t("sessions.session.name")}
              value={ui.draft}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(event) => setUi("draft", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sessionActions.rename(item())
                if (event.key === "Escape") setUi("renamingSession", undefined)
              }}
              onBlur={() => void sessionActions.rename(item())}
            />
          </Show>
          <span class="truncate text-12-regular text-v2-text-text-weak">
            {[projectName(item()), item().agent, item().model, item().tool].filter(Boolean).join(" · ")}
          </span>
        </div>
        <Show when={item().kind !== "session"}>
          <span class="rounded bg-v2-background-bg-raised px-1.5 py-0.5 text-11-medium text-v2-text-text-base">
            {language.t(`sessions.kind.${item().kind as "subagent" | "scheduled" | "external"}`)}
          </span>
        </Show>
        <span
          class="text-12-medium"
          classList={{
            "text-v2-state-fg-warning": item().state === "waiting",
            "text-v2-state-fg-success": item().state === "running",
            "text-v2-state-fg-danger": item().state === "failed",
            "text-v2-text-text-weak": item().state === "idle" || item().state === "finished",
          }}
        >
          {item().archived ? t("sessions.archived.at", { time: ago(item().archived!) }) : stateLabel(item())}
        </span>
        <span class="text-12-regular text-v2-text-text-weak tabular-nums">{ago(item().updated)}</span>
        <span class="text-12-regular text-v2-text-text-weak tabular-nums">{money(item().cost)}</span>
        <Show
          when={!archivedView()}
          fallback={
            <div class="flex items-center gap-1">
              <Show when={!external()}>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-12-medium"
                  onClick={() => sessionActions.open(item())}
                >
                  {language.t("common.open")}
                </button>
              </Show>
              <Show when={item().archived && !props.child}>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-12-medium"
                  onClick={() => void bulkActions.unarchive(item())}
                >
                  {t("sessions.bulk.unarchive")}
                </button>
              </Show>
            </div>
          }
        >
          <div class="flex items-center gap-1">
            <Show when={item().state === "waiting"}>
              <button
                type="button"
                class="rounded border border-v2-state-border-warning bg-v2-state-bg-warning px-2 py-1 text-12-medium text-v2-state-fg-warning"
                onClick={() => (item().elsewhere ? void peerActions.load(item()) : sessionActions.open(item()))}
              >
                {language.t("sessions.action.answer")}
              </button>
            </Show>
            <Show when={!external()}>
              <button
                type="button"
                class="rounded px-2 py-1 text-12-medium"
                onClick={() => sessionActions.open(item())}
              >
                {language.t("common.open")}
              </button>
              <button
                type="button"
                class="rounded px-2 py-1 text-12-medium"
                onClick={() => {
                  setUi({ renamingSession: item().id, draft: item().title })
                }}
              >
                {language.t("common.rename")}
              </button>
              <Show when={item().state === "running" || item().state === "waiting"}>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-12-medium text-v2-state-fg-danger"
                  onClick={() => void sessionActions.stop(item())}
                >
                  {language.t("sessions.action.stop")}
                </button>
              </Show>
            </Show>
            <Show when={external() && item().state === "running"}>
              <button
                type="button"
                class="rounded px-2 py-1 text-12-medium text-v2-state-fg-danger"
                onClick={() => void sessionActions.stop(item())}
              >
                {language.t("sessions.action.stop")}
              </button>
            </Show>
            <Show when={!props.child}>
              <select
                class="rounded border border-v2-border-border-base bg-transparent px-1 py-1 text-12-regular"
                aria-label={language.t("sessions.action.moveTo")}
                title={language.t("sessions.action.moveTo")}
                value={item().groupID ?? UNGROUPED}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  void groupActions.move(item().id, value === UNGROUPED ? undefined : value)
                }}
              >
                <option value={UNGROUPED}>{language.t("sessions.group.ungrouped")}</option>
                <For each={data.groups}>{(group) => <option value={group.id}>{group.name}</option>}</For>
              </select>
            </Show>
          </div>
        </Show>
        <Show when={failedStops()[item().id]}>
          {(reason) => (
            <p class="w-full text-12-regular text-v2-state-fg-danger" role="status">
              {t("sessions.bulk.failed", { reason: reason() })}
            </p>
          )}
        </Show>
        <Show when={ui.peerAsks?.sessionID === item().id ? ui.peerAsks : undefined}>
          {(peer) => (
            <div class="w-full">
              <For each={peer().asks.permissions}>
                {(request) => (
                  <SessionPermissionDock
                    request={request}
                    responding={ui.responding}
                    onDecide={(reply) => void peerActions.permission(item(), request.id, reply)}
                  />
                )}
              </For>
              <For each={peer().asks.questions}>
                {(question) => (
                  <div class="flex items-center gap-2 py-1 text-12-regular">
                    <span class="flex-1 truncate">{question.questions[0]?.question}</span>
                    <button
                      type="button"
                      class="rounded px-2 py-1 text-12-medium"
                      disabled={ui.responding}
                      onClick={() => void peerActions.dismiss(item(), question.id)}
                    >
                      {language.t("common.dismiss")}
                    </button>
                  </div>
                )}
              </For>
            </div>
          )}
        </Show>
      </li>
    )
  }

  const Rows = (props: { rows: Row[] }) => (
    <ul class="flex flex-col">
      <For each={props.rows}>
        {(row) => (
          <>
            <SessionRow item={row.item} />
            <For each={row.children}>{(child) => <SessionRow item={child} child />}</For>
          </>
        )}
      </For>
    </ul>
  )

  const SectionView = (props: { section: Section }) => {
    const group = () => props.section.group
    const key = () => group()?.id ?? UNGROUPED
    const name = () => group()?.name ?? language.t("sessions.group.ungrouped")
    const collapsed = () => group()?.collapsed === true
    return (
      <section
        class="rounded-lg border border-v2-border-border-base"
        classList={{ "border-v2-state-border-info bg-v2-state-bg-info": ui.dropTarget === key() }}
        data-group-id={key()}
        aria-label={name()}
        onDragOver={(event) => {
          if (!event.dataTransfer?.types.includes(DRAG_TYPE)) return
          event.preventDefault()
          setUi("dropTarget", key())
        }}
        onDragLeave={() => setUi("dropTarget", undefined)}
        onDrop={(event) => {
          const id = event.dataTransfer?.getData(DRAG_TYPE)
          setUi("dropTarget", undefined)
          if (!id) return
          event.preventDefault()
          void groupActions.move(id, group()?.id)
        }}
      >
        <header class="flex items-center gap-2 border-b border-v2-border-border-base px-3 py-2">
          <Show when={group()}>
            {(current) => (
              <button
                type="button"
                class="rounded px-1 text-12-medium"
                aria-expanded={!collapsed()}
                aria-label={language.t(collapsed() ? "sessions.group.expand" : "sessions.group.collapse", {
                  name: name(),
                })}
                onClick={() => void groupActions.toggle(current())}
              >
                {collapsed() ? "▸" : "▾"}
              </button>
            )}
          </Show>
          <Show when={group()?.color}>
            <span class="inline-block size-3 rounded-full" style={{ background: group()!.color }} aria-hidden="true" />
          </Show>
          <Show
            when={group() && ui.renamingGroup === group()!.id}
            fallback={<h2 class="flex-1 truncate text-14-medium text-v2-text-text-strong">{name()}</h2>}
          >
            <input
              class="flex-1 rounded border border-v2-border-border-base bg-transparent px-1 text-14-regular"
              aria-label={language.t("sessions.group.name")}
              value={ui.draft}
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(event) => setUi("draft", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void groupActions.rename(group()!)
                if (event.key === "Escape") setUi("renamingGroup", undefined)
              }}
              onBlur={() => void groupActions.rename(group()!)}
            />
          </Show>
          <span class="text-12-regular text-v2-text-text-weak tabular-nums">{props.section.count}</span>
          <Show when={group()}>
            {(current) => (
              <>
                <select
                  class="rounded border border-v2-border-border-base bg-transparent px-1 py-0.5 text-12-regular"
                  aria-label={language.t("sessions.group.color")}
                  title={language.t("sessions.group.color")}
                  value={current().color ?? ""}
                  onChange={(event) => void groupActions.recolor(current(), event.currentTarget.value)}
                >
                  <option value="">{language.t("sessions.group.noColor")}</option>
                  <For each={GROUP_COLORS}>
                    {(color) => (
                      <option value={color} style={{ color }}>
                        {color}
                      </option>
                    )}
                  </For>
                </select>
                <button
                  type="button"
                  class="rounded px-2 py-0.5 text-12-medium"
                  onClick={() => setUi({ renamingGroup: current().id, draft: current().name })}
                >
                  {language.t("sessions.group.rename")}
                </button>
                <button
                  type="button"
                  class="rounded px-2 py-0.5 text-12-medium text-v2-state-fg-danger"
                  onClick={() => void groupActions.remove(current())}
                >
                  {language.t("sessions.group.delete")}
                </button>
              </>
            )}
          </Show>
        </header>
        <Show when={!collapsed()}>
          <Show
            when={props.section.rows.length > 0}
            fallback={
              <p class="px-3 py-2 text-12-regular text-v2-text-text-weak">{language.t("sessions.group.empty")}</p>
            }
          >
            <Rows rows={props.section.rows} />
          </Show>
        </Show>
      </section>
    )
  }

  return (
    <div class="flex min-h-0 w-full flex-1 flex-col overflow-auto" data-page="sessions">
      <div class="mx-auto flex w-full max-w-[1080px] flex-col gap-3 p-4">
        <header class="flex flex-wrap items-center gap-3">
          <h1 class="text-18-medium text-v2-text-text-strong">
            {archivedView() ? t("sessions.archived.title") : language.t("sessions.title")}
          </h1>
          <Show when={waitingCount() > 0}>
            <span
              class="rounded border border-v2-state-border-warning bg-v2-state-bg-warning px-2 py-0.5 text-12-medium text-v2-state-fg-warning"
              role="status"
            >
              {language.t("sessions.waiting", { count: waitingCount() })}
            </span>
          </Show>
        </header>
        <div class="flex flex-wrap items-center gap-2">
          <input
            type="search"
            class="min-w-[240px] flex-1 rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-14-regular"
            aria-label={language.t("sessions.search.label")}
            placeholder={language.t("sessions.search.placeholder")}
            value={filter.search}
            onInput={(event) => setFilter("search", event.currentTarget.value)}
          />
          <select
            class="rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-14-regular"
            aria-label={language.t("sessions.filter.state")}
            value={filter.state}
            onChange={(event) => setFilter("state", event.currentTarget.value as Filter["state"])}
          >
            <option value="all">{language.t("sessions.filter.all")}</option>
            <For each={STATE_ORDER}>
              {(state) => <option value={state}>{language.t(`sessions.state.${state}`)}</option>}
            </For>
            <option value="archived">{t("sessions.filter.archived")}</option>
          </select>
          <select
            class="rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-14-regular"
            aria-label={language.t("sessions.filter.group")}
            value={filter.group}
            onChange={(event) => setFilter("group", event.currentTarget.value)}
          >
            <option value="all">{language.t("sessions.filter.all")}</option>
            <option value={UNGROUPED}>{language.t("sessions.group.ungrouped")}</option>
            <For each={data.groups}>{(group) => <option value={group.id}>{group.name}</option>}</For>
          </select>
          <form
            class="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              void groupActions.create()
            }}
          >
            <input
              class="rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-14-regular"
              aria-label={language.t("sessions.group.name")}
              placeholder={language.t("sessions.group.new")}
              value={ui.newGroup}
              onInput={(event) => setUi("newGroup", event.currentTarget.value)}
            />
            <button type="submit" class="rounded px-2 py-1 text-14-medium">
              {language.t("sessions.group.create")}
            </button>
          </form>
        </div>
        <div class="flex flex-wrap items-center gap-2" role="toolbar" aria-label={t("sessions.title")}>
          <Show
            when={!archivedView()}
            fallback={
              <button
                type="button"
                class="rounded border border-v2-border-border-base px-2 py-1 text-14-medium text-v2-state-fg-danger"
                onClick={() => void bulkActions.deleteArchived()}
              >
                {t("sessions.bulk.deleteArchived")}
              </button>
            }
          >
            <button
              type="button"
              class="rounded border border-v2-border-border-base px-2 py-1 text-14-medium"
              onClick={() => void bulkActions.stopAll()}
            >
              {t("sessions.bulk.stopAll")}
            </button>
            <button
              type="button"
              class="rounded border border-v2-border-border-base px-2 py-1 text-14-medium"
              onClick={() => void bulkActions.clear()}
            >
              {t("sessions.bulk.clear")}
            </button>
            <button
              type="button"
              class="rounded border border-v2-border-border-base px-2 py-1 text-14-medium"
              onClick={() => void bulkActions.stopAndClear()}
            >
              {t("sessions.bulk.stopAndClear")}
            </button>
            <Show when={lastClear()}>
              <button
                type="button"
                class="rounded border border-v2-border-border-base px-2 py-1 text-14-medium"
                onClick={() => void bulkActions.undo()}
              >
                {t("sessions.bulk.undo")}
              </button>
            </Show>
          </Show>
          <button
            type="button"
            class="ml-auto rounded px-2 py-1 text-14-medium"
            onClick={() => setFilter("state", archivedView() ? "all" : "archived")}
          >
            {archivedView() ? t("sessions.bulk.backToList") : t("sessions.bulk.showArchived")}
          </button>
        </div>
        <Show when={error()}>
          <p class="text-12-regular text-v2-state-fg-danger" role="alert">
            {error()}
          </p>
        </Show>
        <For each={sections()}>{(section) => <SectionView section={section} />}</For>
        <Show when={data.loaded && sections().every((section) => section.rows.length === 0)}>
          <p class="text-14-regular text-v2-text-text-weak">
            {archivedView() ? t("sessions.archived.empty") : language.t("sessions.empty")}
          </p>
        </Show>
      </div>
    </div>
  )
}
