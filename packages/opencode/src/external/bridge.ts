export * as ExternalBridge from "./bridge"

import { createHash, randomBytes, timingSafeEqual } from "crypto"
import { existsSync } from "fs"
import fs from "fs/promises"
import net from "net"
import os from "os"
import path from "path"
import { createInterface } from "readline"
import { fileURLToPath } from "url"
import { which } from "@opencode-ai/core/util/which"
import { Restart } from "@/cli/restart"

/**
 * XCOD-254: the Lunos bridge, one MCP server that carries Lunos's MCP servers, skills and memory into
 * a Claude Code or Codex session. Two halves:
 *
 * - The **host** runs inside Lunos for one turn of the external session. It listens on a local
 *   socket (a 0700 directory under the OS temp dir; a named pipe on Windows) and answers `list` and
 *   `call` with the session's own services, so every call goes through Lunos's permission service,
 *   hooks and audit log like a native tool call (`bridge-tools.ts`).
 * - `lunos mcp bridge --session <id>` is the stdio MCP server the tool starts from the config Lunos
 *   hands it. It knows nothing itself: it relays the tool's requests to the host, with the token it
 *   was given, and tells the tool when the host says the list changed (`tools/list_changed`).
 *
 * The protocol is one JSON object per line: `{ id, method, params }` → `{ id, result | error }`, and
 * `{ method: "changed" }` from the host. The first request must be `hello { token, session }`.
 */

/** The bridge's MCP server name in the tool: Claude Code calls its tools `mcp__lunos__<name>`. */
export const SERVER = "lunos"
export const ENV_SOCKET = "LUNOS_BRIDGE_SOCKET"
export const ENV_TOKEN = "LUNOS_BRIDGE_TOKEN"

/**
 * Tool names must fit the model APIs' 64 characters once the tool adds its own `mcp__lunos__`
 * prefix, and use only letters, digits, `_` and `-`.
 */
export const NAME_LIMIT = 64 - `mcp__${SERVER}__`.length

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: Record<string, unknown> }

export interface CallResult {
  content: Content[]
  isError?: boolean
}

/** What the host answers with; built from the session's services in `bridge-tools.ts`. */
export interface Engine {
  list: () => Promise<ToolDef[]>
  call: (name: string, args: Record<string, unknown>) => Promise<CallResult>
}

function clean(text: string) {
  return text.replace(/[^A-Za-z0-9_-]/g, "_")
}

/**
 * `lunos__<server>__<tool>` for a Lunos MCP server's tool, cut to `NAME_LIMIT` with a short hash
 * when it's longer, so two long names never collide. Never parsed back: the host keeps a map.
 */
export function mcpName(server: string, tool: string) {
  const name = `lunos__${clean(server)}__${clean(tool)}`
  if (name.length <= NAME_LIMIT) return name
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8)
  return `${name.slice(0, NAME_LIMIT - 9)}_${hash}`
}

export interface Host {
  socket: string
  token: string
  /** True once a bridge has connected with the token. */
  connected: () => boolean
  /** Tells every connected bridge that the tool list changed. */
  changed: () => void
  close: () => Promise<void>
}

function same(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Starts a host for one turn of `session`. Close it when the turn ends, however it ends. */
export async function serve(input: { session: string; engine: Engine; onConnect?: () => void }): Promise<Host> {
  const token = randomBytes(32).toString("hex")
  const dir = process.platform === "win32" ? undefined : await fs.mkdtemp(path.join(os.tmpdir(), "lunos-bridge-"))
  if (dir) await fs.chmod(dir, 0o700)
  const socket = dir ? path.join(dir, "s") : `\\\\.\\pipe\\lunos-bridge-${randomBytes(12).toString("hex")}`
  const clients = new Set<net.Socket>()
  let connected = false

  const server = net.createServer((conn) => {
    let trusted = false
    const send = (message: unknown) => {
      if (!conn.destroyed) conn.write(JSON.stringify(message) + "\n")
    }
    conn.on("error", () => undefined)
    conn.on("close", () => clients.delete(conn))
    createInterface({ input: conn }).on("line", (line) => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return conn.destroy()
      }
      const id = message?.id
      if (!trusted) {
        const params = message?.params ?? {}
        if (
          message?.method !== "hello" ||
          typeof params.token !== "string" ||
          !same(params.token, token) ||
          params.session !== input.session
        ) {
          send({ id, error: { message: "Not a Lunos bridge for this session" } })
          return conn.destroy()
        }
        trusted = true
        connected = true
        clients.add(conn)
        input.onConnect?.()
        return send({ id, result: { ok: true } })
      }
      const run =
        message.method === "list"
          ? input.engine.list().then((tools) => ({ tools }))
          : message.method === "call"
            ? input.engine.call(String(message.params?.name ?? ""), message.params?.arguments ?? {})
            : Promise.reject(new Error(`Unknown method ${message.method}`))
      run.then(
        (result) => send({ id, result }),
        (error: unknown) => send({ id, error: { message: error instanceof Error ? error.message : String(error) } }),
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, () => resolve())
  })
  if (dir) await fs.chmod(socket, 0o600).catch(() => undefined)

  return {
    socket,
    token,
    connected: () => connected,
    changed: () => {
      for (const conn of clients) if (!conn.destroyed) conn.write(JSON.stringify({ method: "changed" }) + "\n")
    },
    close: async () => {
      for (const conn of clients) conn.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (dir) await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

export interface Client {
  list: () => Promise<ToolDef[]>
  call: (name: string, args: Record<string, unknown>) => Promise<CallResult>
  onChanged: (listener: () => void) => void
  onClose: (listener: () => void) => void
  close: () => void
}

/** The bridge's side: connects to the host and says hello. Rejects when the host refuses it. */
export function connect(input: { socket: string; token: string; session: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(input.socket)
    let nextID = 0
    const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
    const changed: (() => void)[] = []
    const closed: (() => void)[] = []
    const request = (method: string, params?: unknown) =>
      new Promise<any>((resolve, reject) => {
        const id = ++nextID
        waiting.set(id, { resolve, reject })
        conn.write(JSON.stringify({ id, method, params }) + "\n")
      })
    conn.on("error", (error) => reject(error))
    conn.on("close", () => {
      for (const item of waiting.values()) item.reject(new Error("The Lunos session ended"))
      waiting.clear()
      for (const listener of closed) listener()
    })
    createInterface({ input: conn }).on("line", (line) => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.method === "changed") return changed.forEach((listener) => listener())
      const handler = waiting.get(message.id)
      waiting.delete(message.id)
      if (message.error) handler?.reject(new Error(message.error.message ?? "Lunos refused the request"))
      else handler?.resolve(message.result)
    })
    conn.once("connect", () => {
      request("hello", { token: input.token, session: input.session }).then(
        () =>
          resolve({
            list: () => request("list").then((result) => result?.tools ?? []),
            call: (name, args) => request("call", { name, arguments: args }),
            onChanged: (listener) => changed.push(listener),
            onClose: (listener) => closed.push(listener),
            close: () => conn.end(),
          }),
        reject,
      )
    })
  })
}

/**
 * How the tool starts `lunos mcp bridge`: this Lunos binary; from source, bun plus the entry script;
 * otherwise (the desktop app's bundle) the `lunos` on PATH. Undefined when there's none.
 */
export function command(session: string): { command: string; args: string[] } | undefined {
  const tail = ["mcp", "bridge", "--session", session]
  if (Restart.isCompiled(process.argv[1])) return { command: process.execPath, args: tail }
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts")
  if (process.versions.bun && existsSync(entry)) return { command: process.execPath, args: [entry, ...tail] }
  const found = which("lunos")
  return found ? { command: found, args: tail } : undefined
}

/** The stdio server entry both tools get: the command, plus the socket and token in its environment. */
export function entry(session: string, host: Pick<Host, "socket" | "token">) {
  const resolved = command(session)
  if (!resolved) throw new Error("Lunos can't find its own command to start the bridge (no lunos on PATH)")
  return { ...resolved, env: { [ENV_SOCKET]: host.socket, [ENV_TOKEN]: host.token } }
}

/**
 * Claude Code: a `--mcp-config` file (`{ mcpServers: { lunos: { type, command, args, env } } }`),
 * readable by the user only, next to the socket; it holds the token. The user's own MCP servers
 * still load (`--strict-mcp-config` isn't passed), and nothing under ~/.claude is written.
 */
export async function claudeConfig(session: string, host: Pick<Host, "socket" | "token">) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-mcp-"))
  await fs.chmod(dir, 0o700)
  const file = path.join(dir, "mcp.json")
  await fs.writeFile(
    file,
    JSON.stringify({ mcpServers: { [SERVER]: { type: "stdio", ...entry(session, host) } } }, null, 2),
    { mode: 0o600 },
  )
  return { file, remove: () => fs.rm(dir, { recursive: true, force: true }) }
}

/**
 * Codex: a config override on `thread/start` / `thread/resume` (`config`, Codex's `-c` keys), so
 * nothing under ~/.codex is written. Codex's MCP server table is `mcp_servers.<name>`.
 */
export function codexConfig(session: string, host: Pick<Host, "socket" | "token">) {
  return { [`mcp_servers.${SERVER}`]: entry(session, host) }
}

/** What the bridge offered in a turn, kept on the session for the header and `lunos external list`. */
export interface Status {
  servers: number
  skills: number
  memory: boolean
  /** The tool started the bridge and it connected; false when it didn't (the warning). */
  connected?: boolean
  /** Why no bridge runs, when none does ("not shared", "needs Claude Code with --mcp-config", …). */
  off?: string
}

/** "Lunos bridge: 2 servers, 3 skills, memory on", with a warning when it isn't connected. */
export function line(status: Status | undefined) {
  if (!status) return undefined
  if (status.off) return `Lunos bridge: off (${status.off})`
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
  const text = `Lunos bridge: ${plural(status.servers, "server")}, ${plural(status.skills, "skill")}, memory ${status.memory ? "on" : "off"}`
  return status.connected === false ? `${text} ⚠ not connected` : text
}
