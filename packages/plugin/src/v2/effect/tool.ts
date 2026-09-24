import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"

export interface ToolExecuteBefore {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  /** Mutable: later hooks and the tool itself see the updated arguments. */
  args: any
}

export interface ToolExecuteAfter {
  readonly tool: string
  readonly sessionID: string
  readonly callID: string
  readonly args: any
  /** Mutable: later hooks and the model see the updated result. */
  output: { title: string; output: string; metadata: any }
}

/**
 * Runtime hooks around every tool call. Unlike other domains, a callback here may fail:
 * a failing `execute.before` hook aborts the tool call, which is how guard hooks work.
 */
export type ToolHooks = {
  readonly "execute.before": (
    callback: (input: ToolExecuteBefore) => Effect.Effect<void, unknown> | void,
  ) => Effect.Effect<Registration, never, Scope.Scope>
  readonly "execute.after": (
    callback: (input: ToolExecuteAfter) => Effect.Effect<void, unknown> | void,
  ) => Effect.Effect<Registration, never, Scope.Scope>
}
