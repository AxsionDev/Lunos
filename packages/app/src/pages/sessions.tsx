import type {
  SessionGroup,
  SessionOverview,
  SessionOverviewItem,
  SessionPeerAsks as PeerAsks,
} from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { Persist, persisted } from "@/utils/persist"
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
  toolName,
  toolOnly,
  topLevel,
  UNGROUPED,
  waiting,
  type Filter,
  type Row,
  type Section,
} from "./sessions/sessions-model"
import { useBulkConfirm } from "./sessions/bulk-confirm"
import { MonitorComposer } from "./sessions/monitor-composer"
import {
  ask as askOf,
  forgetWaiting,
  number,
  orphanedQueue,
  canTakeOver,
  rail as monitorRail,
  route as deliveryRoute,
  sections as railSections,
  tags,
  toggleSection,
  type Asks,
  type RailRow,
  type SectionOverrides,
  type SectionView,
} from "./sessions/monitor-model"
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

const RAIL_VIEWS = ["status", "groups"] as const
type RailView = (typeof RAIL_VIEWS)[number]

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
    showOlder: false,
  })
  // XCOD-262: the rail by status (the Agent Monitor's sections) or by the user's groups, remembered.
  const [railPrefs, setRailPrefs] = persisted(
    Persist.global("sessions.rail"),
    // XCOD-299: and which of its sections are collapsed.
    createStore({ view: "status" as RailView, sections: {} as SectionOverrides }),
  )
  const railView = (): RailView => (RAIL_VIEWS.includes(railPrefs.view) ? railPrefs.view : "status")
  const [error, setError] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  // XCOD-262: what each Waiting row asks, shown on the row and answered there.
  const [asks, setAsks] = createStore<Record<string, Asks>>({})
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
        setNow(Date.now())
        setError(undefined)
        if (!archived) void loadAsks(result.data.sessions.filter((item) => item.state === "waiting"))
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
      // Enter, then the blur it causes: only the first saves.
      if (ui.renamingSession !== item.id) return
      // XCOD-308: one line of at most 80 characters; empty goes back to the automatic name.
      const title = ui.draft.replace(/\s+/g, " ").trim().slice(0, 80).trim()
      setUi("renamingSession", undefined)
      if (title === item.title) return
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
      // XCOD-269: prompts queued for them and never sent go with them.
      const queued = items.reduce((sum, item) => sum + (item.queued ?? 0), 0)
      const choice = await confirm({
        title: language.plural("sessions.bulk.delete.question", count),
        lines: [
          t("sessions.bulk.delete.warning"),
          t("sessions.bulk.delete.projects", { projects: list([...new Set(items.map((item) => projectName(item)))]) }),
          ...(queued ? [t("session.delete.queued", { count: queued })] : []),
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

  // XCOD-262: the Agent Monitor layout. The rail lists the sessions in view by status, numbered for
  // `@n` tags; the composer starts a session or sends to the tagged ones, through the same routes as
  // the TUI's monitor (experimental.session.enqueue, experimental.peer.prompt). A prompt never
  // answers a permission: only Approve / Deny on the row do.
  const statusRail = createMemo(() =>
    monitorRail({ sessions: viewItems(), now: now(), search: filter.search, showOlder: ui.showOlder }),
  )
  const sectionViews = createMemo(() => railSections(statusRail(), railPrefs.sections ?? {}))
  // XCOD-299: a new ask opens a collapsed Waiting for action again, and the collapse is forgotten.
  createEffect(() => {
    if (sectionViews().reopened) setRailPrefs("sections", forgetWaiting(railPrefs.sections ?? {}))
  })
  const flipSection = (view: SectionView) =>
    setRailPrefs(
      "sections",
      toggleSection(
        railPrefs.sections ?? {},
        view,
        statusRail()
          .rows.filter((row) => row.section === "waiting")
          .map((row) => row.item.id),
      ),
    )
  const [numbers, setNumbers] = createSignal<ReadonlyMap<string, number>>(new Map())
  createEffect(
    on(statusRail, (value) =>
      setNumbers((previous) =>
        number(
          previous,
          value.rows.map((row) => row.item.id),
        ),
      ),
    ),
  )
  const byNumber = createMemo(() => new Map([...numbers()].map(([id, value]) => [value, id])))
  const byID = createMemo(() => new Map(data.sessions.map((item) => [item.id, item])))
  const tagLabel = (item: SessionOverviewItem) => `@${numbers().get(item.id) ?? "?"} ${item.title}`
  const [draft, setDraft] = createSignal("")
  let composer: HTMLDivElement | undefined

  /** Where an untagged prompt starts a session: the projects in the list, most recent first. */
  const projects = createMemo(() => {
    const seen = new Map<string, string>()
    for (const item of data.sessions.toSorted((a, b) => b.updated - a.updated))
      if (!seen.has(projectKey(item))) seen.set(projectKey(item), projectName(item))
    return [...seen].map(([value, label]) => ({ value, label }))
  })
  const [chosen, setChosen] = createSignal<string>()
  const project = () => {
    const value = chosen()
    return value && projects().some((item) => item.value === value) ? value : projects()[0]?.value
  }

  /** What each Waiting row asks: from this Lunos's own lists, or the Lunos that runs it. */
  const loadAsks = async (waitingItems: SessionOverviewItem[]) => {
    const sdk = client()
    if (!sdk) return
    const own = waitingItems.filter((item) => !item.elsewhere && !toolOnly(item))
    const lists = await Promise.all(
      [...new Set(own.map((item) => item.directory))].map((directory) =>
        Promise.all([
          sdk.permission.list({ directory }).then((result) => result.data ?? []),
          sdk.question.list({ directory }).then((result) => result.data ?? []),
        ]).catch(() => [[], []] as const),
      ),
    )
    const permissions = lists.flatMap(([list]) => (Array.isArray(list) ? list : []))
    const questions = lists.flatMap(([, list]) => (Array.isArray(list) ? list : []))
    const next: Record<string, Asks> = {}
    for (const item of own)
      next[item.id] = {
        permissions: permissions.filter((request) => request.sessionID === item.id),
        questions: questions.filter((request) => request.sessionID === item.id),
      }
    await Promise.all(
      waitingItems
        .filter((item) => item.elsewhere)
        .map(async (item) => {
          const result = await sdk.experimental.peer.asks({ sessionID: item.id }).catch(() => undefined)
          const value = result?.data
          if (value && Array.isArray(value.permissions) && Array.isArray(value.questions)) next[item.id] = value
        }),
    )
    setAsks(reconcile(next))
  }

  const monitorActions = {
    /** A row's number puts its tag in the prompt. */
    tag: (item: SessionOverviewItem) => {
      const value = numbers().get(item.id)
      if (value === undefined) return
      setDraft((text) => `${text}${text && !/\s$/.test(text) ? " " : ""}@${value} `)
      composer?.querySelector("textarea")?.focus()
    },
    /** Approve / Deny on a Waiting row, through the same replies as the session view (or its Lunos). */
    answer: async (item: SessionOverviewItem, allow: boolean) => {
      const current = askOf(asks[item.id])
      const sdk = client()
      if (!current || !sdk) return
      const request =
        current.type === "question"
          ? item.elsewhere
            ? sdk.experimental.peer.questionReject(
                { sessionID: item.id, requestID: current.id },
                { throwOnError: true },
              )
            : sdk.question.reject({ requestID: current.id, directory: item.directory }, { throwOnError: true })
          : item.elsewhere
            ? sdk.experimental.peer.permissionReply(
                { sessionID: item.id, requestID: current.id, reply: allow ? "once" : "reject" },
                { throwOnError: true },
              )
            : sdk.permission.reply(
                { requestID: current.id, directory: item.directory, reply: allow ? "once" : "reject" },
                { throwOnError: true },
              )
      const ok = await request.then(
        () => true,
        (cause: unknown) => (fail(cause), false),
      )
      if (ok && current.type === "permission")
        showToast({
          variant: allow ? "success" : undefined,
          title: t(allow ? "sessions.monitor.approved" : "sessions.monitor.denied", { request: current.text }),
        })
      refresh()
    },
    deliver: async (item: SessionOverviewItem, text: string, interrupt: boolean) => {
      const sdk = client()
      const where = deliveryRoute(item)
      if (!sdk) return undefined
      if (where.type === "tool-only") {
        showToast({
          title: t("sessions.monitor.toolOnly", {
            title: item.title,
            tool: toolName(item) ?? t("sessions.kind.external"),
          }),
        })
        return undefined
      }
      if (where.type === "takeover") {
        // XCOD-262: prompts its Lunos queued are sent or discarded only here, as the user chooses.
        const held = orphanedQueue(item)
        const answer = await confirm({
          title: t("sessions.monitor.takeover.title"),
          lines: held
            ? [t("sessions.monitor.takeover.queuedBody", { title: item.title, count: held })]
            : [t("sessions.monitor.takeover.body", { title: item.title })],
          confirm: t("sessions.monitor.takeover.confirm"),
          ...(held
            ? {
                scopeLabel: t("sessions.monitor.takeover.queuedLabel"),
                scopes: [
                  { value: "send", label: t("sessions.monitor.takeover.queuedSend", { count: held }) },
                  { value: "discard", label: t("sessions.monitor.takeover.queuedDiscard", { count: held }) },
                ],
              }
            : {}),
        })
        if (!answer) return undefined
        return sdk.experimental.session
          .takeover(
            {
              sessionID: item.id,
              directory: item.directory,
              queued: answer.scope === "discard" ? "discard" : "send",
              text,
            },
            { throwOnError: true },
          )
          .then((response) => ({ delivery: response.data.delivery ?? "now", position: response.data.position }))
      }
      if (where.type === "peer") {
        const result = await sdk.experimental.peer
          .prompt({ sessionID: item.id, text, interrupt }, { throwOnError: true })
          .then((response) => response.data)
          .catch((cause: unknown) => {
            // The other Lunos finished the turn and let the session go: it's idle, and runs here.
            if ((cause as { name?: string })?.name === "NotFoundError") return undefined
            throw cause
          })
        if (result) return result
      }
      return sdk.experimental.session
        .enqueue({ sessionID: item.id, directory: item.directory, text, interrupt }, { throwOnError: true })
        .then((response) => response.data)
    },
    /**
     * XCOD-268: Take over on a row whose Lunos closed with prompts queued: send just those, in order,
     * through the same at-most-once take-over, or discard them; no new prompt is needed.
     */
    takeOver: async (item: SessionOverviewItem) => {
      const sdk = client()
      const held = orphanedQueue(item)
      if (!sdk || !canTakeOver(item)) return
      const answer = await confirm({
        title: t("sessions.monitor.takeover.title"),
        lines: [t("sessions.monitor.takeover.onlyBody", { title: item.title, count: held })],
        confirm: t("sessions.monitor.takeover.confirm"),
        scopeLabel: t("sessions.monitor.takeover.queuedLabel"),
        scopes: [
          { value: "send", label: t("sessions.monitor.takeover.sendQueued", { count: held }) },
          { value: "discard", label: t("sessions.monitor.takeover.queuedDiscard", { count: held }) },
        ],
      })
      if (!answer) return
      const queued = answer.scope === "discard" ? "discard" : "send"
      const result = await sdk.experimental.session
        .takeover({ sessionID: item.id, directory: item.directory, queued }, { throwOnError: true })
        .then((response) => response.data)
        .catch((cause: unknown) => void fail(cause))
      if (result)
        showToast({
          variant: "success",
          title:
            queued === "send"
              ? t("sessions.monitor.takeover.sent", { title: item.title, count: result.sent })
              : t("sessions.monitor.takeover.discarded", { title: item.title, count: result.discarded }),
        })
      refresh()
    },
    /** The prompt with no tag starts a session; tagged, it goes to each tagged session. */
    submit: async (raw: string, interrupt: boolean) => {
      const parsed = tags(raw, byNumber())
      if (parsed.unknown.length) {
        showToast({
          title: t("sessions.monitor.unknown", { tags: parsed.unknown.map((value) => `@${value}`).join(", ") }),
        })
        return false
      }
      if (!parsed.text) return false
      if (parsed.targets.length === 0) return monitorActions.start(parsed.text)
      const targets = parsed.targets.map((id) => byID().get(id)).filter((item): item is SessionOverviewItem => !!item)
      if (
        targets.length > 1 &&
        !(await confirm({
          title: language.plural("sessions.monitor.send.question", targets.length),
          lines: [targets.map(tagLabel).join(", ")],
          confirm: t("sessions.monitor.send"),
        }))
      )
        return false
      const results = await Promise.all(
        targets.map((item) =>
          monitorActions
            .deliver(item, parsed.text, interrupt)
            .then((result) => ({ item, result }))
            .catch((cause: unknown) => {
              fail(cause)
              return { item, result: undefined }
            }),
        ),
      )
      const done = results.filter((entry) => entry.result)
      if (done.length === 0) return false
      const queued = done.filter((entry) => entry.result!.delivery === "queued").length
      const one = done[0]!
      showToast({
        variant: "success",
        title:
          done.length > 1
            ? t("sessions.monitor.sentMany", { sent: done.length - queued, queued })
            : t(
                one.result!.delivery === "queued"
                  ? "sessions.monitor.queued"
                  : one.result!.delivery === "answered"
                    ? "sessions.monitor.answered"
                    : "sessions.monitor.sent",
                { title: one.item.title },
              ),
      })
      refresh()
      return true
    },
    /** A new session in the chosen project, with the server's default agent and model. */
    start: async (text: string) => {
      const sdk = client()
      const directory = project()
      if (!sdk || !directory) {
        showToast({ title: t("sessions.monitor.noProject") })
        return false
      }
      const created = await sdk.session
        .create({ directory }, { throwOnError: true })
        .then((response) => response.data)
        .catch((cause: unknown) => void fail(cause))
      if (!created) return false
      // Through the monitor's own route, so the first prompt is audited with origin "monitor" too.
      const sent = await sdk.experimental.session
        .enqueue({ sessionID: created.id, directory, text }, { throwOnError: true })
        .then(
          () => true,
          (cause: unknown) => (fail(cause), false),
        )
      if (sent)
        showToast({
          variant: "success",
          title: t("sessions.monitor.started", {
            project: projects().find((item) => item.value === directory)?.label ?? directory,
          }),
        })
      refresh()
      return sent
    },
    /** The last message of a session, for the composer's preview. */
    preview: async (item: SessionOverviewItem) => {
      if (toolOnly(item)) return undefined
      const result = await client()?.session.messages({ sessionID: item.id, directory: item.directory, limit: 4 })
      const texts = (result?.data ?? []).map((message) =>
        message.parts
          .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
          .join("\n")
          .trim(),
      )
      return texts.findLast((value) => !!value)
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
        {/* XCOD-262: the row's number, for `@n` tags; clicking it puts the tag in the prompt. */}
        <Show when={!archivedView() ? numbers().get(item().id) : undefined}>
          {(value) => (
            <button
              type="button"
              class="w-6 shrink-0 rounded text-left text-12-medium tabular-nums text-v2-text-text-weak"
              aria-label={t("sessions.monitor.tag", { session: tagLabel(item()) })}
              title={t("sessions.monitor.tag", { session: tagLabel(item()) })}
              onClick={() => monitorActions.tag(item())}
            >
              {value()}
            </button>
          )}
        </Show>
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
        <div class="flex min-w-0 flex-1 basis-40 flex-col">
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
              maxLength={80}
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
            {[
              item().queued
                ? t(item().ownerClosed ? "sessions.monitor.queuedOwnerClosed" : "sessions.monitor.queuedCount", {
                    count: item().queued!,
                  })
                : undefined,
              projectName(item()),
              item().agent,
              item().model,
              item().tool,
            ]
              .filter(Boolean)
              .join(" · ")}
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
            <Show when={canTakeOver(item())}>
              <button
                type="button"
                class="rounded border border-v2-border-border-base px-2 py-1 text-12-medium"
                data-action="takeover"
                onClick={() => void monitorActions.takeOver(item())}
              >
                {t("sessions.monitor.takeover.action")}
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
        <Show when={!archivedView() && item().state === "waiting" ? askOf(asks[item().id]) : undefined}>
          {(current) => (
            <div class="flex w-full flex-wrap items-center gap-2 pl-9">
              <span class="min-w-0 flex-1 truncate text-12-regular text-v2-state-fg-warning">
                {current().type === "permission"
                  ? t("sessions.monitor.ask.permission", { request: current().text })
                  : t("sessions.monitor.ask.question", { question: current().text })}
              </span>
              <Show
                when={current().type === "permission"}
                fallback={
                  <button
                    type="button"
                    class="rounded px-2 py-1 text-12-medium"
                    onClick={() => void monitorActions.answer(item(), false)}
                  >
                    {language.t("common.dismiss")}
                  </button>
                }
              >
                <button
                  type="button"
                  class="rounded border border-v2-border-border-base px-2 py-1 text-12-medium"
                  onClick={() => void monitorActions.answer(item(), true)}
                >
                  {t("sessions.monitor.approve")}
                </button>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-12-medium text-v2-state-fg-danger"
                  onClick={() => void monitorActions.answer(item(), false)}
                >
                  {t("sessions.monitor.deny")}
                </button>
              </Show>
            </div>
          )}
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

  /**
   * XCOD-262: a section of the rail by status, with its count. XCOD-299: Working, Waiting for action
   * and Completed are always there; an empty one is "(0)", dimmed and collapsed, and a collapsed one
   * says what it holds ("✕ 1 Failed · ✓ 2 Finished").
   */
  const StatusSection = (props: { view: SectionView }) => {
    const section = () => props.view.section
    const rows = createMemo(() => statusRail().rows.filter((row) => row.section === section()))
    const heading = () => t(`sessions.monitor.section.${section()}`, { count: props.view.count })
    const glyph = { running: "◐", waiting: "!", failed: "✕", finished: "✓" } as const
    const summaryID = () => `monitor-section-${section()}-summary`
    const summary = () =>
      props.view.states
        .map((entry) => `${glyph[entry.state]} ${entry.count} ${t(`sessions.state.${entry.state}`)}`)
        .join(" · ")
    return (
      <section
        class="rounded-lg border border-v2-border-border-base"
        classList={{ "opacity-60": props.view.empty }}
        data-monitor-section={section()}
        aria-label={heading()}
      >
        {/* The accordion pattern: the heading holds the button, so it stays a heading for screen readers. */}
        <header
          class="flex items-center gap-2 px-3 py-2"
          classList={{ "border-b border-v2-border-border-base": props.view.open }}
        >
          <span aria-hidden="true" class="text-12-regular text-v2-text-text-weak">
            {props.view.open ? "▼" : "▶"}
          </span>
          <h2
            class="text-14-medium"
            classList={{
              "text-v2-state-fg-warning underline": section() === "waiting" && !props.view.empty,
              "text-v2-text-text-strong": section() !== "waiting" && !props.view.empty,
              "text-v2-text-text-weak": props.view.empty,
            }}
          >
            <button
              type="button"
              class="text-left"
              aria-expanded={props.view.open}
              aria-describedby={!props.view.open && !props.view.empty ? summaryID() : undefined}
              disabled={props.view.empty}
              onClick={() => flipSection(props.view)}
            >
              {heading()}
            </button>
          </h2>
          <Show when={!props.view.open && !props.view.empty}>
            <span id={summaryID()} class="text-12-regular text-v2-text-text-weak">
              {summary()}
            </span>
          </Show>
        </header>
        <Show when={props.view.open}>
          <ul class="flex flex-col">
            <For each={rows()}>{(row: RailRow) => <SessionRow item={row.item} child={row.depth === 1} />}</For>
          </ul>
        </Show>
      </section>
    )
  }

  const byGroups = () => archivedView() || railView() === "groups"

  return (
    <div
      class="flex min-h-0 w-full flex-1 flex-col overflow-auto min-[720px]:flex-row min-[720px]:overflow-hidden"
      data-page="sessions"
    >
      {/* XCOD-262: the centre, a composer that starts sessions or sends to the ones tagged with @. */}
      <div class="flex min-h-[320px] min-w-0 flex-1 flex-col gap-3 p-4">
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
        <div class="flex min-h-0 flex-1 flex-col" ref={composer}>
          <MonitorComposer
            text={draft()}
            setText={setDraft}
            rows={statusRail().rows}
            numbers={numbers()}
            byNumber={byNumber()}
            byID={byID()}
            projects={projects()}
            project={project()}
            onProject={setChosen}
            stateLabel={stateLabel}
            preview={monitorActions.preview}
            submit={monitorActions.submit}
          />
        </div>
      </div>
      {/* The rail: every session on this computer, by status (as the TUI's monitor) or by group. */}
      <aside
        class="flex w-full flex-col gap-3 border-v2-border-border-base p-4 min-[720px]:w-[40%] min-[720px]:min-w-[340px] min-[720px]:overflow-auto min-[720px]:border-l"
        aria-label={t("sessions.monitor.rail")}
      >
        <div class="flex flex-wrap items-center gap-2">
          <input
            type="search"
            class="min-w-[200px] flex-1 rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-14-regular"
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
        <Show when={!archivedView()}>
          <div class="flex items-center gap-1" role="group" aria-label={t("sessions.monitor.view.label")}>
            <For each={RAIL_VIEWS}>
              {(view) => (
                <button
                  type="button"
                  class="rounded px-2 py-1 text-12-medium"
                  classList={{ "bg-v2-background-bg-raised text-v2-text-text-strong": railView() === view }}
                  aria-pressed={railView() === view}
                  onClick={() => setRailPrefs("view", view)}
                >
                  {t(`sessions.monitor.view.${view}`)}
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={byGroups()}>
          <form
            class="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              void groupActions.create()
            }}
          >
            <input
              class="min-w-0 flex-1 rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-14-regular"
              aria-label={language.t("sessions.group.name")}
              placeholder={language.t("sessions.group.new")}
              value={ui.newGroup}
              onInput={(event) => setUi("newGroup", event.currentTarget.value)}
            />
            <button type="submit" class="rounded px-2 py-1 text-14-medium">
              {language.t("sessions.group.create")}
            </button>
          </form>
        </Show>
        <Show when={error()}>
          <p class="text-12-regular text-v2-state-fg-danger" role="alert">
            {error()}
          </p>
        </Show>
        <Show
          when={byGroups()}
          fallback={
            <>
              <Show when={statusRail().rows.length > 0}>
                <For each={sectionViews().views}>{(view) => <StatusSection view={view} />}</For>
              </Show>
              <Show when={data.loaded && statusRail().rows.length === 0}>
                <p class="text-14-regular text-v2-text-text-weak">{language.t("sessions.empty")}</p>
              </Show>
              <Show when={statusRail().older > 0 || ui.showOlder}>
                <button
                  type="button"
                  class="self-start rounded px-2 py-1 text-12-medium text-v2-text-text-weak"
                  onClick={() => {
                    setUi("showOlder", (value) => !value)
                    // XCOD-299: what Show older adds isn't left hidden in a collapsed Completed.
                    if (ui.showOlder && railPrefs.sections?.completed === false)
                      setRailPrefs("sections", { ...railPrefs.sections, completed: true })
                  }}
                >
                  {ui.showOlder
                    ? t("sessions.monitor.hideOlder")
                    : t("sessions.monitor.showOlder", { count: statusRail().older })}
                </button>
              </Show>
            </>
          }
        >
          <For each={sections()}>{(section) => <SectionView section={section} />}</For>
          <Show when={data.loaded && sections().every((section) => section.rows.length === 0)}>
            <p class="text-14-regular text-v2-text-text-weak">
              {archivedView() ? t("sessions.archived.empty") : language.t("sessions.empty")}
            </p>
          </Show>
        </Show>
      </aside>
    </div>
  )
}
