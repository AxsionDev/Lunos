import type { Registration } from "./registration.js"
export type { ToolExecuteAfter, ToolExecuteBefore } from "../effect/tool.js"
import type { ToolExecuteAfter, ToolExecuteBefore } from "../effect/tool.js"

/**
 * Runtime hooks around every tool call. A callback that throws or rejects in `execute.before`
 * aborts the tool call, which is how guard hooks work.
 */
export type ToolHooks = {
  readonly "execute.before": (callback: (input: ToolExecuteBefore) => Promise<void> | void) => Promise<Registration>
  readonly "execute.after": (callback: (input: ToolExecuteAfter) => Promise<void> | void) => Promise<Registration>
}
