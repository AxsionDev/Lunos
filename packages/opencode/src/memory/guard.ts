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
 * - **Instructions to the model** (XCOD-133, OWASP ASI06): text shaped like a prompt injection
 *   ("ignore all previous instructions", role markers, tool-call syntax). Ordinary imperative
 *   guidance ("run the tests before pushing") is not: project notes are full of it.
 * - **Size:** longer than `memory.limits.max_fact_chars`.
 *
 * `check` runs the content screens (everything but taint) and is shared by `memory_remember` and
 * `lunos memory import`, so an imported fact passes exactly what an agent's write passes.
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

/**
 * Prompt-injection shapes. Deliberately narrow: a note saying "never push to main" is guidance a
 * person wrote, but "ignore all previous instructions" or a forged tool call is never a fact.
 */
const INJECTION: readonly [RegExp, string][] = [
  [
    /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(previous|prior|above|earlier|preceding|all|your|system)\b[^.\n]{0,30}?\b(instructions?|prompts?|rules|guidelines|directives|guardrails)\b/i,
    "it tells the model to ignore its instructions",
  ],
  [
    /\byou are now\b|\bfrom now on,? you (?:are|must|will)\b|\bact as (?:an? )?(?:unrestricted|jailbroken|dan)\b/i,
    "it tries to redefine who the model is",
  ],
  [/\b(?:new|updated|real|hidden) (?:system )?instructions?\s*:/i, "it announces new instructions"],
  [/^\s*(?:system|assistant|developer)\s*:/im, "it contains a chat role marker"],
  [
    /<\|(?:im_start|im_end|system|assistant|user|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>/i,
    "it contains chat-template tokens",
  ],
  [
    /<\/?(?:system|assistant|tool_call|tool_use|function_calls?|invoke|antml:[a-z_]+|memory)\b[^>]*>/i,
    "it contains tool-call or prompt markup",
  ],
  [/"(?:tool_calls|function_call|tool_use)"\s*:/, "it contains tool-call syntax"],
]

export function instructions(text: string): string | undefined {
  for (const [pattern, reason] of INJECTION) if (pattern.test(text)) return reason
}

export function size(text: string, maxChars: number): string | undefined {
  const length = text.trim().length
  if (!length) return "it is empty"
  if (length > maxChars)
    return `it is ${length} characters, over the ${maxChars} allowed (memory.limits.max_fact_chars)`
}

/** Every content screen a write must pass: size, secrets, then instruction-shaped content. */
export function check(text: string, limits: { maxFactChars: number }): string | undefined {
  return size(text, limits.maxFactChars) ?? secret(text) ?? instructions(text)
}
