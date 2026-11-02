export * as ExternalConsent from "./consent"

import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import type { ExternalDetect } from "./detect"

/**
 * XCOD-254: whether the user agreed to share Lunos's tools, skills and memory with Claude Code or
 * Codex, per tool and per project. Kept in Lunos's state directory on this machine, never in config:
 * a project's config is often committed, and a repository must not be able to agree for its users.
 *
 * "Share" and "Never for this tool" are kept here; "Not now" is kept on the session only, so the
 * next session asks again.
 */

export type Answer = "share" | "never"

export const OPTIONS = {
  share: "Share",
  later: "Not now",
  never: "Never for this tool",
} as const

interface Entry {
  answer: Answer
  time: string
}

type Store = Record<string, Partial<Record<ExternalDetect.Tool, Entry>>>

const file = () => path.join(Global.Path.state, "external-consent.json")

/** The key a project's answers are kept under. Directories outside a git repository each get their own. */
export function project(input: { project: { id: string }; directory: string }) {
  return input.project.id === "global" ? `global:${input.directory}` : input.project.id
}

async function read(): Promise<Store> {
  const text = await fs.readFile(file(), "utf8").catch(() => undefined)
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function get(projectKey: string, tool: ExternalDetect.Tool): Promise<Answer | undefined> {
  const answer = (await read())[projectKey]?.[tool]?.answer
  return answer === "share" || answer === "never" ? answer : undefined
}

/** Saves an answer, or forgets it (`undefined`), so the next session asks again. */
export async function set(projectKey: string, tool: ExternalDetect.Tool, answer: Answer | undefined) {
  const store = await read()
  const entries = { ...store[projectKey] }
  if (answer) entries[tool] = { answer, time: new Date().toISOString() }
  else delete entries[tool]
  if (Object.keys(entries).length) store[projectKey] = entries
  else delete store[projectKey]
  await fs.mkdir(path.dirname(file()), { recursive: true })
  await fs.writeFile(file(), JSON.stringify(store, null, 2), { mode: 0o600 })
}

/** The consent question, as Lunos's question service asks it. */
export function question(label: string, vendor: string) {
  return {
    header: `Share with ${label}?`,
    question: `Share Lunos tools, skills and memory with ${label}? Their results are sent to ${vendor} with your prompts.`,
    custom: false,
    options: [
      {
        label: OPTIONS.share,
        description: `Offer Lunos's MCP servers, skills and memory to ${label} in this project. Each call asks in Lunos unless your rules allow that tool by name`,
      },
      { label: OPTIONS.later, description: `${label} runs as it does today; asked again next session` },
      {
        label: OPTIONS.never,
        description: `Don't ask again for ${label} in this project (change it in /settings → External sessions)`,
      },
    ],
  }
}

/** The answer a reply to `question` gives: "later" for Not now, or a dismissed question. */
export function parse(answers: ReadonlyArray<ReadonlyArray<string>> | undefined): Answer | "later" {
  const choice = answers?.[0]?.[0]
  if (choice === OPTIONS.share) return "share"
  if (choice === OPTIONS.never) return "never"
  return "later"
}
