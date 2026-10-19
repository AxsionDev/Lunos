import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AuditLog } from "@/audit/log"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context } from "effect"
import os from "os"
import path from "path"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { ConfigPolicy } from "@/config/policy"

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

function match(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]) {
  return rulesets
    .flat()
    .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return match(permission, pattern, ...rulesets) ?? { action: "ask", permission, pattern: "*" }
}

const TRUNCATED = path.join(TRUNCATION_DIR, "*")

/**
 * XCOD-202: the managed rules for locked permissions. Every agent may read truncated tool output
 * (agent.ts), so that allow follows them unless the policy names the directory itself.
 */
function lockedRules() {
  const config = ConfigPolicy.lockedPermission() as ConfigPermissionV1.Info
  const rules = fromConfig(config)
  if (!rules.some((rule) => rule.permission === "external_directory")) return rules
  const own = config.external_directory
  if (typeof own === "object" && TRUNCATED in own) return rules
  return [...rules, ...fromConfig({ external_directory: { [TRUNCATED]: "allow" } })]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      const locked = lockedRules()
      let needsAsk = false

      for (const pattern of request.patterns) {
        // XCOD-202: the organisation's locked rule outranks any wildcard or agent rule in config,
        // but never lifts a deny: a lock can't loosen what Lunos itself restricts. The user's own
        // "always allow" (held in memory for this project until restart) still answers a locked
        // "ask"; it never reaches config.
        const base = evaluate(request.permission, pattern, ruleset, approved)
        const lockedRule = match(request.permission, pattern, locked)
        const allowed = match(request.permission, pattern, approved)
        const rule =
          base.action === "deny" ? base : lockedRule?.action === "deny" ? lockedRule : (allowed ?? lockedRule ?? base)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          AuditLog.emit("permission.decision", {
            session: request.sessionID,
            permission: request.permission,
            patterns: request.patterns,
            decision: "denied by rule",
          })
          return yield* new PermissionV1.DeniedError({
            ruleset: [...ruleset, ...locked].filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      AuditLog.emit("permission.decision", {
        session: info.sessionID,
        permission: info.permission,
        patterns: info.patterns,
        decision: "asked",
      })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.sync(() => {
          pending.delete(id)
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      AuditLog.emit("permission.decision", {
        session: existing.info.sessionID,
        permission: existing.info.permission,
        patterns: existing.info.patterns,
        decision: input.reply === "reject" ? "denied" : input.reply === "always" ? "allowed always" : "allowed once",
      })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

/** Permissions whose patterns are filesystem paths. */
const PATH_PERMISSIONS = ["external_directory", "read", "edit"]

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    // XCOD-149: a path rule written with a Windows 8.3 short name also gets its long form, so it matches
    // expanded request paths. The rule as written stays, for callers that still pass the short form.
    const path = PATH_PERMISSIONS.includes(key)
    ruleset.push(
      ...Object.entries(value).flatMap(([pattern, action]) => {
        const written = expand(pattern)
        const long = path ? FSUtil.canonicalPattern(written) : written
        const rule = { permission: key, pattern: written, action }
        return long === written ? [rule] : [rule, { ...rule, pattern: long }]
      }),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  const memory = ["memory_remember", "memory_search"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool)
        ? "edit"
        : reads.includes(tool)
          ? "read"
          : memory.includes(tool)
            ? "memory"
            : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Permission from "."
