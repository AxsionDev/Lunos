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
// XCOD-285 §4: `codex mcp add|remove`, as 0.160.1 does them: in $CODEX_HOME/config.toml, the only file they change.
if (process.argv[2] === "mcp") {
  const sub = process.argv[3]
  if (process.argv.includes("--help")) {
    console.log(
      "Manage external MCP servers for Codex\n\nCommands:\n  list    \n  get     \n  add     \n  remove  \n  login   \n  logout  ",
    )
    process.exit(0)
  }
  const file = path.join(process.env.CODEX_HOME ?? "", "config.toml")
  const { existsSync } = await import("fs")
  const text = existsSync(file) ? readFileSync(file, "utf8") : ""
  const name = process.argv[4]!
  if (sub === "remove") {
    const kept = text.replace(new RegExp(`\\n?\\[mcp_servers\\.${name}\\][^[]*`), "")
    if (kept === text) console.log(`No MCP server named '${name}' found.`)
    else {
      writeFileSync(file, kept)
      console.log(`Removed global MCP server '${name}'.`)
    }
    process.exit(0)
  }
  const rest = process.argv.slice(5)
  const body =
    rest[0] === "--url"
      ? `url = ${JSON.stringify(rest[1])}`
      : `command = ${JSON.stringify(rest[1])}\nargs = ${JSON.stringify(rest.slice(2))}`
  writeFileSync(file, `${text}\n[mcp_servers.${name}]\n${body}\n`)
  console.log(`Added global MCP server '${name}'.`)
  process.exit(0)
}
if (process.argv.includes("--help")) {
  console.log("Commands:\n  exec\n  mcp\n  app-server")
  process.exit(0)
}
// XCOD-285 §4: 0.160.1's recorded replies to config/read and an ephemeral thread/start
// (test/fixtures/external/codex-0.160.1/config-view.json), <codex_home> and <project> being $CODEX_HOME
// and the working directory. FAKE_CODEX_OLD=1 doesn't know config/read, as an older app server.
const configView = JSON.parse(
  readFileSync(
    path.join(import.meta.dir, "..", "..", "fixtures", "external", "codex-0.160.1", "config-view.json"),
    "utf8",
  )
    .replaceAll("<codex_home>", process.env.CODEX_HOME ?? "")
    .replaceAll("<project>", process.cwd()),
).replies
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
  if (m.method === "config/read")
    return send(
      process.env.FAKE_CODEX_OLD === "1"
        ? { id: m.id, error: { code: -32601, message: "method not found" } }
        : { id: m.id, result: configView["config/read"] },
    )
  if (m.method === "thread/start" && m.params.ephemeral) return send({ id: m.id, result: configView["thread/start"] })
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
  const ask = (request: { id: number; method: string; params: unknown }) =>
    new Promise<any>((resolve) => {
      answers.set(request.id, resolve)
      send(request)
    })
  const end = () => {
    send({ method: "item/completed", params: { item: { id: "msg-1", type: "agentMessage", text: "Done." } } })
    send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } })
  }
  // XCOD-254: FAKE_CODEX_BASH=<command> asks to run that command, as the recorded commandExecution
  // approval of 0.160.1's v2 protocol is shaped (not recorded here); the command isn't run either way.
  const bash = process.env.FAKE_CODEX_BASH
  if (bash) {
    const item = { id: "cmd-1", type: "commandExecution", command: bash, cwd: process.cwd(), status: "inProgress" }
    send({ method: "item/started", params: { item } })
    const answer = await ask({
      id: 900,
      method: "item/commandExecution/requestApproval",
      params: { threadId: thread, turnId: "turn-1", itemId: "cmd-1", command: bash, reason: null },
    })
    const accepted = answer.result?.decision === "accept"
    send({
      method: "item/completed",
      params: {
        item: { ...item, status: accepted ? "completed" : "declined", aggregatedOutput: accepted ? "(ran)" : "" },
      },
    })
    return end()
  }
  // XCOD-254: FAKE_CODEX_MCP_APPROVAL=elicitation|question asks to approve an MCP tool call (server
  // FAKE_CODEX_MCP_SERVER, default "github") in one of the two shapes Lunos reads. Neither is
  // recorded from 0.160.1: they stand in for what it may send. The answer is logged by the host log.
  const mcp = process.env.FAKE_CODEX_MCP_APPROVAL
  if (mcp) {
    const server = process.env.FAKE_CODEX_MCP_SERVER ?? "github"
    const item = {
      id: "mcp-9",
      type: "mcpToolCall",
      server,
      tool: "create_issue",
      arguments: { title: "Bug" },
      status: "inProgress",
    }
    send({ method: "item/started", params: { item } })
    const answer =
      mcp === "elicitation"
        ? await ask({
            id: 901,
            method: "mcpServer/elicitation/request",
            params: {
              threadId: thread,
              turnId: "turn-1",
              serverName: server,
              request: {
                mode: "form",
                message: `Allow ${server} to run create_issue?`,
                requestedSchema: { type: "object", properties: {} },
                _meta: { codex_approval_kind: "mcp_tool_call" },
              },
            },
          })
        : await ask({
            id: 902,
            method: "item/tool/requestUserInput",
            params: {
              threadId: thread,
              turnId: "turn-1",
              itemId: "mcp-9",
              questions: [
                {
                  id: "mcp_tool_call_approval_mcp-9",
                  header: "Approve app tool call?",
                  question: `Allow ${server} to run create_issue?`,
                  options: [
                    { label: "Allow", description: "Run the tool" },
                    { label: "Allow for this session", description: "Don't ask again" },
                    { label: "Cancel", description: "Don't run it" },
                  ],
                },
              ],
            },
          })
    const accepted =
      answer.result?.action === "accept" ||
      Object.values(answer.result?.answers ?? {}).some((value: any) => value.answers?.[0] === "Allow")
    send({
      method: "item/completed",
      params: { item: { ...item, status: accepted ? "completed" : "failed", result: { content: [] } } },
    })
    return end()
  }
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
      // XCOD-254: FAKE_CODEX_BRIDGE_APPROVAL=1 first asks to approve the call, as a Codex that
      // approves MCP tool calls might (not recorded); a declined call isn't made.
      if (process.env.FAKE_CODEX_BRIDGE_APPROVAL === "1") {
        const answer = await ask({
          id: 903,
          method: "mcpServer/elicitation/request",
          params: {
            threadId: thread,
            turnId: "turn-1",
            serverName: "lunos",
            request: {
              mode: "form",
              message: `Allow lunos to run ${name}?`,
              _meta: { codex_approval_kind: "mcp_tool_call" },
            },
          },
        })
        record(JSON.stringify({ approval: answer.result }))
        if (answer.result?.action !== "accept") {
          send({ method: "item/completed", params: { item: { ...item, status: "failed" } } })
          return end()
        }
      }
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
