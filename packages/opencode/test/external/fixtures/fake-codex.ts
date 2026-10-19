#!/usr/bin/env bun
// XCOD-204: stands in for `codex app-server` in tests. Answers initialize / thread/start /
// thread/resume / turn/start (and model/list), then replays the recorded turn (codex-app-server.jsonl): at each
// approval request it waits for the host's answer, and on an accepted file change writes the file
// the way Codex would. review/start and thread/compact/start replay codex-review.jsonl and
// codex-compact.jsonl, recorded from 0.160.1. Everything the host sends is logged to FAKE_CODEX_LOG.
import { appendFileSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { createInterface } from "readline"

const log = process.env.FAKE_CODEX_LOG
const record = (line: string) => log && appendFileSync(log, line + "\n")
record(JSON.stringify({ argv: process.argv.slice(2) }))
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.160.1")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  console.log("Commands:\n  exec\n  app-server")
  process.exit(0)
}
if (process.argv[2] === "login" && process.argv[3] === "status") {
  console.log("Logged in using ChatGPT")
  process.exit(0)
}
const load = (file: string) =>
  readFileSync(path.join(import.meta.dir, file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
const recorded = load("codex-app-server.jsonl")
const commands: Record<string, { result: unknown; replay: any[] }> = {
  "review/start": { result: { turn: { id: "turn-review", status: "inProgress" } }, replay: load("codex-review.jsonl") },
  "thread/compact/start": { result: {}, replay: load("codex-compact.jsonl") },
}
const thread = recorded.find((m) => m.method === "thread/started")?.params.thread.id
const send = (m: unknown) => console.log(JSON.stringify(m))
const answers = new Map<number, (m: any) => void>()
let bridge: any
const turn = recorded.filter((m) => m.method && !["thread/started"].includes(m.method))

createInterface({ input: process.stdin }).on("line", async (line) => {
  record(line)
  const m = JSON.parse(line)
  if (m.id !== undefined && !m.method) return answers.get(m.id)?.(m)
  if (m.method === "initialize") return send({ id: m.id, result: { userAgent: "codex/0.160.1" } })
  // XCOD-254: the thread runs the model the host asked for, as Codex's does.
  if (m.method === "thread/start" || m.method === "thread/resume") {
    // XCOD-254: not recorded. FAKE_CODEX_REFUSE_CONFIG=1 refuses config overrides, as a Codex
    // without them might; otherwise the Lunos bridge it carries is kept for the turn.
    if (m.params.config && process.env.FAKE_CODEX_REFUSE_CONFIG === "1")
      return send({ id: m.id, error: { code: -32602, message: "unknown field `config`" } })
    bridge = m.params.config?.["mcp_servers.lunos"]
    return send({
      id: m.id,
      result: { thread: { id: m.params.threadId ?? thread }, model: m.params.model ?? "gpt-5.5" },
    })
  }
  // XCOD-254: not recorded; shaped as the app server's v2 `model/list` (`data`, `nextCursor`), two
  // pages so the host's paging is exercised.
  if (m.method === "model/list")
    return send({
      id: m.id,
      result: m.params?.cursor
        ? {
            data: [
              {
                id: "gpt-5.5-mini",
                model: "gpt-5.5-mini",
                displayName: "GPT-5.5 mini",
                description: "Faster, cheaper",
                isDefault: false,
              },
            ],
            nextCursor: null,
          }
        : {
            data: [
              {
                id: "gpt-5.5",
                model: "gpt-5.5",
                displayName: "GPT-5.5",
                description: "Latest frontier model",
                isDefault: true,
              },
            ],
            nextCursor: "page-2",
          },
    })
  const command = commands[m.method]
  if (command) {
    send({ id: m.id, result: command.result })
    for (const message of command.replay) send(message)
    return
  }
  if (m.method !== "turn/start") return
  send({ id: m.id, result: { turn: { id: "turn-1", status: "inProgress" } } })
  // XCOD-254: with the Lunos bridge, list its tools (logged); with FAKE_CODEX_BRIDGE_CALL=<tool>,
  // call it as an MCP tool call item and end the turn there instead of replaying the recording.
  if (bridge) {
    const { useBridge } = await import("./bridge-client")
    const name = process.env.FAKE_CODEX_BRIDGE_CALL
    const args = JSON.parse(process.env.FAKE_CODEX_BRIDGE_ARGS ?? "{}")
    if (name) {
      const item = {
        id: "mcp-1",
        type: "mcpToolCall",
        server: "lunos",
        tool: name,
        arguments: args,
        status: "inProgress",
      }
      send({ method: "item/started", params: { item } })
      const used = await useBridge(bridge, { name, arguments: args })
      record(JSON.stringify({ bridge: used }))
      send({ method: "item/completed", params: { item: { ...item, status: "completed", result: used.result } } })
      send({ method: "item/completed", params: { item: { id: "msg-1", type: "agentMessage", text: "Done." } } })
      send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } })
      return
    }
    record(JSON.stringify({ bridge: await useBridge(bridge) }))
  }
  for (const message of turn) {
    if (message.id !== undefined) {
      // An approval request: wait for the answer, then act on it.
      const answer = await new Promise<any>((resolve) => {
        answers.set(message.id, resolve)
        send(message)
      })
      if (answer.result?.decision === "accept" && message.method === "item/fileChange/requestApproval")
        writeFileSync(path.join(process.cwd(), "note.txt"), "from codex")
      continue
    }
    // After a declined change, the recorded item ends "declined"; after an accepted one, "completed".
    send(message)
  }
})
