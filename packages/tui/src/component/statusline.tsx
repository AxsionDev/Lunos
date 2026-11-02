// XCOD-335: the status line's fields, from what this TUI already knows, and the line itself. Used by
// the prompt footer and by /settings › Appearance › Status line's preview, so the two always match.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { useLocal } from "../context/local"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { useTuiPaths } from "../context/runtime"
import { useOptionalLocation } from "../context/location"
import { useSandbox } from "../context/sandbox"
import { useTuiConfig } from "../config"
import { useBudget } from "./budget-meter"
import { Locale } from "../util/locale"
import { workflowsLabel } from "../util/workflows"
import { subagentsOf } from "../util/subagent-avatar"
import {
  createScriptRunner,
  needsGitStatus,
  parseGitStatus,
  render,
  run,
  source,
  type Config,
  type Fields,
  type Format,
  type Segment,
  type Tone,
} from "../util/statusline"

/** Saved from /settings, so the line changes at once rather than after a restart. */
const [saved, setSaved] = createSignal<{ config: Config | undefined }>()
export const setStatuslineConfig = (config: Config | undefined) => setSaved({ config })

/** A newer Lunos is available (app.tsx hears it); `{update}` shows its version. */
const [available, setAvailable] = createSignal<string>()
export const setStatuslineUpdate = setAvailable

export function useStatuslineConfig() {
  const tuiConfig = useTuiConfig()
  return () => {
    const live = saved()
    return live ? live.config : tuiConfig.statusline
  }
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const FORMAT: Format = {
  money: (value, currency) =>
    currency && currency !== "USD"
      ? new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value)
      : money.format(value),
  number: (value) => Locale.number(value),
}

const MAX_NEST = 3
const GIT_INTERVAL_MS = 5000

/** Everything a status line can show, for one session (or none, on home). */
export function useStatuslineFields(input: {
  sessionID: Accessor<string | undefined>
  external?: Accessor<boolean>
  git?: Accessor<boolean>
}): Accessor<Fields> {
  const local = useLocal()
  const sync = useSync()
  const paths = useTuiPaths()
  const location = useOptionalLocation()
  const sandbox = useSandbox()
  const dimensions = useTerminalDimensions()
  const budget = useBudget(input.sessionID)
  const directory = () => location()?.directory ?? paths.cwd

  // `git status` only while the line shows dirty/ahead/behind, never on the render path.
  const [git, setGit] = createSignal<ReturnType<typeof parseGitStatus>>()
  createEffect(() => {
    if (!input.git?.()) return setGit(undefined)
    const cwd = directory()
    const refresh = () =>
      void run(["git", "status", "--porcelain=v2", "--branch"], { cwd, timeout: 1000 }).then((result) => {
        if (result.ok) setGit(parseGitStatus(result.output))
      })
    refresh()
    const timer = setInterval(refresh, GIT_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const context = createMemo(() => {
    const id = input.sessionID()
    if (!id) return
    const last = (sync.data.message[id] ?? []).findLast(
      (item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0,
    )
    if (!last) return
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return
    const limit = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]?.limit.context
    return { tokens, pct: limit ? Math.round((tokens / limit) * 100) : undefined }
  })

  const subagents = createMemo(() => {
    const root = input.sessionID()
    if (!root) return
    const seen = new Set([root])
    const states: string[] = []
    const walk = (id: string, depth: number) => {
      const parts = (sync.data.message[id] ?? []).flatMap((message) => sync.data.part[message.id] ?? [])
      const entries = subagentsOf(parts, (child) => ({
        status: sync.data.session_status?.[child]?.type,
        waiting: (sync.data.permission[child]?.length ?? 0) > 0 || (sync.data.question[child]?.length ?? 0) > 0,
        queued: (sync.session.get(child)?.metadata?.subagent as { queued?: unknown } | undefined)?.queued === true,
      }))
      for (const entry of entries) {
        if (seen.has(entry.id)) continue
        seen.add(entry.id)
        states.push(entry.state)
        if (depth < MAX_NEST) walk(entry.id, depth + 1)
      }
    }
    walk(root, 1)
    if (!states.length) return
    return {
      running: states.filter((state) => state === "running" || state === "queued").length,
      waiting: states.filter((state) => state === "waiting").length,
      done: states.filter((state) => state === "done" || state === "failed").length,
    }
  })

  const today = createMemo(() => {
    const midnight = new Date().setHours(0, 0, 0, 0)
    return sync.data.session
      .filter((session) => !session.parentID && session.time.updated >= midnight)
      .reduce((sum, session) => sum + (session.cost ?? 0), 0)
  })

  return createMemo((): Fields => {
    const id = input.sessionID()
    const session = id ? sync.session.get(id) : undefined
    const external = input.external?.() ?? false
    const agent = local.mode.current()
    const approval = external ? undefined : local.approval.current()
    const parsed = local.model.parsed()
    const meter = budget()
    const item = meter?.budgets.toSorted((a, b) => b.percent - a.percent)[0]
    const lsp = sync.data.lsp
    const mcp = Object.values(sync.data.mcp)
    const fromGit = git()
    return {
      session_id: id,
      directory: directory(),
      workflow: external || !agent ? undefined : Locale.titlecase(agent.name),
      approval: approval ? (approval.mode === "auto" ? "Auto" : "Manual") : undefined,
      model: parsed.model,
      provider: parsed.provider,
      variant: local.model.variant.current() ?? undefined,
      project: meter?.project.name,
      branch: fromGit?.branch ?? sync.data.vcs?.branch,
      dirty: fromGit?.dirty,
      ahead: fromGit?.ahead,
      behind: fromGit?.behind,
      context_tokens: context()?.tokens,
      context_pct: context()?.pct,
      cost_session: session?.cost || undefined,
      cost_today: today() || undefined,
      budget: meter?.line || undefined,
      budget_left: item?.remaining,
      budget_pct: item ? Math.round(item.percent) : undefined,
      budget_currency: item?.currency,
      workflows: external
        ? undefined
        : workflowsLabel({
            agent: agent?.name,
            mode: agent?.mode,
            config: sync.data.config as Parameters<typeof workflowsLabel>[0]["config"],
            metadata: session?.metadata as Record<string, unknown> | undefined,
            child: !!session?.parentID,
            narrow: dimensions().width < 120,
          }),
      subagents_running: subagents()?.running,
      subagents_waiting: subagents()?.waiting,
      subagents_done: subagents()?.done,
      sandbox: sandbox.state()?.status,
      lsp: !lsp.length
        ? undefined
        : lsp.some((server) => server.status === "error")
          ? "error"
          : lsp.some((server) => server.status === "starting")
            ? "starting"
            : "ok",
      mcp: !mcp.length
        ? undefined
        : mcp.some((server) => server.status !== "connected" && server.status !== "disabled")
          ? "error"
          : "ok",
      version: InstallationVersion,
      update: available(),
    }
  })
}

/** One runner per script and folder, shared by the footer and the preview, so each runs it once. */
const runners = new Map<
  string,
  { runner: ReturnType<typeof createScriptRunner>; line: Accessor<string | undefined>; users: number }
>()

function useScript(command: Accessor<string | undefined>, cwd: Accessor<string>, fields: Accessor<Fields>) {
  const [line, setLine] = createSignal<string>()
  createEffect(() => {
    const cmd = command()
    if (!cmd) return setLine(undefined)
    const key = `${cwd()}\0${cmd}`
    const shared =
      runners.get(key) ??
      (() => {
        const [current, setCurrent] = createSignal<string>()
        const created = {
          runner: createScriptRunner({ command: cmd, cwd: cwd(), onLine: setCurrent }),
          line: current,
          users: 0,
        }
        runners.set(key, created)
        return created
      })()
    shared.users += 1
    createEffect(() => setLine(shared.line()))
    // Every change of what Lunos knows is offered to the script; the runner throttles it.
    createEffect(
      on(
        () => JSON.stringify(fields()),
        (json) => shared.runner.update(json),
      ),
    )
    onCleanup(() => {
      shared.users -= 1
      if (shared.users > 0) return
      shared.runner.dispose()
      runners.delete(key)
    })
  })
  return line
}

/**
 * The line for a session: segments to draw, and whether it's the Default preset (which, as
 * before, only shows once the session has usage). `config` overrides the saved settings (the preview).
 */
export function useStatusline(input: {
  sessionID: Accessor<string | undefined>
  external?: Accessor<boolean>
  config?: Accessor<Config | undefined>
}) {
  const configured = useStatuslineConfig()
  const config = () => (input.config ? input.config() : configured())
  const from = createMemo(() => source(config()))
  // Before a script's first good line, the line its preset would show.
  const fallback = createMemo(() => source({ ...config(), command: undefined }))
  const fields = useStatuslineFields({
    sessionID: input.sessionID,
    external: input.external,
    git: () => {
      const current = from()
      return current.kind !== "command" && needsGitStatus(current.template)
    },
  })
  const paths = useTuiPaths()
  const location = useOptionalLocation()
  const script = useScript(
    () => {
      const current = from()
      return current.kind === "command" ? current.command : undefined
    },
    () => location()?.directory ?? paths.cwd,
    fields,
  )
  const isDefault = createMemo(() => {
    const current = from()
    return current.kind === "preset" && current.preset === "default"
  })
  const segments = createMemo((): Segment[] => {
    const current = from()
    if (current.kind === "command") {
      const line = script()
      if (line !== undefined) return line ? [{ text: line, tone: "text" }] : []
      const back = fallback()
      return render(back.kind === "command" ? "" : back.template, fields(), { format: FORMAT, muted: isDefault() })
    }
    return render(current.template, fields(), { format: FORMAT, muted: isDefault() })
  })
  return { segments, fields, isDefault, kind: () => from().kind }
}

/** The line, in theme colours; `accent` (a Claude Code / Codex session's) takes the place of text. */
export function StatuslineView(props: { segments: Segment[]; accent?: RGBA }) {
  const { theme } = useTheme()
  const color = (tone: Tone) =>
    tone === "warning"
      ? theme.warning
      : tone === "error"
        ? theme.error
        : tone === "muted"
          ? theme.textMuted
          : (props.accent ?? theme.text)
  return (
    <Show when={props.segments.length}>
      <text wrapMode="none" flexShrink={1} minWidth={0}>
        <For each={props.segments}>{(segment) => <span style={{ fg: color(segment.tone) }}>{segment.text}</span>}</For>
      </text>
    </Show>
  )
}
