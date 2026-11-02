import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

/** The start of the error for a tool that doesn't exist (XCOD-167). */
export const UNKNOWN = "There is no tool named"

function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

/** The real tools nearest to a name the model made up, best first. */
export function closest(name: string, tools: readonly string[], limit = 3) {
  const wanted = name.toLowerCase()
  return tools
    .filter((tool) => tool !== "invalid")
    .map((tool) => {
      const lower = tool.toLowerCase()
      // A shared word (`search` in `memory_search`) counts as much as a near spelling.
      const shared = wanted.split(/[_\-.]/).some((part) => part.length > 2 && lower.includes(part))
      return { tool, score: distance(wanted, lower) - (shared ? 3 : 0) }
    })
    .sort((a, b) => a.score - b.score || a.tool.localeCompare(b.tool))
    .slice(0, limit)
    .map((item) => item.tool)
}

/**
 * XCOD-167: what the model is told when it calls a tool that doesn't exist. Small models given many
 * tools (an MCP server can add ~30) invent names; naming the nearest real ones lets them recover.
 */
export function unknownToolError(name: string, tools: readonly string[]) {
  const near = closest(name, tools)
  return `${UNKNOWN} "${name}".${near.length ? ` The closest are: ${near.join(", ")}.` : ""} Call one of the tools you were given.`
}

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Invalid Tool",
        output: params.error.startsWith(UNKNOWN)
          ? params.error
          : `The arguments provided to the tool are invalid: ${params.error}`,
        metadata: {},
      }),
  }),
)
