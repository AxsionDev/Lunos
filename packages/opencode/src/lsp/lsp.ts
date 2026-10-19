import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EventV2Bridge } from "@/event-v2-bridge"
import * as LSPClient from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import * as LSPServer from "./server"
import { Config } from "@/config/config"
import { Process } from "@/util/process"
import { spawn as lspspawn } from "./launch"
import { Effect, Layer, Context, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { containsPath } from "@/project/instance-context"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { LspEvent } from "@opencode-ai/schema/lsp-event"
import { Global } from "@opencode-ai/core/global"

export const Event = LspEvent

const Position = Schema.Struct({
  line: NonNegativeInt,
  character: NonNegativeInt,
})

export const Range = Schema.Struct({
  start: Position,
  end: Position,
}).annotate({ identifier: "Range" })
export type Range = typeof Range.Type

export const Symbol = Schema.Struct({
  name: Schema.String,
  kind: NonNegativeInt,
  location: Schema.Struct({
    uri: Schema.String,
    range: Range,
  }),
}).annotate({ identifier: "Symbol" })
export type Symbol = typeof Symbol.Type

export const DocumentSymbol = Schema.Struct({
  name: Schema.String,
  detail: Schema.optional(Schema.String),
  kind: NonNegativeInt,
  range: Range,
  selectionRange: Range,
}).annotate({ identifier: "DocumentSymbol" })
export type DocumentSymbol = typeof DocumentSymbol.Type

export const Status = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "starting", "error"]),
  /** XCOD-257: why it failed (`error`): the spawn error, exit code and stderr, or the init error. */
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "LSPStatus" })
export type Status = typeof Status.Type

// XCOD-257: every server Lunos knows, with what it's doing, for /lsp and `lunos lsp status`.
export const ServerState = Schema.Literals(["running", "starting", "failed", "not_started", "disabled"])
export const Server = Schema.Struct({
  id: Schema.String,
  extensions: Schema.mutable(Schema.Array(Schema.String)),
  state: ServerState,
  custom: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  root: Schema.optional(Schema.String),
  /** Where the binary came from: the project's node_modules/.bin, PATH, Lunos's download cache, or config. */
  source: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Finite),
  started: Schema.optional(Schema.Finite),
  diagnostics: Schema.optional(Schema.Finite),
}).annotate({ identifier: "LSPServerInfo" })
export type Server = typeof Server.Type
export const Overview = Schema.Struct({
  enabled: Schema.Boolean,
  downloads: Schema.Boolean,
  servers: Schema.mutable(Schema.Array(Server)),
}).annotate({ identifier: "LSPOverview" })
export type Overview = typeof Overview.Type

/** The last lines of a server's stderr, kept for "View log" and failure reasons. */
const LOG_LINES = 200

const builtins = () =>
  Object.values(LSPServer).filter(
    (item): item is LSPServer.Info => typeof item === "object" && item !== null && "id" in item && "spawn" in item,
  )
const builtin = (id: string) => builtins().find((item) => item.id === id)

/** "command not found: gopls" for a missing binary, otherwise the error's own message. */
export function spawnReason(error: unknown, command?: string) {
  const err = error as { code?: string; message?: string; path?: string }
  if (err?.code === "ENOENT") return `command not found: ${command ?? err.path ?? "unknown"}`
  return err?.message ?? String(error)
}

/** Where a running server's binary came from. */
export function sourceOf(command: string | undefined, bin: string, custom: boolean) {
  if (custom) return "custom command"
  if (!command) return undefined
  if (command.includes(`${path.sep}node_modules${path.sep}.bin${path.sep}`)) return "project node_modules/.bin"
  if (command.startsWith(bin)) return `downloaded (${command})`
  if (command === process.execPath) return "bundled with Lunos"
  return path.isAbsolute(command) ? `PATH (${command})` : command
}

enum SymbolKind {
  File = 1,
  Module = 2,
  Namespace = 3,
  Package = 4,
  Class = 5,
  Method = 6,
  Property = 7,
  Field = 8,
  Constructor = 9,
  Enum = 10,
  Interface = 11,
  Function = 12,
  Variable = 13,
  Constant = 14,
  String = 15,
  Number = 16,
  Boolean = 17,
  Array = 18,
  Object = 19,
  Key = 20,
  Null = 21,
  EnumMember = 22,
  Struct = 23,
  Event = 24,
  Operator = 25,
  TypeParameter = 26,
}

const kinds = [
  SymbolKind.Class,
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Interface,
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Struct,
  SymbolKind.Enum,
]

const filterExperimentalServers = (servers: Record<string, LSPServer.Info>, flags: RuntimeFlags.Info) => {
  if (flags.experimentalLspTy) {
    if (servers["pyright"]) {
      delete servers["pyright"]
    }
  } else {
    if (servers["ty"]) {
      delete servers["ty"]
    }
  }
}

type LocInput = { file: string; line: number; character: number }

interface State {
  clients: LSPClient.Info[]
  servers: Record<string, LSPServer.Info>
  /** XCOD-257: servers that failed, keyed root + id, with why and when. */
  broken: Map<string, { serverID: string; root: string; reason: string; at: number }>
  spawning: Map<string, Promise<LSPClient.Info | undefined>>
  /** Turned off in config, kept so the panel can list them. */
  disabled: string[]
  custom: Set<string>
  /** Per root + id: the process, the command it ran, when it started, and its last stderr lines. */
  procs: Map<string, { pid?: number; command?: string; started: number; log: string[] }>
}

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly status: () => Effect.Effect<Status[]>
  readonly overview: () => Effect.Effect<Overview>
  /** Stops a server's clients; `restart` also forgets a failure, so the next matching file starts it. */
  readonly stop: (id: string, restart: boolean) => Effect.Effect<void>
  readonly log: (id: string) => Effect.Effect<string[]>
  readonly hasClients: (file: string) => Effect.Effect<boolean>
  readonly touchFile: (input: string, diagnostics?: "document" | "full") => Effect.Effect<void>
  readonly diagnostics: () => Effect.Effect<Record<string, LSPClient.Diagnostic[]>>
  readonly hover: (input: LocInput) => Effect.Effect<any>
  readonly definition: (input: LocInput) => Effect.Effect<any[]>
  readonly references: (input: LocInput) => Effect.Effect<any[]>
  readonly implementation: (input: LocInput) => Effect.Effect<any[]>
  readonly documentSymbol: (uri: string) => Effect.Effect<(DocumentSymbol | Symbol)[]>
  readonly workspaceSymbol: (query: string) => Effect.Effect<Symbol[]>
  readonly prepareCallHierarchy: (input: LocInput) => Effect.Effect<any[]>
  readonly incomingCalls: (input: LocInput) => Effect.Effect<any[]>
  readonly outgoingCalls: (input: LocInput) => Effect.Effect<any[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LSP") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const events = yield* EventV2Bridge.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("LSP.state")(function* (ctx) {
        const cfg = yield* config.get()

        const servers: Record<string, LSPServer.Info> = {}
        const disabled: string[] = []
        const custom = new Set<string>()

        // XCOD-246: on unless set to false. Upstream is opt-in; Lunos ships LSP ready.
        if (cfg.lsp === false) {
          yield* Effect.logInfo("all LSPs are disabled")
        } else {
          for (const server of Object.values(LSPServer)) {
            servers[server.id] = server
          }

          filterExperimentalServers(servers, flags)

          if (typeof cfg.lsp === "object") {
            for (const [name, item] of Object.entries(cfg.lsp)) {
              const existing = servers[name]
              if (item.disabled) {
                yield* Effect.logInfo(`LSP server ${name} is disabled`)
                delete servers[name]
                disabled.push(name)
                continue
              }
              if (!existing) custom.add(name)
              servers[name] = {
                ...existing,
                id: name,
                root: existing?.root ?? (async (_file, ctx) => ctx.directory),
                extensions: item.extensions ?? existing?.extensions ?? [],
                spawn: async (root) => ({
                  process: lspspawn(item.command[0], item.command.slice(1), {
                    cwd: root,
                    env: { ...process.env, ...item.env },
                  }),
                  initialization: item.initialization,
                }),
              }
            }
          }

          yield* Effect.logInfo("enabled LSP servers", {
            serverIds: Object.values(servers)
              .map((server) => server.id)
              .join(", "),
          })
        }

        const s: State = {
          clients: [],
          servers,
          broken: new Map(),
          spawning: new Map(),
          disabled,
          custom,
          procs: new Map(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await Promise.all(s.clients.map((client) => client.shutdown()))
          }),
        )

        return s
      }),
    )

    const getClients = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return [] as LSPClient.Info[]
      const s = yield* InstanceState.get(state)
      const clients = yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        const result: LSPClient.Info[] = []
        let updated = 0
        const failures = s.broken.size

        // XCOD-257: a failure keeps its reason, shown in /lsp, the sidebar and `lunos lsp status`.
        const fail = (key: string, reason: string) =>
          s.broken.set(key, { serverID: server_(key), root: root_(key), reason, at: Date.now() })
        const keys = new Map<string, { serverID: string; root: string }>()
        const server_ = (key: string) => keys.get(key)!.serverID
        const root_ = (key: string) => keys.get(key)!.root

        async function schedule(server: LSPServer.Info, root: string, key: string) {
          keys.set(key, { serverID: server.id, root })
          const handle = await server
            .spawn(root, ctx, flags)
            .then((value) => {
              if (!value)
                fail(
                  key,
                  flags.disableLspDownload
                    ? "not installed, and downloads are off (OPENCODE_DISABLE_LSP_DOWNLOAD or offline mode)"
                    : "not found here (project, PATH or Lunos's cache), and not downloaded",
                )
              return value
            })
            .catch((error) => {
              fail(key, spawnReason(error, server.id))
              return undefined
            })

          if (!handle) return undefined
          // `node /…/eslintServer.js --stdio`: the script, not the interpreter, says where it came from.
          const args = handle.process.spawnargs ?? []
          const proc = {
            pid: handle.process.pid,
            command: args.find((arg, index) => index > 0 && path.isAbsolute(arg)) ?? handle.process.spawnfile,
            started: Date.now(),
            log: [] as string[],
          }
          s.procs.set(key, proc)
          handle.process.stderr?.on("data", (chunk: Buffer) => {
            proc.log.push(...chunk.toString().split(/\r?\n/).filter(Boolean))
            if (proc.log.length > LOG_LINES) proc.log.splice(0, proc.log.length - LOG_LINES)
          })
          let exit: number | null | undefined
          const exited = new Promise<never>((_, reject) =>
            handle.process.once("exit", (code) => {
              exit = code
              reject(new Error(`exited with code ${code}`))
            }),
          )
          exited.catch(() => {})
          // No pid: the command didn't start (ENOENT, EACCES). Its error arrives on the next tick;
          // talking to it before then would write into a dead pipe.
          if (handle.process.pid === undefined) {
            const error = await new Promise<unknown>((resolve) => {
              handle.process.once("error", resolve)
              setTimeout(() => resolve(new Error("didn't start")), 1000)
            })
            fail(key, spawnReason(error, proc.command))
            return undefined
          }
          handle.process.once("error", (error) => fail(key, spawnReason(error, proc.command)))
          // A server that exits while starting fails at once, not after the initialise timeout.
          const client = await Promise.race([
            LSPClient.create({
              serverID: server.id,
              server: handle,
              root,
              directory: ctx.directory,
              instance: ctx,
            }),
            exited,
          ]).catch(async (error) => {
            if (!s.broken.has(key)) {
              const tail = proc.log.slice(-3).join(" · ")
              const message = spawnReason(error, proc.command).trim()
              fail(
                key,
                [
                  exit !== undefined && exit !== null
                    ? `exited with code ${exit} before it finished starting`
                    : `didn't finish starting${message ? `: ${message}` : ""}`,
                  tail || undefined,
                ]
                  .filter(Boolean)
                  .join(" · "),
              )
            }
            await Process.stop(handle.process)
            return undefined
          })

          if (!client) return undefined

          const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (existing) {
            await Process.stop(handle.process)
            return existing
          }

          s.clients.push(client)
          return client
        }

        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue

          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue

          const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
          if (match) {
            result.push(match)
            continue
          }

          const inflight = s.spawning.get(root + server.id)
          if (inflight) {
            const client = await inflight
            if (!client) continue
            result.push(client)
            continue
          }

          const task = schedule(server, root, root + server.id)
          s.spawning.set(root + server.id, task)

          task.finally(() => {
            if (s.spawning.get(root + server.id) === task) {
              s.spawning.delete(root + server.id)
            }
          })

          const client = await task
          if (!client) continue

          result.push(client)
          updated++
        }

        // XCOD-257: a new failure is news too, so the sidebar and /lsp show its reason.
        return { result, updated: updated + Math.max(0, s.broken.size - failures) }
      })
      yield* Effect.forEach(Array.from({ length: clients.updated }), () => events.publish(Event.Updated, {}), {
        discard: true,
      })
      return clients.result
    })

    const run = Effect.fnUntraced(function* <T>(file: string, fn: (client: LSPClient.Info) => Promise<T>) {
      const clients = yield* getClients(file)
      return yield* Effect.promise(() => Promise.all(clients.map((x) => fn(x))))
    })

    const runAll = Effect.fnUntraced(function* <T>(fn: (client: LSPClient.Info) => Promise<T>) {
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(() => Promise.all(s.clients.map((x) => fn(x))))
    })

    const init = Effect.fn("LSP.init")(function* () {
      yield* InstanceState.get(state)
    })

    const status = Effect.fn("LSP.status")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const result: Status[] = []
      for (const client of s.clients) {
        result.push({
          id: client.serverID,
          name: s.servers[client.serverID].id,
          root: path.relative(ctx.directory, client.root),
          status: "connected",
        })
      }
      // XCOD-257: starting and failed servers are listed too, a failure with its reason.
      for (const key of s.spawning.keys()) {
        const server = Object.values(s.servers).find((item) => key.endsWith(item.id))
        if (!server) continue
        const root = key.slice(0, key.length - server.id.length)
        result.push({ id: server.id, name: server.id, root: path.relative(ctx.directory, root), status: "starting" })
      }
      for (const item of s.broken.values())
        result.push({
          id: item.serverID,
          name: item.serverID,
          root: path.relative(ctx.directory, item.root),
          status: "error",
          reason: item.reason,
        })
      return result
    })

    const overview = Effect.fn("LSP.overview")(function* () {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      const cfg = yield* config.get()
      const enabled = cfg.lsp !== false
      // With LSP off, the built-in servers are still listed (as off) so the panel shows what it would run.
      const known = enabled ? Object.values(s.servers) : builtins()
      const servers: Server[] = known.map((server) => {
        const client = s.clients.find((item) => item.serverID === server.id)
        const key = client ? client.root + server.id : undefined
        const proc = key ? s.procs.get(key) : undefined
        const broken = [...s.broken.values()].find((item) => item.serverID === server.id)
        const starting = [...s.spawning.keys()].some((item) => item.endsWith(server.id))
        const custom = s.custom.has(server.id)
        const count = client ? [...client.diagnostics.values()].reduce((total, list) => total + list.length, 0) : 0
        return {
          id: server.id,
          extensions: [...server.extensions],
          custom,
          state: !enabled ? "disabled" : client ? "running" : starting ? "starting" : broken ? "failed" : "not_started",
          ...(broken && !client ? { reason: broken.reason } : {}),
          ...(client ? { root: path.relative(ctx.directory, client.root) || "." } : {}),
          ...(proc?.command ? { command: proc.command } : {}),
          ...(client ? { source: sourceOf(proc?.command, Global.Path.bin, custom) } : {}),
          ...(proc?.pid ? { pid: proc.pid } : {}),
          ...(proc && client ? { started: proc.started } : {}),
          ...(client ? { diagnostics: count } : {}),
        }
      })
      for (const id of s.disabled)
        servers.push({
          id,
          extensions: [...(builtin(id)?.extensions ?? [])],
          state: "disabled",
          custom: false,
          reason: "turned off in config",
        })
      const rank = (item: Server) =>
        item.state === "running" || item.state === "failed" ? 0 : item.state === "starting" ? 1 : 2
      servers.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
      return { enabled, downloads: !flags.disableLspDownload, servers }
    })

    const stop = Effect.fn("LSP.stop")(function* (id: string, restart: boolean) {
      const s = yield* InstanceState.get(state)
      const mine = s.clients.filter((client) => client.serverID === id)
      s.clients = s.clients.filter((client) => client.serverID !== id)
      yield* Effect.promise(() => Promise.all(mine.map((client) => client.shutdown().catch(() => {}))))
      if (restart) for (const [key, item] of s.broken) if (item.serverID === id) s.broken.delete(key)
      yield* events.publish(Event.Updated, {})
    })

    const log = Effect.fn("LSP.log")(function* (id: string) {
      const s = yield* InstanceState.get(state)
      return [...s.procs.entries()].filter(([key]) => key.endsWith(id)).flatMap(([, proc]) => proc.log)
    })

    const hasClients = Effect.fn("LSP.hasClients")(function* (file: string) {
      const ctx = yield* InstanceState.context
      const s = yield* InstanceState.get(state)
      return yield* Effect.promise(async () => {
        const extension = path.parse(file).ext || file
        for (const server of Object.values(s.servers)) {
          if (server.extensions.length && !server.extensions.includes(extension)) continue
          const root = await server.root(file, ctx)
          if (!root) continue
          if (s.broken.has(root + server.id)) continue
          return true
        }
        return false
      })
    })

    const touchFile = Effect.fn("LSP.touchFile")(function* (input: string, diagnostics?: "document" | "full") {
      yield* Effect.logInfo("touching file", { file: input })
      const clients = yield* getClients(input)
      yield* Effect.promise(() =>
        Promise.all(
          clients.map(async (client) => {
            const after = Date.now()
            const version = await client.notify.open({ path: input })
            if (!diagnostics) return
            return client.waitForDiagnostics({
              path: input,
              version,
              mode: diagnostics,
              after,
            })
          }),
        ).catch(() => {}),
      )
    })

    const diagnostics = Effect.fn("LSP.diagnostics")(function* () {
      const results: Record<string, LSPClient.Diagnostic[]> = {}
      const all = yield* runAll(async (client) => client.diagnostics)
      for (const result of all) {
        for (const [p, diags] of result.entries()) {
          const arr = results[p] || []
          arr.push(...diags)
          results[p] = arr
        }
      }
      return results
    })

    const hover = Effect.fn("LSP.hover")(function* (input: LocInput) {
      return yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/hover", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
    })

    const definition = Effect.fn("LSP.definition")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/definition", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const references = Effect.fn("LSP.references")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/references", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
            context: { includeDeclaration: true },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const implementation = Effect.fn("LSP.implementation")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/implementation", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => null),
      )
      return results.flat().filter(Boolean)
    })

    const documentSymbol = Effect.fn("LSP.documentSymbol")(function* (uri: string) {
      const file = fileURLToPath(uri)
      const results = yield* run(file, (client) =>
        client.connection.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => []),
      )
      return (results.flat() as (DocumentSymbol | Symbol)[]).filter(Boolean)
    })

    const workspaceSymbol = Effect.fn("LSP.workspaceSymbol")(function* (query: string) {
      const results = yield* runAll((client) =>
        client.connection
          .sendRequest<Symbol[]>("workspace/symbol", { query })
          .then((result) => result.filter((x) => kinds.includes(x.kind)).slice(0, 10))
          .catch(() => [] as Symbol[]),
      )
      return results.flat()
    })

    const prepareCallHierarchy = Effect.fn("LSP.prepareCallHierarchy")(function* (input: LocInput) {
      const results = yield* run(input.file, (client) =>
        client.connection
          .sendRequest("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => []),
      )
      return results.flat().filter(Boolean)
    })

    const callHierarchyRequest = Effect.fnUntraced(function* (
      input: LocInput,
      direction: "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls",
    ) {
      const results = yield* run(input.file, async (client) => {
        const items = await client.connection
          .sendRequest<unknown[] | null>("textDocument/prepareCallHierarchy", {
            textDocument: { uri: pathToFileURL(input.file).href },
            position: { line: input.line, character: input.character },
          })
          .catch(() => [] as unknown[])
        if (!items?.length) return []
        return client.connection.sendRequest(direction, { item: items[0] }).catch(() => [])
      })
      return results.flat().filter(Boolean)
    })

    const incomingCalls = Effect.fn("LSP.incomingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/incomingCalls")
    })

    const outgoingCalls = Effect.fn("LSP.outgoingCalls")(function* (input: LocInput) {
      return yield* callHierarchyRequest(input, "callHierarchy/outgoingCalls")
    })

    return Service.of({
      init,
      status,
      overview,
      stop,
      log,
      hasClients,
      touchFile,
      diagnostics,
      hover,
      definition,
      references,
      implementation,
      documentSymbol,
      workspaceSymbol,
      prepareCallHierarchy,
      incomingCalls,
      outgoingCalls,
    })
  }),
)

export * as Diagnostic from "./diagnostic"

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, RuntimeFlags.node, FSUtil.node, EventV2Bridge.node],
})

export * as LSP from "./lsp"
