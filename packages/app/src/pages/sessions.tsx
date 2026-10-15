import type { SessionGroup, SessionOverview, SessionOverviewItem } from "@opencode-ai/sdk/v2/client"
import { useNavigate } from "@solidjs/router"
import { createMemo, createSignal, For, onCleanup, onMount, Show, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection, useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useTabs } from "@/context/tabs"
import { legacySessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"
import {
  build,
  GROUP_COLORS,
  money as formatMoney,
  projectName,
  STATE_ORDER,
  UNGROUPED,
  waiting,
  type Filter,
  type Row,
  type Section,
} from "./sessions/sessions-model"

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
  "server.instance.disposed",
  "global.disposed",
  "server.connected",
])

const DRAG_TYPE = "application/x-lunos-session"

/**
 * XCOD-205: every session on this machine, across projects, in the user's groups. The same page
 * is the web UI's /sessions and the desktop app's Sessions window.
 */
export function SessionsPage() {
  const global = useGlobal()
  const server = useServer()
  const language = useLanguage()
  const settings = useSettings()
  const tabs = useTabs()
  const navigate = useNavigate()

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
  })
  const [error, setError] = createSignal<string>()

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
    try {
      const result = await sdk.experimental.session.overview()
      if (result.data) {
        setData({ groups: result.data.groups, sessions: result.data.sessions, loaded: true })
        setError(undefined)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      inflight = false
      if (again) {
        again = false
        void load()
      }
    }
  }

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
      const conn = server.current
      const current = ctx()
      // An "external:" row is a tool session with no Lunos session to open (XCOD-218 ones have one).
      if (!conn || !current || item.id.startsWith("external:")) return
      const directory = item.project?.worktree ?? item.directory
      current.projects.open(directory)
      current.projects.touch(directory)
      if (!settings.general.newLayoutDesigns()) {
        navigate(legacySessionHref(item.directory, item.id))
        return
      }
      void startTransition(() => {
        const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: item.id })
        tabs.select(tab)
      })
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
      // XCOD-234: a Claude Code / Codex session Lunos started, stopped like `lunos external stop`.
      const request = item.id.startsWith("external:")
        ? client()?.experimental.external.stop({ sessionID: item.id.slice("external:".length) }, { throwOnError: true })
        : client()?.session.abort({ sessionID: item.id, directory: item.directory }, { throwOnError: true })
      await request?.catch(fail)
      refresh()
    },
  }

  const stateLabel = (item: SessionOverviewItem) =>
    item.elsewhere ? language.t("sessions.state.elsewhere") : language.t(`sessions.state.${item.state}`)

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
          {stateLabel(item())}
        </span>
        <span class="text-12-regular text-v2-text-text-weak tabular-nums">{ago(item().updated)}</span>
        <span class="text-12-regular text-v2-text-text-weak tabular-nums">{money(item().cost)}</span>
        <div class="flex items-center gap-1">
          <Show when={item().state === "waiting"}>
            <button
              type="button"
              class="rounded border border-v2-state-border-warning bg-v2-state-bg-warning px-2 py-1 text-12-medium text-v2-state-fg-warning"
              onClick={() => sessionActions.open(item())}
            >
              {language.t("sessions.action.answer")}
            </button>
          </Show>
          <Show when={!external()}>
            <button type="button" class="rounded px-2 py-1 text-12-medium" onClick={() => sessionActions.open(item())}>
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
            <Show when={(item().state === "running" && !item().elsewhere) || item().state === "waiting"}>
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
          <h1 class="text-18-medium text-v2-text-text-strong">{language.t("sessions.title")}</h1>
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
        <Show when={error()}>
          <p class="text-12-regular text-v2-state-fg-danger" role="alert">
            {error()}
          </p>
        </Show>
        <For each={sections()}>{(section) => <SectionView section={section} />}</For>
        <Show when={data.loaded && sections().every((section) => section.rows.length === 0)}>
          <p class="text-14-regular text-v2-text-text-weak">{language.t("sessions.empty")}</p>
        </Show>
      </div>
    </div>
  )
}
