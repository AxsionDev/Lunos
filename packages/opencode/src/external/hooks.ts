export * as ExternalHooks from "./hooks"

import type { ExternalDetect } from "./detect"

/**
 * XCOD-254: one of the tool's own calls as Lunos plugin hooks see it, so a hook written for a Lunos
 * session matches it unchanged: the tool's name becomes the Lunos tool that does the same (Claude
 * Code's `Bash` is `bash`, `Edit` is `edit`), and its arguments take Lunos's names (`file_path` is
 * `filePath`). A call with no Lunos counterpart keeps the tool's name, such as another MCP server's
 * `mcp__github__create_issue`. Hooks are told which tool it was through `external`.
 */

const NAMES: Record<ExternalDetect.Tool, Record<string, string>> = {
  claude: {
    Bash: "bash",
    Read: "read",
    Write: "write",
    Edit: "edit",
    MultiEdit: "edit",
    NotebookEdit: "edit",
    Glob: "glob",
    Grep: "grep",
    WebFetch: "webfetch",
    WebSearch: "websearch",
    TodoWrite: "todowrite",
    Task: "task",
  },
  codex: {
    Bash: "bash",
    FileChange: "apply_patch",
  },
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())

export function call(tool: ExternalDetect.Tool, name: string, input: unknown) {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {}
  const args: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [camel(key), value]),
  )
  // Codex may give a command as its argv; a hook matching `rm -rf` reads one string, as Lunos's bash takes.
  if (Array.isArray(args.command)) args.command = args.command.map(String).join(" ")
  // A Codex file change names its files in `changes`; the first is the path config hooks match on.
  if (tool === "codex" && name === "FileChange" && Array.isArray(args.changes)) {
    const files = args.changes.flatMap((change: any) => (typeof change?.path === "string" ? [change.path] : []))
    if (files.length) Object.assign(args, { filePath: files[0], files })
  }
  return { tool: NAMES[tool][name] ?? name, args }
}

/**
 * The message a tool gets when a Lunos plugin's `tool.execute.before` hook (or a config `hooks` entry)
 * refuses its call, so the tool and the user can tell it from the tool's own hooks and from a Lunos
 * permission rule ("Blocked by Lunos policy").
 */
export function refusal(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return `Refused by a Lunos plugin hook: ${message}`
}
