export * as ConfigAgent from "./agent"

import path from "path"
import { Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { configEntryNameFromPath } from "./entry-name"
import * as ConfigMarkdown from "./markdown"
import { ConfigParse } from "./parse"

/**
 * Claude Code subagent files (`.claude/agents/*.md`) use `tools: Read, Grep, Glob` (an allow-list,
 * as a string or list) and model aliases such as `sonnet` or `inherit` (XCOD-83). Lunos's `tools`
 * is a `{ tool: boolean }` record and `model` is `provider/model`, so a copied Claude agent used
 * to make the whole config invalid. Translate the allow-list into deny-all-then-allow, and drop an
 * alias model so the agent inherits the main model instead of failing to resolve.
 */
export function fromClaudeCode(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data }
  const tools =
    typeof out.tools === "string" ? out.tools.split(/[,\s]+/) : Array.isArray(out.tools) ? out.tools : undefined
  if (tools) {
    const allowed = tools.filter((tool): tool is string => typeof tool === "string" && tool.trim() !== "")
    out.tools = {
      "*": false,
      ...Object.fromEntries(allowed.map((tool) => [tool.trim().toLowerCase(), true])),
    }
  }
  if (typeof out.model === "string" && !out.model.includes("/")) delete out.model
  // Claude Code colours are names ("cyan"); Lunos takes a hex code or a theme colour. Drop the rest.
  if (typeof out.color === "string" && !/^#[0-9a-fA-F]{6}$/.test(out.color) && !THEME_COLORS.has(out.color))
    delete out.color
  return out
}

const THEME_COLORS = new Set(["primary", "secondary", "accent", "success", "warning", "error", "info"])

/**
 * Loads `<dir>/agents/**\/*.md` the way Claude Code does. Only files whose frontmatter has a `name`
 * and a `description` are agents: READMEs and prompt fragments are skipped. A file Lunos still
 * can't use is skipped with a warning rather than making the whole config invalid, because these
 * files are written for another tool and a user can't be expected to keep them Lunos-valid.
 */
export async function loadClaude(dir: string, warn: (message: string) => void = console.warn) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("agents/**/*.md", { cwd: dir, absolute: true, dot: true, symlink: true })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue
    const data = md.data as Record<string, unknown>
    if (typeof data.name !== "string" || typeof data.description !== "string") continue
    const config = { ...fromClaudeCode(data), name: data.name, prompt: md.content.trim() }
    const decoded = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config)
    if (Exit.isFailure(decoded)) {
      warn(`Skipping Claude Code agent ${item}: not usable by Lunos`)
      continue
    }
    result[data.name] = decoded.value
  }
  return result
}

export async function load(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["agent/", "agents/"])

    const config = {
      name,
      ...fromClaudeCode(md.data),
      prompt: md.content.trim(),
    }
    result[config.name] = ConfigParse.schema(ConfigAgentV1.Info, config, item)
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, ConfigAgentV1.Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const config = {
      name: configEntryNameFromPath(path.relative(dir, item), ["mode/", "modes/"]),
      ...md.data,
      prompt: md.content.trim(),
    }
    const parsed = Schema.decodeUnknownExit(ConfigAgentV1.Info)(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = {
        ...parsed.value,
        mode: "primary" as const,
      }
    }
  }
  return result
}
