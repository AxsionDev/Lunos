export * as ExternalBridgeTools from "./bridge-tools"

import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit } from "effect"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { ConfigExternal } from "@opencode-ai/core/config/external"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Residency } from "@opencode-ai/core/residency"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { AuditLog } from "@/audit/log"
import type { EffectBridge } from "@/effect/bridge"
import type { MCP } from "@/mcp"
import type { Memory } from "@/memory"
import { MemoryGuard } from "@/memory/guard"
import { MemoryRecall } from "@/memory/recall"
import type { MemoryModel } from "@/memory/model"
import { Permission } from "@/permission"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import type { Plugin } from "@/plugin"
import type { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import type { Skill } from "@/skill"
import type { Agent } from "@/agent/agent"
import { ExternalBridge } from "./bridge"
import type { ExternalDetect } from "./detect"
import type { ExternalConsent } from "./consent"

/**
 * XCOD-254: what the Lunos bridge offers one external session, and how it runs a call. Every call
 * takes the path a native tool call takes in `session/tools.ts`: `tool.execute.before` hooks, a
 * `tool.run` audit entry, Lunos's permission service with the session's rules, the call, then
 * `tool.execute.after`. The list is built fresh on every request, so a server installed from
 * /marketplace mid-session is offered on the tool's next list, and one the residency policy or a
 * deny rule refuses is neither listed nor callable.
 */

type McpConfig = Record<string, { type?: string; url?: string } | unknown>

export interface Input {
  tool: ExternalDetect.Tool
  sessionID: SessionID
  agent: string
  agentInfo?: Agent.Info
  ruleset: PermissionV1.Ruleset
  config: Parameters<typeof AuditLog.residency>[0] & {
    external?: ConfigExternal.Info
    mcp?: McpConfig
    model?: string
    small_model?: string
  }
  worktree: string
  /** Writes of the tool's own events still queued, so the memory guard sees this turn's tool calls. */
  settle: () => Promise<unknown>
  /** Approvals in flight, so stopping the turn refuses them. */
  pending: Set<PermissionV1.ID>
  run: EffectBridge.Shape
  sessions: Session.Interface
  permission: Permission.Interface
  mcp: MCP.Interface
  plugin: Plugin.Interface
  memory: Memory.Interface
  skill: Skill.Interface
}

/** Why a configured MCP server isn't offered under the residency policy, if it isn't. */
export function mcpRefused(name: string, config: Input["config"]): string | undefined {
  const entry = config.mcp?.[name] as { type?: string; url?: string } | undefined
  // A local server runs on this machine; only a remote one sends data somewhere.
  if (!entry || entry.type !== "remote") return undefined
  const resolved = AuditLog.residency(config)
  if (!resolved || resolved.enforce === false) return undefined
  const decision = Residency.evaluate(`mcp:${name}`, resolved.policy, entry.url)
  return decision.allowed ? undefined : decision.reason
}

/**
 * What a call through the bridge is judged by: the session's rules, except that an allow which only
 * comes from a catch-all (`"*": "allow"`, the default) asks instead. What a call returns goes on to
 * Anthropic or OpenAI, so it runs without asking only where a rule names it (or the user chose
 * "always" for it). Deny and ask rules are kept as they are.
 */
export function askUnlessNamed(
  ruleset: PermissionV1.Ruleset,
  permission: string,
  patterns: readonly string[],
): PermissionV1.Ruleset {
  const named = patterns.every((pattern) => {
    const rule = ruleset.findLast(
      (item) => Wildcard.match(permission, item.permission) && Wildcard.match(pattern, item.pattern),
    )
    return rule && (rule.action !== "allow" || rule.permission !== "*")
  })
  return named ? ruleset : [...ruleset, { permission, pattern: "*", action: "ask" }]
}

/**
 * What the bridge would offer `tool` here, from config alone (no MCP server is started): for
 * `lunos external list`. The servers are those configured and enabled that the residency policy
 * allows; a session's own line also drops servers that aren't connected or that a rule denies.
 */
export function preview(input: {
  tool: ExternalDetect.Tool
  config: Input["config"]
  skills: number
  memory: boolean
  consent: ExternalConsent.Answer | undefined
  /** Claude Code's --help lists --mcp-config (undefined: not checked). */
  mcpConfig?: boolean
  /** Why the tool can't be started at all (external.enabled, the residency policy). */
  refused?: string
}): ExternalBridge.Status {
  const off = (reason: string) => ({ servers: 0, skills: 0, memory: false, off: reason })
  if (input.refused) return off(input.refused)
  const share = ConfigExternal.share(input.config.external)
  if (!share.mcp && !share.skills && !share.memory) return off("turned off in external.share")
  if (input.tool === "claude" && input.mcpConfig === false) return off("needs a Claude Code with --mcp-config")
  if (input.consent === "never") return off("never for this tool in this project")
  const servers = share.mcp
    ? Object.entries(input.config.mcp ?? {}).filter(([name, entry]) => {
        const item = entry as { type?: string; enabled?: boolean }
        return (
          (item.type === "local" || item.type === "remote") && item.enabled !== false && !mcpRefused(name, input.config)
        )
      }).length
    : 0
  const status = {
    servers,
    skills: share.skills ? input.skills : 0,
    memory: share.memory && input.memory && !!memoryParent(input.config),
  }
  if (!input.consent) return { ...status, off: "not shared yet: asked in the first session" }
  return status
}

/** The model memory starts with when it has to (the session's own model is the tool's, not Lunos's). */
function memoryParent(config: Input["config"]): MemoryModel.Model | undefined {
  const spec = config.small_model ?? config.model
  if (!spec?.includes("/")) return undefined
  const [providerID, ...rest] = spec.split("/")
  return { providerID: providerID!, modelID: rest.join("/") }
}

type Target =
  | { kind: "mcp"; key: string; server: string; tool: string; client: MCP.McpTool["client"]; timeout?: number }
  | { kind: "skill_list" }
  | { kind: "skill_load" }
  | { kind: "memory_search"; parent: MemoryModel.Model }
  | { kind: "memory_remember"; parent: MemoryModel.Model; scopes: string[] }

const text = (value: string): ExternalBridge.Content => ({ type: "text", text: value })
const refusal = (message: string): ExternalBridge.CallResult => ({ content: [text(message)], isError: true })

export function make(input: Input) {
  const share = ConfigExternal.share(input.config.external)

  const catalog = Effect.fnUntraced(function* () {
    const targets = new Map<string, Target & { def: ExternalBridge.ToolDef }>()
    const add = (target: Target, def: ExternalBridge.ToolDef) => targets.set(def.name, { ...target, def })
    let servers = new Set<string>()
    let skills = 0
    let memory = false

    if (share.mcp) {
      const clients = Object.entries(yield* input.mcp.clients())
      const tools = yield* input.mcp.tools()
      const hidden = Permission.disabled(Object.keys(tools), input.ruleset)
      for (const [key, entry] of Object.entries(tools)) {
        const server = clients.find(([, client]) => client === entry.client)?.[0]
        if (!server || hidden.has(key) || mcpRefused(server, input.config)) continue
        servers.add(server)
        add(
          { kind: "mcp", key, server, tool: entry.def.name, client: entry.client, timeout: entry.timeout },
          {
            name: ExternalBridge.mcpName(server, entry.def.name),
            description: `From Lunos's MCP server "${server}". ${entry.def.description ?? ""}`.trim(),
            inputSchema: { ...(entry.def.inputSchema as Record<string, unknown>), type: "object" },
          },
        )
      }
    }

    if (share.skills && !Permission.disabled(["skill"], input.ruleset).has("skill")) {
      skills = (yield* input.skill.available(input.agentInfo)).length
      if (skills) {
        add(
          { kind: "skill_list" },
          {
            name: "lunos_skill_list",
            description:
              "List the skills Lunos has for this project: specialised instructions to load with lunos_skill_load when a task matches one.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        )
        add(
          { kind: "skill_load" },
          {
            name: "lunos_skill_load",
            description:
              "Load one of Lunos's skills by name (from lunos_skill_list): its instructions and the files that come with it.",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string", description: "The skill's name, as lunos_skill_list gives it" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
        )
      }
    }

    // As in a Lunos session: only while memory is on for this session, and never for a database the
    // policy refuses before connecting.
    const parent = memoryParent(input.config)
    if (share.memory && parent && (yield* input.memory.decision(input.sessionID)).on) {
      const target = yield* input.memory.target()
      const hidden = Permission.disabled(["memory_remember", "memory_search"], input.ruleset)
      if (target && !target.refused) {
        if (!hidden.has("memory_search")) {
          memory = true
          add(
            { kind: "memory_search", parent },
            {
              name: "lunos_memory_search",
              description:
                "Search Lunos memory: durable facts about this project and the user that earlier sessions kept.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "What to look up" },
                  history: { type: "boolean", description: "Also show outdated facts, marked as such" },
                },
                required: ["query"],
                additionalProperties: false,
              },
            },
          )
        }
        if (!hidden.has("memory_remember") && !target.readOnly) {
          memory = true
          const scopes = yield* input.memory.scopes()
          add(
            { kind: "memory_remember", parent, scopes },
            {
              name: "lunos_memory_remember",
              description:
                "Ask to keep one durable fact in Lunos memory. The user approves it in Lunos; facts from web pages, MCP servers or files outside the project are refused.",
              inputSchema: {
                type: "object",
                properties: {
                  fact: { type: "string", description: "One durable fact, in a sentence or short paragraph" },
                  source: {
                    type: "string",
                    description: 'Where it came from: "user message", or the project-relative path of a file',
                  },
                  kind: { type: "string", enum: ["observed", "inferred"] },
                  ...(scopes.length > 1 ? { scope: { type: "string", enum: scopes } } : {}),
                },
                required: ["fact", "source"],
                additionalProperties: false,
              },
            },
          )
        }
      }
    }
    return { targets, status: { servers: servers.size, skills, memory } }
  })

  /** Asks in Lunos, as the session's own tool calls do. Undefined when allowed, else why not. */
  const ask = (request: Omit<PermissionV1.AskInput, "sessionID" | "ruleset" | "id">) =>
    Effect.gen(function* () {
      const id = PermissionV1.ID.ascending()
      input.pending.add(id)
      const exit = yield* Effect.exit(
        input.permission.ask({
          ...request,
          id,
          sessionID: input.sessionID,
          ruleset: askUnlessNamed(input.ruleset, request.permission, request.patterns),
        }),
      )
      input.pending.delete(id)
      if (Exit.isSuccess(exit)) return undefined
      const error = Cause.squash(exit.cause)
      if (error instanceof PermissionV1.CorrectedError) return `Refused in Lunos: ${error.feedback}`
      if (error instanceof PermissionV1.RejectedError) return "The user refused this in Lunos."
      return "Refused by a Lunos permission rule."
    })

  const hooks = (name: string, args: Record<string, unknown>, callID: string) => ({
    before: input.plugin.trigger(
      "tool.execute.before",
      { tool: name, sessionID: input.sessionID, agent: input.agent, callID },
      { args },
    ),
    after: (output: unknown) =>
      input.plugin.trigger(
        "tool.execute.after",
        { tool: name, sessionID: input.sessionID, agent: input.agent, callID, args },
        output,
      ),
  })

  const callMcp = Effect.fnUntraced(function* (
    target: Extract<Target, { kind: "mcp" }>,
    args: Record<string, unknown>,
    callID: string,
  ) {
    // The policy may have changed since the list: checked again.
    const residency = mcpRefused(target.server, input.config)
    if (residency) return refusal(`Not available under the data-residency policy. ${residency}`)
    const hook = hooks(target.key, args, callID)
    yield* hook.before
    AuditLog.toolRun({ tool: target.key, agent: input.agent, session: input.sessionID, args, server: target.server })
    const refused = yield* ask({
      permission: target.key,
      patterns: ["*"],
      always: ["*"],
      metadata: { via: "lunos-bridge", tool: input.tool, server: target.server },
    })
    if (refused) return refusal(refused)
    const result: { content?: unknown[]; structuredContent?: unknown; isError?: boolean } = yield* Effect.promise(() =>
      target.client
        .callTool({ name: target.tool, arguments: args }, CallToolResultSchema, {
          timeout: target.timeout,
          resetTimeoutOnProgress: true,
          onprogress: () => {},
        })
        .catch((error: unknown) => ({
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        })),
    )
    yield* hook.after(result)
    const content = (result.content ?? []).filter((item: any) =>
      ["text", "image", "resource"].includes(item?.type),
    ) as ExternalBridge.Content[]
    if (!content.length && result.structuredContent) content.push(text(JSON.stringify(result.structuredContent)))
    return {
      content: [text(`[Result from Lunos's MCP server "${target.server}"]`), ...content],
      ...(result.isError ? { isError: true } : {}),
    }
  })

  const listSkills = Effect.fnUntraced(function* (callID: string) {
    const hook = hooks("skill", {}, callID)
    yield* hook.before
    AuditLog.toolRun({ tool: "skill", agent: input.agent, session: input.sessionID, args: {} })
    const refused = yield* ask({
      permission: "skill",
      patterns: ["*"],
      always: ["*"],
      metadata: { via: "lunos-bridge", tool: input.tool, action: "list" },
    })
    if (refused) return refusal(refused)
    const output =
      (yield* input.skill.available(input.agentInfo))
        .filter((item) => item.description !== undefined)
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((item) => `- ${item.name}: ${item.description}`)
        .join("\n") || "Lunos has no skills for this project."
    yield* hook.after({ title: "Skills", output, metadata: {} })
    return { content: [text(`[Skills from Lunos]\n${output}`)] }
  })

  const loadSkill = Effect.fnUntraced(function* (args: Record<string, unknown>, callID: string) {
    const name = String(args.name ?? "")
    const info = (yield* input.skill.available(input.agentInfo)).find((item) => item.name === name)
    if (!info) return refusal(`Lunos has no skill named "${name}". lunos_skill_list lists them.`)
    const hook = hooks("skill", args, callID)
    yield* hook.before
    AuditLog.toolRun({ tool: "skill", agent: input.agent, session: input.sessionID, args })
    const refused = yield* ask({
      permission: "skill",
      patterns: [name],
      always: [name],
      metadata: { via: "lunos-bridge", tool: input.tool },
    })
    if (refused) return refusal(refused)
    const dir = path.dirname(info.location)
    const files = yield* Effect.promise(() => sample(dir, 10))
    const output = [
      `<skill_content name="${info.name}">`,
      `# Skill: ${info.name} (from Lunos)`,
      "",
      info.content.trim(),
      "",
      `Base directory for this skill: ${dir}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      "Note: file list is sampled.",
      "",
      "<skill_files>",
      files.map((file) => `<file>${file}</file>`).join("\n"),
      "</skill_files>",
      "</skill_content>",
    ].join("\n")
    yield* hook.after({ title: `Loaded skill: ${info.name}`, output, metadata: { name: info.name, dir } })
    return { content: [text(output)] }
  })

  const searchMemory = Effect.fnUntraced(function* (
    target: Extract<Target, { kind: "memory_search" }>,
    args: Record<string, unknown>,
    callID: string,
  ) {
    const hook = hooks("memory_search", args, callID)
    yield* hook.before
    AuditLog.toolRun({ tool: "memory_search", agent: input.agent, session: input.sessionID, args: {} })
    // A Lunos session's own search doesn't ask; through the bridge the facts leave for the tool's vendor.
    const refused = yield* ask({
      permission: "memory",
      patterns: ["search"],
      always: ["search"],
      metadata: { query: String(args.query ?? ""), via: "lunos-bridge", tool: input.tool },
    })
    if (refused) return refusal(refused)
    const result = yield* input.memory
      .search({
        query: String(args.query ?? ""),
        sessionID: input.sessionID,
        parent: target.parent,
        history: args.history === true,
        origin: "tool",
      })
      .pipe(Effect.result)
    if (result._tag === "Failure") return refusal(`Lunos memory search failed: ${result.failure.message}`)
    const output = MemoryRecall.block(result.success) ?? "Nothing in Lunos memory matches."
    yield* hook.after({ title: "Memory", output, metadata: {} })
    return { content: [text(`[Result from Lunos memory]\n${output}`)] }
  })

  const rememberMemory = Effect.fnUntraced(function* (
    target: Extract<Target, { kind: "memory_remember" }>,
    args: Record<string, unknown>,
    callID: string,
  ) {
    const fact = String(args.fact ?? "").trim()
    const source = String(args.source ?? "user message")
    const scope = (target.scopes.includes(String(args.scope)) ? args.scope : target.scopes[0]) as "project" | "user"
    const kind = args.kind === "observed" ? "observed" : "inferred"
    const hook = hooks("memory_remember", args, callID)
    yield* hook.before
    AuditLog.toolRun({ tool: "memory_remember", agent: input.agent, session: input.sessionID, args: {} })
    // The tool's own calls this turn are written as they stream; wait for them so the guard sees them.
    yield* Effect.promise(() => input.settle())
    const messages: SessionV1.WithParts[] = yield* input.sessions
      .messages({ sessionID: input.sessionID })
      .pipe(Effect.orElseSucceed(() => []))
    const refused =
      MemoryGuard.taint(messages, input.worktree) ??
      MemoryGuard.provenance(messages, fact, source) ??
      MemoryGuard.secret(fact)
    if (refused) return refusal(`Not remembered: ${refused}.`)
    const denied = yield* ask({
      permission: "memory",
      patterns: [scope],
      always: ["*"],
      metadata: { fact, source, scope, kind, via: "lunos-bridge", tool: input.tool },
    })
    if (denied) return refusal(denied)
    const result = yield* input.memory
      .remember({
        fact,
        source,
        scope,
        sessionID: input.sessionID,
        agent: input.agent,
        parent: target.parent,
        messages,
        kind,
      })
      .pipe(Effect.result)
    if (result._tag === "Failure") return refusal(`Not remembered: ${result.failure.message}`)
    const output = `Remembered in Lunos ${scope} memory as ${result.success.id}.`
    yield* hook.after({ title: "Remembered", output, metadata: { id: result.success.id, scope } })
    return { content: [text(output)] }
  })

  let calls = 0
  const engine: ExternalBridge.Engine = {
    list: () =>
      input.run.promise(catalog().pipe(Effect.map(({ targets }) => [...targets.values()].map((item) => item.def)))),
    call: (name, args) =>
      input.run.promise(
        Effect.gen(function* () {
          const target = (yield* catalog()).targets.get(name)
          if (!target) return refusal(`Lunos doesn't offer "${name}" in this session (any more).`)
          const callID = `lunos-bridge-${++calls}`
          const params = args && typeof args === "object" && !Array.isArray(args) ? args : {}
          if (target.kind === "mcp") return yield* callMcp(target, params, callID)
          if (target.kind === "skill_list") return yield* listSkills(callID)
          if (target.kind === "skill_load") return yield* loadSkill(params, callID)
          if (target.kind === "memory_search") return yield* searchMemory(target, params, callID)
          return yield* rememberMemory(target, params, callID)
        }),
      ),
  }

  /** Counts for the status line, from the same list the tool gets. */
  const status = () => catalog().pipe(Effect.map((item) => item.status))

  return { engine, status }
}

/** Up to `limit` files under a skill's directory, other than SKILL.md, as absolute paths. */
async function sample(dir: string, limit: number) {
  const out: string[] = []
  const walk = async (current: string, depth: number) => {
    if (out.length >= limit || depth > 3) return
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && !(current === dir && entry.name === "SKILL.md")) out.push(full)
    }
  }
  await walk(dir, 0)
  return out
}
