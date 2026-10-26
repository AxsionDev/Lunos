export * as ExternalNative from "./native"

import { ConfigExternal } from "@opencode-ai/core/config/external"
import { createTwoFilesPatch } from "diff"
import path from "path"
import type { ExternalClaude } from "./claude"
import type { ExternalDetect } from "./detect"

/**
 * XCOD-285: an approval in a Claude Code or Codex session offers the tool's own choices, built from
 * what the tool sent with the request, never a list kept from memory:
 *
 *   Claude Code: "Yes"; "Yes, and don't ask again for …" only when the request carries
 *   `permission_suggestions` (named from them, applied for this session only); "No, and tell Claude
 *   what to do differently", which asks for the feedback. Without feedback the tool's turn stops.
 *   Codex: the app server's decisions for the request (accept, acceptForSession, decline, cancel).
 *
 * Each choice is carried on the Lunos request (`metadata.choices`) and answered with a Lunos reply,
 * so the audit log and Lunos rules work as for any approval. `reply` is the Lunos reply it sends;
 * `feedback` asks for the text first; `message` is sent as the refusal's text.
 */
export interface Choice {
  id: string
  label: string
  reply: "once" | "always" | "reject"
  feedback?: boolean
  message?: string
}

/** The text a Codex decline sends, so Lunos reads it as "refused, carry on" rather than "stop". */
export const DECLINED = "Declined in Lunos; carry on without it."

/** "Bash(npm test:*)": a rule as Claude Code writes it. */
function rule(value: unknown) {
  const item = value as { toolName?: unknown; ruleContent?: unknown } | undefined
  if (typeof item?.toolName !== "string") return undefined
  return typeof item.ruleContent === "string" && item.ruleContent
    ? `${item.toolName}(${item.ruleContent})`
    : item.toolName
}

/** What "don't ask again for …" names, from the tool's suggestions. Undefined when none can be named. */
export function scope(suggestions: readonly ExternalClaude.Suggestion[] | undefined) {
  const parts = (suggestions ?? []).flatMap((item): string[] => {
    if ((item.type === "addRules" || item.type === "replaceRules") && item.behavior !== "deny") {
      const rules = (Array.isArray(item.rules) ? item.rules : []).map(rule).filter((x): x is string => !!x)
      return rules
    }
    if (item.type === "setMode" && typeof item.mode === "string")
      return [item.mode === "acceptEdits" ? "edits in this session (accept edits mode)" : `${item.mode} mode`]
    if (item.type === "addDirectories" && Array.isArray(item.directories))
      return item.directories.filter((dir): dir is string => typeof dir === "string").map((dir) => `files in ${dir}`)
    return []
  })
  return parts.length ? parts.join(", ") : undefined
}

export function choices(tool: ExternalDetect.Tool, request: ExternalClaude.PermissionRequest): Choice[] {
  if (tool === "claude") {
    const named = scope(request.suggestions)
    return [
      { id: "yes", label: "Yes", reply: "once" },
      ...(named ? [{ id: "always", label: `Yes, and don't ask again for ${named}`, reply: "always" as const }] : []),
      { id: "no", label: "No, and tell Claude what to do differently", reply: "reject", feedback: true },
    ]
  }
  const offered = new Set(request.decisions ?? [])
  const all: (Choice & { decision: string })[] = [
    { decision: "accept", id: "accept", label: "Yes", reply: "once" },
    {
      decision: "acceptForSession",
      id: "acceptForSession",
      label: request.tool === "FileChange" ? "Yes, and don't ask again for these files" : "Yes, for this session",
      reply: "always",
    },
    { decision: "decline", id: "decline", label: "No, carry on without it", reply: "reject", message: DECLINED },
    { decision: "cancel", id: "cancel", label: "No, and stop", reply: "reject" },
  ]
  return all.filter((item) => offered.has(item.decision)).map(({ decision: _, ...item }) => item)
}

/**
 * The Lunos `always` patterns for "don't ask again", matched to what the tool was told to allow, so a
 * later turn (a new process of the tool) isn't asked again for the same thing. Claude Code's rule
 * `Bash(npm test:*)` is `claude:Bash npm test*`; a bare tool name is `claude:<Tool> *`. Undefined
 * leaves the default patterns.
 */
export function always(tool: ExternalDetect.Tool, suggestions: readonly ExternalClaude.Suggestion[] | undefined) {
  const patterns = (suggestions ?? []).flatMap((item) => {
    if ((item.type !== "addRules" && item.type !== "replaceRules") || item.behavior === "deny") return []
    return (Array.isArray(item.rules) ? item.rules : []).flatMap((value: unknown) => {
      const entry = value as { toolName?: unknown; ruleContent?: unknown } | undefined
      if (typeof entry?.toolName !== "string") return []
      const content = typeof entry.ruleContent === "string" && entry.ruleContent ? entry.ruleContent : "*"
      return [`${tool}:${entry.toolName} ${content.replace(/:\*$/, "*")}`]
    })
  })
  return patterns.length ? patterns : undefined
}

/** The safe permission mode a "don't ask again" switches to (its `setMode` suggestion), if any. */
export function mode(suggestions: readonly ExternalClaude.Suggestion[] | undefined, unsafe: ReadonlySet<string>) {
  const found = (suggestions ?? []).find((item) => item.type === "setMode" && typeof item.mode === "string")
  const value = found?.mode as string | undefined
  return value && /^[A-Za-z]+$/.test(value) && !unsafe.has(value) ? value : undefined
}

/** XCOD-285: Shift+Tab's cycle lives with the config's modes (ConfigExternal.cycle / next), shared with the TUI. */
export const cycle = ConfigExternal.cycle
export const next = ConfigExternal.next

/**
 * XCOD-285: what Lunos's own renderers need to show one of the tool's calls the way the tool does:
 * Claude Code's Edit and Write as a diff of the file (`diff`, `filePath`, `verb`), its TodoWrite as a
 * checklist (`todos`). Input shapes are the Agent SDK's (`FileEditInput`, `FileWriteInput`,
 * `TodoWriteInput`).
 *
 * XCOD-292: Codex's file changes as Lunos's patch view (`files`, see `codexFiles`) and its plan
 * updates as the same checklist (`todos`, see `codexPlan`). `cwd` makes the paths relative.
 * Anything else keeps the generic view: an empty object.
 */
export function render(tool: ExternalDetect.Tool, name: string, input: unknown, cwd?: string): Record<string, unknown> {
  if (!input || typeof input !== "object") return {}
  const value = input as Record<string, unknown>
  if (tool === "codex") {
    if (name === "FileChange") {
      const files = codexFiles(value.changes, cwd)
      return files.length ? { files } : {}
    }
    if (name === "Plan" && Array.isArray(value.todos)) return { todos: value.todos }
    return {}
  }
  const file = typeof value.file_path === "string" ? value.file_path : undefined
  if (name === "Edit" && file && typeof value.old_string === "string" && typeof value.new_string === "string")
    return { verb: "Edit", filePath: file, diff: createTwoFilesPatch(file, file, value.old_string, value.new_string) }
  if (name === "Write" && file && typeof value.content === "string")
    return { verb: "Write", filePath: file, diff: createTwoFilesPatch(file, file, "", value.content) }
  if (name === "TodoWrite" && Array.isArray(value.todos))
    return {
      todos: value.todos.flatMap((item: any) =>
        typeof item?.content === "string" && typeof item?.status === "string"
          ? [{ content: item.content, status: item.status }]
          : [],
      ),
    }
  return {}
}

/** One file of Lunos's patch view (the TUI's `parseApplyPatchFiles` needs every field). */
export interface PatchFile {
  type: "add" | "update" | "delete" | "move"
  filePath: string
  relativePath: string
  patch: string
  deletions: number
  movePath?: string
}

const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n").length : 0)

/**
 * XCOD-292: a Codex `fileChange` item's `changes` (`FileUpdateChange`: `path`, `kind`, `diff`, in the
 * 0.160.1 app-server schema) as Lunos's patch view shows them. The kinds are the schema's
 * `PatchChangeKind`: `add` carries the new file's content (recorded, codex-app-server.jsonl) and is
 * shown as a diff from nothing; `update` carries a diff, shown as is (with file headers added when it
 * has none), as a move when it has a `move_path`; `delete` shows how many lines went. A change of a
 * kind the schema doesn't list is left out, so the view never claims what Codex didn't say.
 */
export function codexFiles(changes: unknown, cwd?: string): PatchFile[] {
  if (!Array.isArray(changes)) return []
  // Relative to the session's directory when inside it; any other path is shown whole.
  const relative = (file: string) => {
    if (!cwd || !path.isAbsolute(file)) return file
    const name = path.relative(cwd, file)
    return name && !name.startsWith("..") && !path.isAbsolute(name) ? name : file
  }
  return changes.flatMap((change: any): PatchFile[] => {
    const file = typeof change?.path === "string" ? change.path : undefined
    const diff = typeof change?.diff === "string" ? change.diff : ""
    const kind = change?.kind?.type
    if (!file) return []
    if (kind === "add") {
      const name = relative(file)
      return [
        {
          type: "add",
          filePath: file,
          relativePath: name,
          patch: createTwoFilesPatch(name, name, "", diff),
          deletions: 0,
        },
      ]
    }
    if (kind === "delete")
      return [{ type: "delete", filePath: file, relativePath: relative(file), patch: diff, deletions: lines(diff) }]
    if (kind === "update") {
      const moved =
        typeof change.kind.move_path === "string" && change.kind.move_path ? change.kind.move_path : undefined
      const name = relative(moved ?? file)
      const patch = /^(---|diff |Index:)/m.test(diff) ? diff : `--- ${relative(file)}\n+++ ${name}\n${diff}`
      const deletions = diff
        .split("\n")
        .filter((line: string) => line.startsWith("-") && !line.startsWith("---")).length
      return [
        {
          type: moved ? "move" : "update",
          filePath: file,
          relativePath: name,
          patch,
          deletions,
          ...(moved ? { movePath: moved } : {}),
        },
      ]
    }
    return []
  })
}

/** XCOD-292: a plan step's status (the schema's `TurnPlanStepStatus`) as Lunos's checklist names it. */
export const PLAN_STATUS: Record<string, string> = {
  pending: "pending",
  inProgress: "in_progress",
  completed: "completed",
}

/**
 * XCOD-292: Codex's `turn/plan/updated` (`plan: [{ step, status }]`, `explanation`) as the input of a
 * checklist: `todos` in Lunos's shape, and the explanation only when Codex gives one. A step with a
 * status the schema doesn't list is left out. Undefined when nothing can be shown.
 */
export function codexPlan(params: any) {
  const plan: unknown[] = Array.isArray(params?.plan) ? params.plan : []
  const todos = plan.flatMap((item: any) =>
    typeof item?.step === "string" && PLAN_STATUS[item.status]
      ? [{ content: item.step, status: PLAN_STATUS[item.status] }]
      : [],
  )
  if (!todos.length) return undefined
  const explanation =
    typeof params.explanation === "string" && params.explanation.trim() ? params.explanation : undefined
  return { todos, ...(explanation ? { explanation } : {}) }
}

/**
 * XCOD-292: a Codex `collabAgentToolCall` item (one agent asking another: `tool`, `prompt`, `model`,
 * `receiverThreadIds`, `agentsStates`) as the input of Lunos's agent view. Fields Codex leaves null
 * are left out, so the view shows only what it reported.
 */
export function codexAgentCall(item: any) {
  const receivers = Array.isArray(item?.receiverThreadIds)
    ? item.receiverThreadIds.filter((id: unknown): id is string => typeof id === "string")
    : []
  return {
    kind: "call",
    tool: String(item?.tool ?? ""),
    ...(typeof item?.prompt === "string" && item.prompt ? { prompt: item.prompt } : {}),
    ...(typeof item?.model === "string" && item.model ? { model: item.model } : {}),
    ...(receivers.length ? { receivers } : {}),
  }
}

/** XCOD-292: the agents' last known state (`agentsStates`: thread id → `{ status, message }`). */
export function codexAgentStates(item: any) {
  const states = item?.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : {}
  return Object.entries(states as Record<string, any>).flatMap(([id, state]) =>
    typeof state?.status === "string"
      ? [
          {
            id,
            status: state.status,
            ...(typeof state.message === "string" && state.message ? { message: state.message } : {}),
          },
        ]
      : [],
  )
}

/** XCOD-292: a `subAgentActivity` item (`agentPath`, `agentThreadId`, `kind`) as the agent view's input. */
export function codexAgentActivity(item: any) {
  if (typeof item?.kind !== "string") return undefined
  return {
    kind: "activity",
    activity: item.kind,
    ...(typeof item.agentPath === "string" && item.agentPath ? { agent: item.agentPath } : {}),
    ...(typeof item.agentThreadId === "string" ? { thread: item.agentThreadId } : {}),
  }
}
