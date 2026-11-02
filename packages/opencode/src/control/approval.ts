export * as ControlApproval from "./approval"

import { Effect } from "effect"
import type { Permission } from "@/permission"
import type { Tool } from "@/tool/tool"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Control } from "."

// XCOD-327 / XCOD-339: how browser and computer control ask the user. A target (a site, an app) is
// asked through the agent's own `browser` / `computer` permission, with "always" offered; a
// confirmation, a resume after Stop or a clipboard read is asked through `<kind>_confirm`, never
// remembered. Every request carries `manual: true`, so no auto-approve mode answers it, and a
// refusal writes the `<kind>.action` audit line before the tool call fails.

export type Request = {
  kind: "target" | "confirm" | "resume"
  pattern: string
  title: string
  detail: string
  always?: boolean
  ruleset: PermissionV1.Ruleset
  /** What the user is asked to allow, for the buttons ("Allow once", "Always allow …"). */
  noun?: string
}

export function asker(input: {
  permission: Permission.Interface
  ctx: Tool.Context
  kind: Control.Kind
  /** Writes the refusal's audit line. */
  refused: (request: Request) => void
}) {
  return (request: Request) =>
    input.permission
      .ask({
        permission: request.kind === "target" ? input.kind : `${input.kind}_confirm`,
        patterns: [request.pattern],
        always: request.always ? [request.pattern] : [],
        sessionID: input.ctx.sessionID,
        tool: { messageID: input.ctx.messageID, callID: input.ctx.callID ?? "" },
        ruleset: request.ruleset,
        metadata: {
          manual: true,
          // `site` for the browser's target, as before, so the TUI and app keep their wording.
          kind: request.kind === "target" ? (input.kind === "browser" ? "site" : "app") : request.kind,
          title: request.title,
          detail: request.detail,
          choices: [
            { id: "once", label: request.kind === "target" ? "Allow once" : "Yes, do it", reply: "once" },
            ...(request.always
              ? [{ id: "always", label: `Always allow ${request.noun ?? request.pattern}`, reply: "always" }]
              : []),
            { id: "deny", label: request.kind === "target" ? "Deny" : "No", reply: "reject" },
          ],
        },
      })
      .pipe(
        Effect.tapError(() => Effect.sync(() => input.refused(request))),
        Effect.orDie,
      )
}

/**
 * Targets approved "once", which holds until the user's next message. Keyed by session and agent,
 * so one agent's approval doesn't carry to another.
 */
export class Once {
  private readonly held = new Map<string, { turn: string; targets: Set<string> }>()

  has(key: string, turn: string, target: string) {
    const entry = this.held.get(key)
    return entry?.turn === turn && entry.targets.has(target)
  }

  add(key: string, turn: string, target: string) {
    const entry = this.held.get(key)
    const current = entry?.turn === turn ? entry : { turn, targets: new Set<string>() }
    current.targets.add(target)
    this.held.set(key, current)
  }
}

/** The id of the user message this tool call answers: "once" approvals last until the next one. */
export function turn(ctx: Tool.Context) {
  return ctx.messages.findLast((message) => message.info.role === "user")?.info.id ?? ctx.messageID
}
