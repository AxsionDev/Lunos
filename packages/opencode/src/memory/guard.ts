export * as MemoryGuard from "./guard"

import path from "node:path"
import { Audit } from "@opencode-ai/core/audit"
import type { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * What memory refuses to store (XCOD-94, the spike's §5 bounds). Memory outlives the session, so
 * anything written to it is a standing instruction candidate for every later session: content an
 * outsider controls must not get in.
 *
 * - **Taint:** nothing may be remembered in a turn that has already brought in outside content: a
 *   web fetch or search, an MCP resource, or a file read outside the worktree. The check is per
 *   turn (everything since the last user message), because the model can't tell us which part of
 *   what it read a fact came from. Tool calls in the same step can't taint each other: the model
 *   writes all of a step's calls before it sees any of their results.
 * - **Secrets:** anything the audit log would mask as key-shaped, or a `{env:` / `{file:`
 *   substitution that config loading would expand.
 */

export class RefusedError extends Error {
  override name = "MemoryRefused"
}

export const TAINTING = ["webfetch", "websearch", "read_mcp_resource"] as const

export function taint(messages: readonly SessionV1.WithParts[], worktree: string): string | undefined {
  const lastUser = messages.findLastIndex((message) => message.info.role === "user")
  for (const message of messages.slice(lastUser + 1)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue
      if ((TAINTING as readonly string[]).includes(part.tool))
        return `this turn used ${part.tool}, and memory never stores content from outside sources`
      if (part.tool === "read") {
        const file = (part.state.input as { filePath?: unknown } | undefined)?.filePath
        if (typeof file === "string" && outside(file, worktree))
          return `this turn read ${file}, which is outside the project, and memory never stores content from outside it`
      }
    }
  }
}

function outside(file: string, worktree: string) {
  const relative = path.relative(worktree, path.resolve(worktree, file))
  return relative.startsWith("..") || path.isAbsolute(relative)
}

export function secret(text: string): string | undefined {
  if (/\{(env|file):/.test(text)) return "it contains a {env:} or {file:} substitution"
  if (Audit.redact(text) !== text) return "it contains something shaped like a key, token or password"
}
