// XCOD-262: the Agent Monitor. A rail on the right lists every session on this computer (the same
// `session.overview` as /sessions), and the prompt in the centre starts a new session or sends to the
// sessions it tags with `@n`. Opened by ← on an empty prompt, /monitor or the agent_monitor keybind;
// Esc or → (from an empty prompt) returns to where it was opened from.
import { TextAttributes, type KeyEvent, type Renderable, type ScrollBoxRenderable } from "@opentui/core"
import type { Binding } from "@opentui/keymap"
import { useTerminalDimensions } from "@opentui/solid"
import type { PermissionRequest, QuestionRequest, SessionOverviewItem } from "@opencode-ai/sdk/v2"
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Prompt, type PromptRef } from "../component/prompt"
import type { AutocompleteOption } from "../component/prompt/autocomplete"
import { useTuiConfig } from "../config"
import { useEvent } from "../context/event"
import { useKV } from "../context/kv"
import { useLocal } from "../context/local"
import { useAnimationsEnabled } from "../context/motion"
import { useRoute, type Route } from "../context/route"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { OPENCODE_BASE_MODE, useBindings } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSessionDelete } from "../component/session-delete"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { Toast, useToast } from "../ui/toast"
import {
  MONITOR_GROUPS_KEY,
  MONITOR_PROJECTS_KEY,
  MONITOR_VIEW_KEY,
  askText,
  build,
  elapsed,
  number,
  queuedLabel,
  route as deliveryRoute,
  tags,
  takeoverChoices,
  takeoverQuestion,
  takeoverOnlyChoices,
  canTakeOver,
  type Row,
  type Section,
} from "../util/agent-monitor"
import { forgetWaiting, toggle, type Overrides } from "../util/subagent-groups"
import { errorMessage } from "../util/error"
import { useProjectTheme } from "../component/project-section"
import { PANE_KEY, pane } from "../util/right-pane"
import { PaneChip, PaneHide } from "../component/right-pane"
import { externalAccent, type ExternalTool } from "../util/external"
import { Locale } from "../util/locale"
import { RENAME_HINT, renameFailure, renameSession, renameValue } from "../util/session"
import { loadProjectBudgets, projectBudgets } from "../util/project-budgets"
import { DialogProject, DialogProjects } from "../component/dialog-projects"
import {
  STATE_GLYPH,
  clearPlan,
  clearQuestion,
  kindLabel,
  money,
  projectName,
  stateLabel,
  stopAndClearQuestion,
  stopPlan,
  stopQuestion,
  stopSummary,
  stoppable,
  toolOnly,
  projectCounts,
  projectSections,
  sectionItems,
  type NamedProject,
  type ProjectSection,
} from "../util/sessions-overview"

/** The plugin-route id the monitor is shown under. */
export const MONITOR_ROUTE = "agent-monitor"

/** Below this width the rail is an overlay, shown with Tab. */
const NARROW = 100

// Same events as /sessions.
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

type Asks = { permissions: PermissionRequest[]; questions: QuestionRequest[] }

/** Where the monitor was opened from, to go back to. */
export function monitorReturn(params: Record<string, unknown> | undefined): Route {
  const from = params?.from as Route | undefined
  if (from?.type === "session" && typeof from.sessionID === "string")
    return { type: "session", sessionID: from.sessionID }
  return { type: "home" }
}

export function AgentMonitor(props: { params?: Record<string, unknown> }) {
  const route = useRoute()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const event = useEvent()
  const dialog = useDialog()
  const toast = useToast()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()
  const animations = useAnimationsEnabled()
  const { theme } = useTheme()
  const kv = useKV()

  const [data, setData] = createStore({
    sessions: [] as SessionOverviewItem[],
    loaded: false,
    // XCOD-309: the named projects, and the project this folder is in, for the Projects view.
    named: [] as NamedProject[],
    current: undefined as string | undefined,
  })
  const [asks, setAsks] = createStore<Record<string, Asks>>({})
  const [error, setError] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  const [focus, setFocus] = createSignal<"prompt" | "rail">("prompt")
  const [selected, setSelected] = createSignal<string>()
  const [search, setSearch] = createSignal("")
  const [showOlder, setShowOlder] = createSignal(false)
  const [numbers, setNumbers] = createSignal<ReadonlyMap<string, number>>(new Map())
  const [project, setProject] = createSignal<string>(sync.path.directory)
  const [flash, setFlash] = createSignal<ReadonlySet<string>>(new Set())
  const [preview, setPreview] = createSignal<{ sessionID: string; text: string }>()
  const [promptRef, setPromptRef] = createSignal<PromptRef>()
  let interruptNext = false

  const fail = (cause: unknown) => toast.show({ variant: "error", message: errorMessage(cause) })
  const removeSessions = useSessionDelete()
  const back = () => route.navigate(monitorReturn(props.params))
  const narrow = createMemo(() => dimensions().width < NARROW)
  // XCOD-307: the rail can be hidden on a wide terminal, and is remembered apart from the session
  // pane. Narrow, it stays the Tab overlay it was.
  const railHidden = createMemo(() => !narrow() && pane(kv.get(PANE_KEY.monitor)) === "hide")
  const toggleRail = () => {
    if (narrow()) return setFocus((value) => (value === "prompt" ? "rail" : "prompt"))
    kv.set(PANE_KEY.monitor, railHidden() ? "auto" : "hide")
  }
  createEffect(() => {
    if (railHidden()) setFocus("prompt")
  })

  // Loading, as /sessions does: one request at a time, events coalesced.
  let inflight = false
  let again = false
  let waitingBefore: Set<string> | undefined
  async function load() {
    if (inflight) {
      again = true
      return
    }
    inflight = true
    try {
      const result = await sdk.client.experimental.session.overview(undefined, { throwOnError: true })
      const sessions = result.data.sessions
      const projects = await sdk.client.experimental.projectGroup.list().catch(() => undefined)
      // A row that just turned Waiting is highlighted for a moment (not under reduced motion).
      const waiting = new Set(sessions.filter((item) => item.state === "waiting").map((item) => item.id))
      const fresh = waitingBefore ? [...waiting].filter((id) => !waitingBefore!.has(id)) : []
      waitingBefore = waiting
      batch(() => {
        setData("sessions", reconcile(sessions, { key: "id" }))
        setData("loaded", true)
        if (projects?.data) {
          setData(
            "named",
            reconcile(
              projects.data.groups.filter((group) => !group.archived),
              { key: "id" },
            ),
          )
          setData("current", projects.data.current.id)
        }
        setNow(Date.now())
        setError(undefined)
      })
      if (fresh.length && animations()) {
        setFlash(new Set(fresh))
        setTimeout(() => setFlash(new Set<string>()), 1500)
      }
      void loadAsks(sessions.filter((item) => item.state === "waiting"))
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

  /** What each Waiting row asks: from this Lunos's own lists, or the Lunos that runs it. */
  async function loadAsks(waiting: SessionOverviewItem[]) {
    const own = waiting.filter((item) => !item.elsewhere)
    const directories = [...new Set(own.map((item) => item.directory))]
    const lists = await Promise.all(
      directories.map(async (directory) => {
        const [permissions, questions] = await Promise.all([
          sdk.client.permission.list({ directory }).then((result) => result.data ?? []),
          sdk.client.question.list({ directory }).then((result) => result.data ?? []),
        ]).catch(() => [[], []] as [PermissionRequest[], QuestionRequest[]])
        return { permissions, questions }
      }),
    )
    const next: Record<string, Asks> = {}
    for (const item of own)
      next[item.id] = {
        permissions: lists.flatMap((list) => list.permissions).filter((ask) => ask.sessionID === item.id),
        questions: lists.flatMap((list) => list.questions).filter((ask) => ask.sessionID === item.id),
      }
    await Promise.all(
      waiting
        .filter((item) => item.elsewhere)
        .map(async (item) => {
          const result = await sdk.client.experimental.peer.asks({ sessionID: item.id }).catch(() => undefined)
          if (result?.data) next[item.id] = result.data as Asks
        }),
    )
    setAsks(reconcile(next))
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  function refresh() {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void load()
    }, 150)
  }
  onMount(() => void load())
  onCleanup(event.subscribe((item) => REFRESH_ON.has(item.type) && refresh()))
  // Cost and elapsed time move without events; a slow poll and a clock keep them honest.
  const poll = setInterval(refresh, 15_000)
  const clock = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => {
    clearInterval(poll)
    clearInterval(clock)
    if (timer) clearTimeout(timer)
  })

  // XCOD-299: what was opened or collapsed is kept (kv.json); a new ask opens Waiting for action again.
  const overrides = () => kv.get(MONITOR_GROUPS_KEY, {}) as Overrides
  const rail = createMemo(() =>
    build({ sessions: data.sessions, now: now(), search: search(), showOlder: showOlder(), overrides: overrides() }),
  )
  createEffect(() => {
    if (rail().reopened && kv.ready) kv.set(MONITOR_GROUPS_KEY, forgetWaiting(overrides()))
  })
  const flip = (section: Section) => {
    const view = rail().groups.find((group) => group.group === section)
    if (view) kv.set(MONITOR_GROUPS_KEY, toggle(overrides(), view))
  }
  /** Show older opens Completed too, so what it shows isn't hidden behind a collapse. */
  const toggleOlder = () => {
    const showing = !showOlder()
    setShowOlder(showing)
    if (showing && overrides().completed === false) kv.set(MONITOR_GROUPS_KEY, { ...overrides(), completed: true })
  }
  // XCOD-309: the rail by status (today's three sub-sections, the default) or by project, remembered.
  const byProject = () => kv.get(MONITOR_VIEW_KEY, "status") === "projects"
  const switchView = () => kv.set(MONITOR_VIEW_KEY, byProject() ? "status" : "projects")
  const projectCollapsed = () => kv.get(MONITOR_PROJECTS_KEY, {}) as Record<string, boolean>
  // The project of the session the monitor was opened from, else this folder's.
  const here = createMemo(() => {
    const from = monitorReturn(props.params)
    const open = from.type === "session" ? data.sessions.find((item) => item.id === from.sessionID) : undefined
    return open?.projectGroupID ?? data.current
  })
  /** The rail's rows (its filter and Show older applied), one section per project. */
  const projects = createMemo(() =>
    projectSections({
      sessions: rail().rows.map((row) => row.item),
      named: data.named,
      search: "",
      state: "all",
      here: here(),
    }).map((section) => ({
      section,
      open: section.here || !!search() || projectCollapsed()[section.key] !== true,
    })),
  )
  createEffect(
    on(
      byProject,
      (shown) =>
        shown &&
        void loadProjectBudgets(
          sdk.client,
          projects().map((view) => view.section),
        ),
    ),
  )
  const flipProject = (key: string) => {
    const view = projects().find((each) => each.section.key === key)
    if (!view || view.section.here) return
    kv.set(MONITOR_PROJECTS_KEY, { ...projectCollapsed(), [key]: view.open })
  }
  const projectOfKey = (key: string | undefined) =>
    key?.startsWith("project:") ? projects().find((view) => view.section.key === key) : undefined

  /** What ↑/↓ walk through: each sub-section's header, then its rows while it's open. */
  const headerKey = (section: Section) => `group:${section}`
  const sectionOfKey = (key: string | undefined) =>
    key?.startsWith("group:") ? (key.slice("group:".length) as Section) : undefined
  const stops = createMemo(() =>
    byProject()
      ? projects().flatMap((view) => [
          view.section.key,
          ...(view.open ? view.section.rows.flatMap((row) => [row.item.id, ...row.kids.map((kid) => kid.id)]) : []),
        ])
      : rail().groups.flatMap((view) => [
          headerKey(view.group),
          ...(view.open ? view.rows.map((row) => row.item.id) : []),
        ]),
  )
  const byID = createMemo(() => new Map(data.sessions.map((item) => [item.id, item])))
  // Numbers stick to their session while the monitor is open (see `number`).
  createEffect(
    on(rail, (value) =>
      setNumbers((previous) =>
        number(
          previous,
          value.rows.map((row) => row.item.id),
        ),
      ),
    ),
  )
  const byNumber = createMemo(() => new Map([...numbers()].map(([id, value]) => [value, id])))
  createEffect(() => {
    const rows = rail().rows
    if (rows.length === 0) return setSelected(undefined)
    if (selected() && stops().includes(selected()!)) return
    // The first row that's shown, else the first header.
    setSelected(stops().find((key) => !sectionOfKey(key) && !projectOfKey(key)) ?? stops()[0])
  })
  const current = createMemo(() => (selected() ? byID().get(selected()!) : undefined))

  // The sessions the prompt's text tags, for the preview.
  const tagged = createMemo(() => {
    const text = promptRef()?.current.input ?? ""
    return tags(text, byNumber())
      .targets.map((id) => byID().get(id))
      .filter((item) => !!item)
  })
  const previewTarget = createMemo(() => tagged()[0] ?? (focus() === "rail" ? current() : undefined))
  // XCOD-306: the selected session's project theme, as in its own session view.
  useProjectTheme(
    () => {
      const item = previewTarget()
      return item && item.kind !== "external" && !item.elsewhere ? item.id : undefined
    },
    () => previewTarget()?.directory,
  )

  // The last message of the tagged or highlighted session, so its context is seen before sending.
  createEffect(
    on(
      () => previewTarget()?.id,
      (sessionID) => {
        if (!sessionID || toolOnly({ id: sessionID })) return setPreview(undefined)
        const item = byID().get(sessionID)
        void sdk.client.session
          .messages({ sessionID, directory: item?.directory, limit: 4 })
          .then((result) => {
            const texts = (result.data ?? []).map((message) =>
              message.parts
                .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
                .join("\n")
                .trim(),
            )
            const text = texts.findLast((value) => !!value)
            if (previewTarget()?.id === sessionID) setPreview({ sessionID, text: text || "(no text yet)" })
          })
          .catch(() => setPreview(undefined))
      },
    ),
  )

  // Prompt focus follows Tab: with the rail focused nothing is typed into the prompt. A dialog
  // closing hands focus back to the prompt, so this runs again then.
  createEffect(() => {
    const ref = promptRef()
    if (!ref || dialog.stack.length > 0) return
    if (focus() === "rail") ref.blur()
    else ref.focus()
  })

  const mentions = createMemo((): AutocompleteOption[] =>
    rail()
      .rows.filter((row) => numbers().has(row.item.id) && !toolOnly(row.item))
      .map((row) => {
        const value = numbers().get(row.item.id)!
        return {
          display: `@${value} ${Locale.truncate(row.item.title, 40)}`,
          value: `@${row.item.title}`,
          aliases: [String(value), projectName(row.item)],
          description: ` session · ${projectName(row.item)} · ${stateLabel(row.item)}`,
          insert: `@${value}`,
        }
      }),
  )

  async function confirm(title: string, message: string) {
    const answer = await DialogConfirm.show(dialog, title, message)
    return answer === true
  }

  async function deliver(item: SessionOverviewItem, text: string, interrupt: boolean) {
    const where = deliveryRoute(item)
    if (where.type === "tool-only") {
      toast.show({
        variant: "info",
        message: `"${Locale.truncate(item.title, 30)}" runs in ${kindLabel(item) ?? "its tool"}: open it to send it a prompt`,
      })
      return undefined
    }
    if (where.type === "takeover") {
      const title = Locale.truncate(item.title, 40)
      // XCOD-262: prompts its Lunos queued are sent or discarded only here, as the user chooses.
      const held = item.ownerClosed ? (item.queued ?? 0) : 0
      const queued = held
        ? await choose(takeoverQuestion(title, held), takeoverChoices(held))
        : (await confirm(
              "Take over this session here?",
              `The Lunos that ran "${title}" stopped before its turn finished. Run your prompt in this Lunos instead?`,
            ))
          ? ("send" as const)
          : undefined
      if (!queued) return undefined
      return sdk.client.experimental.session
        .takeover({ sessionID: item.id, directory: item.directory, queued, text }, { throwOnError: true })
        .then((response) => ({ delivery: response.data.delivery ?? "now", position: response.data.position }))
    }
    if (where.type === "peer") {
      const result = await sdk.client.experimental.peer
        .prompt({ sessionID: item.id, text, interrupt }, { throwOnError: true })
        .then((response) => response.data)
        .catch((cause: unknown) => {
          // The other Lunos finished the turn and let the session go: it's idle, and runs here.
          if ((cause as { name?: string })?.name === "NotFoundError") return undefined
          throw cause
        })
      if (result) return result
    }
    return sdk.client.experimental.session
      .enqueue({ sessionID: item.id, directory: item.directory, text, interrupt }, { throwOnError: true })
      .then((response) => response.data)
  }

  /** The prompt with no tag starts a session; tagged, it goes to each tagged session. */
  async function submit(raw: string) {
    const interrupt = interruptNext
    interruptNext = false
    const parsed = tags(raw, byNumber())
    if (parsed.unknown.length) {
      toast.show({
        variant: "warning",
        message: `No session ${parsed.unknown.map((value) => `@${value}`).join(", ")} in the rail`,
      })
      return false
    }
    if (!parsed.text) return false
    if (parsed.targets.length === 0) return start(parsed.text)
    const targets = parsed.targets.map((id) => byID().get(id)).filter((item) => !!item)
    if (
      targets.length > 1 &&
      !(await confirm(`Send to ${targets.length} sessions?`, targets.map((item) => item.title).join(", ")))
    )
      return false
    const results = await Promise.all(
      targets.map((item) =>
        deliver(item, parsed.text, interrupt)
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
    toast.show({
      variant: "success",
      message:
        done.length === 1
          ? `${done[0]!.result!.delivery === "queued" ? "Queued for" : done[0]!.result!.delivery === "answered" ? "Answered" : "Sent to"} "${Locale.truncate(done[0]!.item.title, 40)}"`
          : `Sent to ${done.length - queued}, queued for ${queued}`,
    })
    refresh()
    return true
  }

  /** A new session in the chosen project, with the default agent and model; the monitor stays. */
  async function start(text: string) {
    const agent = local.mode.current()
    const model = local.model.current()
    if (!agent || !model) {
      toast.show({ variant: "warning", message: "Pick a model first (/models)" })
      return false
    }
    const directory = project()
    const variant = local.model.variant.current()
    const created = await sdk.client.session
      .create(
        { directory, agent: agent.name, model: { providerID: model.providerID, id: model.modelID, variant } },
        { throwOnError: true },
      )
      .catch((cause) => (fail(cause), undefined))
    if (!created?.data) return false
    // Through the monitor's own route, so the first prompt is audited with origin "monitor" too.
    await sdk.client.experimental.session
      .enqueue(
        {
          sessionID: created.data.id,
          directory,
          text,
          model: { providerID: model.providerID, modelID: model.modelID },
          ...(variant ? { variant } : {}),
        },
        { throwOnError: true },
      )
      .then(() => toast.show({ variant: "success", message: `Started a session in ${directory.split(/[\\/]/).pop()}` }))
      .catch(fail)
    refresh()
    return true
  }

  async function pickProject() {
    const directories = [sync.path.directory, ...data.sessions.map((item) => item.directory)]
    const unique = [...new Set(directories.filter(Boolean))]
    const choice = await new Promise<string | undefined>((resolve) =>
      dialog.replace(
        () => (
          <DialogSelect<string>
            title="Start new sessions in"
            current={project()}
            options={unique.map((directory) => ({
              value: directory,
              title: directory.split(/[\\/]/).filter(Boolean).pop() ?? directory,
              description: directory,
            }))}
            onSelect={(option) => {
              resolve(option.value)
              dialog.clear()
            }}
          />
        ),
        () => resolve(undefined),
      ),
    )
    if (choice) setProject(choice)
  }

  function open(item: SessionOverviewItem) {
    if (toolOnly(item)) {
      toast.show({ variant: "info", message: `Resume it with /external resume ${item.tool ?? ""}`.trim() })
      return
    }
    route.navigate({ type: "session", sessionID: item.id })
  }

  /** After answering one, the next session waiting for you is highlighted. */
  function nextWaiting(after: string) {
    const next = rail().rows.find((row) => row.section === "waiting" && row.depth === 0 && row.item.id !== after)
    if (next) setSelected(next.item.id)
  }

  /** a / d: the shown ask, through the same replies as the session view (or the Lunos that runs it). */
  async function answer(item: SessionOverviewItem, allow: boolean) {
    const pending = asks[item.id]
    const permission = pending?.permissions[0]
    const question = pending?.questions[0]
    if (!permission && !question) return
    if (!permission) {
      if (allow) {
        toast.show({ variant: "info", message: `Type the answer in the prompt, tagged @${numbers().get(item.id)}` })
        return
      }
      const request = item.elsewhere
        ? sdk.client.experimental.peer.questionReject(
            { sessionID: item.id, requestID: question!.id },
            { throwOnError: true },
          )
        : sdk.client.question.reject({ requestID: question!.id, directory: item.directory }, { throwOnError: true })
      await request.catch(fail)
      return refresh()
    }
    const reply = allow ? "once" : "reject"
    const request = item.elsewhere
      ? sdk.client.experimental.peer.permissionReply(
          { sessionID: item.id, requestID: permission.id, reply },
          { throwOnError: true },
        )
      : sdk.client.permission.reply(
          { requestID: permission.id, directory: item.directory, reply },
          { throwOnError: true },
        )
    await request
      .then(() =>
        toast.show({
          variant: allow ? "success" : "info",
          message: `${allow ? "Approved" : "Denied"}: ${Locale.truncate(askText(pending!) ?? permission.permission, 60)}`,
        }),
      )
      .then(() => nextWaiting(item.id))
      .catch(fail)
    refresh()
  }

  async function stop(item: SessionOverviewItem) {
    if (!stoppable(item)) return
    if (!(await confirm("Stop this session?", `"${Locale.truncate(item.title, 50)}" stops its current turn.`))) return
    const request = item.elsewhere
      ? sdk.client.experimental.peer.stop({ sessionID: item.id }, { throwOnError: true })
      : toolOnly(item)
        ? sdk.client.experimental.external.stop(
            { sessionID: item.id.replace(/^external:/, "") },
            { throwOnError: true },
          )
        : sdk.client.session.abort({ sessionID: item.id, directory: item.directory }, { throwOnError: true })
    await request.catch(fail)
    refresh()
  }

  /** XCOD-284: the same Delete as /sessions, for the selected row. */
  async function remove(item: SessionOverviewItem) {
    const result = await removeSessions([item])
    dialog.clear()
    if (result?.deleted.includes(item.id)) nextWaiting(item.id)
    refresh()
  }

  /**
   * XCOD-268: t on a row whose Lunos closed with prompts queued: send just those (in order, through the
   * same at-most-once take-over), or discard them, with no new prompt of its own.
   */
  async function takeOver(item: SessionOverviewItem) {
    if (!canTakeOver(item)) return
    const held = item.queued!
    const title = Locale.truncate(item.title, 40)
    const queued = await choose(
      `Take over this session here? The Lunos that ran "${title}" closed with ${held === 1 ? "1 prompt" : `${held} prompts`} queued for it, never sent. Sent, they run in this Lunos, in order.`,
      takeoverOnlyChoices(held),
    )
    if (!queued) return
    const result = await sdk.client.experimental.session
      .takeover({ sessionID: item.id, directory: item.directory, queued }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result)
      toast.show({
        variant: "success",
        message:
          queued === "send"
            ? `Took over "${title}": sending ${result.sent === 1 ? "its queued prompt" : `its ${result.sent} queued prompts`}`
            : `Took over "${title}": discarded ${result.discarded === 1 ? "its queued prompt" : `its ${result.discarded} queued prompts`}`,
      })
    refresh()
  }

  /** XCOD-265: the rows Stop all and Clear list act on: what the rail shows (filter, Show older). */
  const railView = () => {
    // XCOD-309: on a project's header (Projects view) they act on that project alone.
    const scope = projectOfKey(selected())
    if (scope) return sectionItems(scope.section)
    return rail().rows.map((row) => row.item)
  }
  /** "<project>: " before the confirmation when Stop all and Clear act on one project. */
  const scopedQuestion = (question: string) => {
    const scope = projectOfKey(selected())
    return scope ? `${scope.section.name}: ${question}` : question
  }

  /** Asks once, as /sessions does: the first option is the default and Esc cancels. */
  function choose<T extends string>(message: string, options: { value: T; title: string }[]) {
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
            onSelect={(option) => {
              resolve(option.value === "cancel" ? undefined : (option.value as T))
              dialog.clear()
            }}
          />
        ),
        () => resolve(undefined),
      ),
    )
  }

  /** XCOD-265: Stop all, with the same count-and-confirm as /sessions. */
  async function stopAll() {
    const plan = stopPlan(railView())
    if (plan.targets.length === 0)
      return toast.show({ variant: "info", message: "Nothing in the list is running or waiting." })
    const choice = await choose(scopedQuestion(stopQuestion(plan)), [
      { value: "all" as const, title: `Stop ${plan.targets.length}` },
    ])
    if (!choice) return
    const result = await sdk.client.experimental.sessionBulk
      .stop({ sessionIDs: plan.targets.map((item) => item.id) }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result) toast.show({ variant: result.failed.length ? "warning" : "success", message: stopSummary(result) })
    refresh()
  }

  /** XCOD-265: Clear list archives what isn't running or waiting; "Stop all & clear" takes the rest too. */
  async function clearList() {
    const items = railView()
    const plan = clearPlan(items)
    const running = stopPlan(plan.staying).targets.length
    if (plan.targets.length === 0 && running === 0)
      return toast.show({ variant: "info", message: "Nothing in the list to clear." })
    const choice =
      plan.targets.length === 0
        ? await choose(scopedQuestion(clearQuestion(plan)), [{ value: "stop" as const, title: "Stop all & clear" }])
        : await choose(scopedQuestion(clearQuestion(plan)), [
            { value: "clear" as const, title: `Clear ${plan.targets.length}` },
            ...(running ? [{ value: "stop" as const, title: "Stop all & clear" }] : []),
          ])
    if (!choice) return
    if (choice === "stop") {
      const stop = stopPlan(items).targets
      const go = await choose(scopedQuestion(stopAndClearQuestion(items)), [
        { value: "go" as const, title: `Stop ${stop.length} and clear ${stop.length + plan.targets.length}` },
      ])
      if (!go) return
      const result = await sdk.client.experimental.sessionBulk
        .archive({ sessionIDs: [...stop, ...plan.targets].map((item) => item.id), stop: true }, { throwOnError: true })
        .then((response) => response.data)
        .catch((cause) => (fail(cause), undefined))
      if (result)
        toast.show({
          variant: "success",
          message: `${stopSummary({ stopped: result.stopped ?? [], failed: result.failed ?? [] })} · Cleared ${result.archived.length} (/sessions → show archived brings them back)`,
          duration: 8000,
        })
      return refresh()
    }
    const result = await sdk.client.experimental.sessionBulk
      .archive({ sessionIDs: plan.targets.map((item) => item.id) }, { throwOnError: true })
      .then((response) => response.data)
      .catch((cause) => (fail(cause), undefined))
    if (result)
      toast.show({
        variant: "success",
        message: `Cleared ${result.archived.length} from the list (/sessions → show archived brings them back)`,
        duration: 8000,
      })
    refresh()
  }

  /**
   * XCOD-308: r renames the selected session, as ctrl+r does in /sessions (empty: the automatic name).
   * XCOD-325: any row: a Claude Code / Codex session gets a Lunos name; another Lunos's is renamed there.
   */
  async function rename(item: SessionOverviewItem) {
    const typed = await DialogPrompt.show(dialog, "Rename session", {
      value: item.title,
      description: () => <text fg={theme.textMuted}>{RENAME_HINT}</text>,
    })
    dialog.clear()
    const title = renameValue(typed, item.title)
    if (title === undefined) return
    await renameSession(sdk.client, item, title).catch((cause) =>
      toast.show({ variant: "error", message: `Couldn't rename: ${renameFailure(cause)}` }),
    )
    refresh()
  }

  /** XCOD-309: n on a project's header: new sessions start in that project's folder (the prompt). */
  function startIn(view: { section: ProjectSection }) {
    const directory = view.section.directory
    if (!directory) return
    setProject(directory)
    setFocus("prompt")
    toast.show({ variant: "info", message: `New sessions start in ${view.section.name}: type the first prompt` })
  }

  /** XCOD-309: p on a project's header: the project's settings (a named project's, or the projects list). */
  function settings(view: { section: ProjectSection }) {
    const section = view.section
    if (section.kind === "none") return
    if (section.kind === "named")
      return dialog.replace(() => <DialogProject id={section.id} onBack={() => dialog.clear()} />)
    dialog.replace(() => <DialogProjects select={section.id} />)
  }

  async function filter() {
    const value = await DialogPrompt.show(dialog, "Filter sessions", {
      value: search(),
      placeholder: "Title, project, state, agent or tool",
    })
    if (value !== undefined && value !== null) setSearch(value.trim())
  }

  function move(direction: 1 | -1) {
    const list = stops()
    if (rail().rows.length === 0 || list.length === 0) return
    const index = list.indexOf(selected() ?? "")
    const next = list[Math.max(0, Math.min(list.length - 1, index + direction))]!
    setSelected(next)
    const section = sectionOfKey(next)
    scroll?.scrollChildIntoView?.(
      section ? `monitor-group-${section}` : projectOfKey(next) ? `monitor-${next}` : `monitor-row-${next}`,
    )
  }

  /** What Enter does on the selected line, for the key hint. */
  const enterHint = () => {
    const project = projectOfKey(selected())
    if (project) return project.section.here ? "open" : project.open ? "collapse" : "expand"
    const section = sectionOfKey(selected())
    if (!section) return "open"
    return rail().groups.find((view) => view.group === section)?.open ? "collapse" : "expand"
  }

  /** Enter: on a sub-section's header it opens or collapses it; on a row it opens the session. */
  function enter() {
    if (projectOfKey(selected())) return flipProject(selected()!)
    const section = sectionOfKey(selected())
    if (section) return flip(section)
    if (current()) open(current()!)
  }

  // Keys. The prompt keeps everything it does today; these are the monitor's own, and none of them
  // is active while a dialog or the autocomplete is open (base mode).
  const keys = (name: string, cmd: () => void): Binding<Renderable, KeyEvent>[] =>
    tuiConfig.keybinds.get(name).map((binding) => ({ ...binding, cmd }))
  /** A binding without its ctrl+p / ctrl+n alternatives (keys are comma lists, e.g. "up,ctrl+p"). */
  const arrowsOnly = (binding: Binding<Renderable, KeyEvent>) => {
    if (typeof binding.key !== "string") return binding
    const key = binding.key
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "ctrl+p" && part !== "ctrl+n")
      .join(",")
    return key ? { ...binding, key } : undefined
  }
  /** XCOD-308: a key hint from the keybind config (its first key), empty when unbound. */
  const keyHint = (name: string) => {
    const binding = tuiConfig.keybinds.get(name)[0]
    return typeof binding?.key === "string" ? (binding.key.split(",")[0]?.trim() ?? "") : ""
  }
  // A hidden rail can't take focus; « or the pane keybind brings it back.
  const toggleFocus = () => !railHidden() && setFocus((value) => (value === "prompt" ? "rail" : "prompt"))
  const promptBindings = createMemo(() => ({
    always: [
      ...keys("monitor.focus", toggleFocus),
      ...keys("monitor.project", () => void pickProject()),
      ...keys("monitor.send_now", () => {
        interruptNext = true
        promptRef()?.submit()
      }),
    ],
    empty: keys("monitor.back", back),
  }))
  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: focus() === "rail",
    priority: 10,
    bindings: [
      ...keys("monitor.focus", toggleFocus),
      // No monitor.project here: with the rail focused, ctrl+p opens the command palette (Stop all, Clear).
      ...keys("monitor.back", back),
      // ↑/↓ only: dialog.select.prev's ctrl+p is the palette here.
      ...keys("dialog.select.prev", () => move(-1)).flatMap((binding) => arrowsOnly(binding) ?? []),
      ...keys("dialog.select.next", () => move(1)).flatMap((binding) => arrowsOnly(binding) ?? []),
      ...keys("dialog.select.submit", enter),
      ...keys("monitor.approve", () => current() && void answer(current()!, true)),
      ...keys("monitor.deny", () => current() && void answer(current()!, false)),
      ...keys("monitor.stop", () => current() && void stop(current()!)),
      ...keys("monitor.delete", () => current() && void remove(current()!)),
      ...keys("monitor.rename", () => current() && void rename(current()!)),
      ...keys("monitor.filter", () => void filter()),
      ...keys("monitor.older", toggleOlder),
      ...keys("monitor.takeover", () => current() && void takeOver(current()!)),
      // XCOD-309: the same keys as /sessions: the view switch, and n / p on a project's header.
      ...keys("dialog.sessions.view", switchView),
      ...keys("dialog.sessions.project.new", () => {
        const view = projectOfKey(selected())
        if (view) startIn(view)
      }),
      ...keys("dialog.sessions.project.settings", () => {
        const view = projectOfKey(selected())
        if (view) settings(view)
      }),
      ...keys("monitor.stop_all", () => void stopAll()),
      ...keys("monitor.clear", () => void clearList()),
    ],
  }))

  // XCOD-265: reachable from the command palette while the monitor is open (no default keys).
  useBindings(() => ({
    commands: [
      {
        namespace: "palette",
        name: "monitor.stop_all",
        title: "Stop all sessions in the Agent Monitor",
        category: "Session",
        run: () => void stopAll(),
      },
      {
        namespace: "palette",
        name: "monitor.clear",
        title: "Clear finished sessions from the Agent Monitor",
        category: "Session",
        run: () => void clearList(),
      },
      // XCOD-307: the session pane's keybind hides and shows the rail here.
      {
        namespace: "palette",
        name: "session.sidebar.toggle",
        title: railHidden() ? "Show the session list" : "Hide the session list",
        category: "Session",
        run: () => {
          toggleRail()
          dialog.clear()
        },
      },
    ],
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("monitor.pane", ["session.sidebar.toggle"]),
  }))

  let scroll: ScrollBoxRenderable | undefined

  const externalTool = (item: SessionOverviewItem): ExternalTool | undefined =>
    item.kind !== "external"
      ? undefined
      : item.tool === "codex"
        ? "codex"
        : item.tool?.startsWith("claude")
          ? "claude"
          : undefined
  function stateColor(item: SessionOverviewItem) {
    if (item.state === "waiting") return theme.warning
    if (item.state === "running") return theme.success
    if (item.state === "failed") return theme.error
    return theme.textMuted
  }

  function RailRow(rowProps: { row: Row }) {
    const item = () => rowProps.row.item
    const active = () => focus() === "rail" && selected() === item().id
    const tool = () => externalTool(item())
    const ask = () => (item().state === "waiting" && asks[item().id] ? askText(asks[item().id]!) : undefined)
    const who = () => kindLabel(item()) ?? item().agent
    return (
      <box
        id={`monitor-row-${item().id}`}
        flexDirection="column"
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={
          active() ? theme.backgroundElement : flash().has(item().id) ? theme.backgroundPanel : undefined
        }
        onMouseUp={() => {
          setSelected(item().id)
          setFocus("rail")
        }}
      >
        <box flexDirection="row" gap={1}>
          <text fg={theme.textMuted} flexShrink={0}>
            {`${rowProps.row.depth ? "  ↳" : ""}${String(numbers().get(item().id) ?? "").padStart(2)}`}
          </text>
          {/* XCOD-141: the glyph carries the state, not the colour alone (NO_COLOR keeps it). */}
          <text fg={stateColor(item())} flexShrink={0}>
            {STATE_GLYPH[item().state]}
          </text>
          <Show when={tool()}>
            <text fg={externalAccent(theme, tool()!, tuiConfig.external_accent !== false) ?? theme.text} flexShrink={0}>
              ●
            </text>
          </Show>
          <text fg={theme.text} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none" flexShrink={1}>
            {item().title}
          </text>
        </box>
        <box flexDirection="row" paddingLeft={rowProps.row.depth ? 8 : 5}>
          <text fg={theme.textMuted} wrapMode="none">
            {[
              queuedLabel(item()),
              projectName(item()),
              who(),
              item().elsewhere || item().stale ? stateLabel(item()) : undefined,
              elapsed(item().updated, now()),
              money(item().cost),
            ]
              .filter(Boolean)
              .join(" · ")}
          </text>
        </box>
        <Show when={ask()}>
          <box paddingLeft={rowProps.row.depth ? 8 : 5}>
            <text fg={theme.warning} wrapMode="none">
              {ask()}
            </text>
          </box>
        </Show>
      </box>
    )
  }

  const Rail = () => (
    <box
      flexDirection="column"
      width={narrow() ? "100%" : "40%"}
      // The centre grows into the rest; without this the rail is squeezed below its 40%.
      flexShrink={0}
      height="100%"
      border={["left"]}
      borderColor={focus() === "rail" ? theme.borderActive : theme.border}
      backgroundColor={theme.background}
    >
      {/* XCOD-307: » hides the list on a wide terminal; narrow, Tab already takes it away. */}
      <Show when={!narrow()}>
        <box paddingRight={1}>
          <PaneHide onHide={toggleRail} label="hide list" />
        </box>
      </Show>
      <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD} flexGrow={1} flexShrink={1} wrapMode="none">
          Sessions on this computer
        </text>
        {/* XCOD-265: unbound by default (monitor.stop_all, monitor.clear); click them, or use the command palette. */}
        <text fg={theme.textMuted} flexShrink={0} wrapMode="none" onMouseUp={() => void stopAll()}>
          stop all
        </text>
        <text fg={theme.textMuted} flexShrink={0}>
          {" · "}
        </text>
        <text fg={theme.textMuted} flexShrink={0} wrapMode="none" onMouseUp={() => void clearList()}>
          clear list
        </text>
        <Show when={search()}>
          <text fg={theme.accent}>filter: {search()}</text>
        </Show>
      </box>
      {/* XCOD-309: the view switch; click it, or press its key (dialog.sessions.view). */}
      <box paddingLeft={1} flexShrink={0}>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={switchView}>
          View: <span style={{ fg: byProject() ? theme.textMuted : theme.text, bold: !byProject() }}>Status</span>
          {" | "}
          <span style={{ fg: byProject() ? theme.text : theme.textMuted, bold: byProject() }}>Projects</span>
          {keyHint("dialog.sessions.view") ? ` · ${keyHint("dialog.sessions.view")}` : ""}
        </text>
      </box>
      <scrollbox
        flexGrow={1}
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
        scrollbarOptions={{ visible: false }}
        viewportCulling={true}
      >
        <Show
          when={rail().rows.length > 0}
          fallback={
            <box paddingLeft={1} paddingTop={1}>
              <text fg={theme.textMuted}>
                {error()
                  ? `Couldn't load sessions: ${error()}`
                  : !data.loaded
                    ? "Loading sessions…"
                    : search()
                      ? "No sessions match"
                      : "No sessions yet"}
              </text>
            </box>
          }
        >
          {/* XCOD-309: one section per project, its header with counts, budget and "here". */}
          <Show when={byProject()}>
            <For each={projects()}>
              {(view) => {
                const key = () => view.section.key
                const active = () => focus() === "rail" && selected() === key()
                return (
                  <box flexDirection="column" flexShrink={0}>
                    <box
                      id={`monitor-${key()}`}
                      flexDirection="row"
                      gap={1}
                      paddingLeft={1}
                      paddingTop={1}
                      flexShrink={0}
                      backgroundColor={active() ? theme.backgroundElement : undefined}
                      onMouseUp={() => {
                        setSelected(key())
                        setFocus("rail")
                        flipProject(key())
                      }}
                    >
                      <text fg={theme.text} flexShrink={0}>
                        {view.open ? "▼" : "▶"}
                      </text>
                      <text
                        fg={view.section.counts.waiting ? theme.warning : theme.text}
                        attributes={TextAttributes.BOLD}
                        wrapMode="none"
                        flexShrink={0}
                      >
                        {view.section.name}
                        {view.section.here ? " · here" : ""}
                      </text>
                      <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
                        {[projectCounts(view.section.counts), projectBudgets[view.section.id]]
                          .filter(Boolean)
                          .join(" · ")}
                      </text>
                    </box>
                    <Show when={view.open}>
                      {/* Newest first, subagents under their parent, as in /sessions. */}
                      <For
                        each={view.section.rows.flatMap((row): Row[] => [
                          { item: row.item, section: "completed", depth: 0 },
                          ...row.kids.map((kid): Row => ({ item: kid, section: "completed", depth: 1 })),
                        ])}
                      >
                        {(row) => <RailRow row={row} />}
                      </For>
                    </Show>
                  </box>
                )
              }}
            </For>
          </Show>
          {/* XCOD-299: all three, always in this order; an empty one is "(0)", dimmed and collapsed. */}
          <For each={byProject() ? [] : rail().groups}>
            {(view) => {
              const active = () => focus() === "rail" && selected() === headerKey(view.group)
              const urgent = () => view.group === "waiting" && view.count > 0
              return (
                <box flexDirection="column" flexShrink={0}>
                  <box
                    id={`monitor-group-${view.group}`}
                    flexDirection="row"
                    gap={1}
                    paddingLeft={1}
                    paddingTop={1}
                    flexShrink={0}
                    backgroundColor={active() ? theme.backgroundElement : undefined}
                    onMouseUp={() => {
                      setSelected(headerKey(view.group))
                      setFocus("rail")
                      flip(view.group)
                    }}
                  >
                    <text fg={view.empty ? theme.textMuted : theme.text} flexShrink={0}>
                      {view.open ? "▼" : "▶"}
                    </text>
                    <text
                      fg={urgent() ? theme.warning : theme.textMuted}
                      attributes={
                        view.empty ? undefined : TextAttributes.BOLD | (urgent() ? TextAttributes.UNDERLINE : 0)
                      }
                      wrapMode="none"
                    >
                      {view.title} ({view.count})
                    </text>
                    <Show when={!view.open && !view.empty}>
                      <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
                        {view.summary}
                      </text>
                    </Show>
                  </box>
                  <Show when={view.open}>
                    <For each={rail().rows.filter((row) => row.section === view.group)}>
                      {(row) => <RailRow row={row} />}
                    </For>
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
        <Show when={rail().older > 0 || showOlder()}>
          <box paddingLeft={1} paddingTop={1} flexShrink={0} onMouseUp={toggleOlder}>
            <text fg={theme.textMuted}>{showOlder() ? "Hide older" : `Show older (${rail().older})`} · o</text>
          </box>
        </Show>
      </scrollbox>
      <box paddingLeft={1} flexShrink={0}>
        {/* XCOD-308: wrapped, so every key (rename too) is seen in the narrow rail. */}
        <text fg={theme.textMuted} wrapMode="word">
          {focus() === "rail"
            ? `↑↓ move · enter ${enterHint()} · ${projectOfKey(selected()) ? `${keyHint("dialog.sessions.project.new")} new here · ${keyHint("dialog.sessions.project.settings")} settings · ` : ""}${current() && canTakeOver(current()!) ? "t take over · " : ""}a approve · d deny · s stop · ${keyHint("monitor.rename") ? `${keyHint("monitor.rename")} rename · ` : ""}x delete · / filter · ctrl+p stop all, clear · ${keyHint("dialog.sessions.view")} ${byProject() ? "status" : "projects"} · tab prompt`
            : "tab rail"}
        </text>
      </box>
    </box>
  )

  return (
    <box flexDirection="row" flexGrow={1} minHeight={0}>
      {/* Hidden, not unmounted, while the narrow rail overlay is shown: what was typed stays. */}
      <box
        visible={!narrow() || focus() === "prompt"}
        flexDirection="column"
        flexGrow={1}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Agent Monitor
          </text>
          <text fg={theme.textMuted}>
            {"  "}
            {rail().counts.waiting > 0 ? `${STATE_GLYPH.waiting} ${rail().counts.waiting} waiting · ` : ""}
            {rail().counts.working} working · esc back
          </text>
        </box>
        <box flexGrow={1} minHeight={0} paddingTop={1}>
          <Show
            when={previewTarget()}
            fallback={
              <text fg={theme.textMuted}>
                Type to start a session in {project().split(/[\\/]/).filter(Boolean).pop() ?? project()} (ctrl+p to
                change). Tag sessions with @ and their number, as in "@2 run the tests", to send to them.
              </text>
            }
          >
            {(target) => (
              <box flexDirection="column">
                <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
                  {tagged().length > 1
                    ? `To ${tagged().length} sessions: ${tagged()
                        .map((item) => `@${numbers().get(item.id)} ${item.title}`)
                        .join(", ")}`
                    : `${tagged().length ? "To" : "Highlighted"}: @${numbers().get(target().id) ?? "?"} ${target().title}`}
                </text>
                <text fg={theme.textMuted}>
                  {stateLabel(target())}
                  {queuedLabel(target()) ? ` · ${queuedLabel(target())}` : ""}
                  {target().state === "running"
                    ? " · enter queues it for when the turn ends, ctrl+enter interrupts"
                    : ""}
                </text>
                <Show when={preview()?.sessionID === target().id}>
                  <box paddingTop={1}>
                    <text fg={theme.textMuted}>{Locale.truncate(preview()!.text, 600)}</text>
                  </box>
                </Show>
              </box>
            )}
          </Show>
        </box>
        <box flexShrink={0} paddingBottom={1}>
          <Prompt
            ref={setPromptRef}
            placeholders={{ normal: ["Start a new session, or @2 to send to session 2"] }}
            onIntercept={submit}
            mentions={mentions}
            bindings={promptBindings}
          />
        </box>
        <Toast />
      </box>
      <Show when={railHidden()}>
        <PaneChip
          title="show sessions"
          count={rail().counts.waiting}
          label={rail().counts.waiting ? `${rail().counts.waiting} waiting for action` : ""}
          onOpen={toggleRail}
        />
      </Show>
      <Show when={!railHidden() && (!narrow() || focus() === "rail")}>
        <Rail />
      </Show>
    </box>
  )
}
