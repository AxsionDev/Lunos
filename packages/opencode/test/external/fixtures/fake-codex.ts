#!/usr/bin/env bun
// XCOD-204: stands in for `codex app-server` in tests. Answers initialize / thread/start /
// thread/resume / turn/start, then replays the recorded turn (codex-app-server.jsonl): at each
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
const turn = recorded.filter((m) => m.method && !["thread/started"].includes(m.method))

createInterface({ input: process.stdin }).on("line", async (line) => {
  record(line)
  const m = JSON.parse(line)
  if (m.id !== undefined && !m.method) return answers.get(m.id)?.(m)
  if (m.method === "initialize") return send({ id: m.id, result: { userAgent: "codex/0.160.1" } })
  if (m.method === "thread/start" || m.method === "thread/resume")
    return send({ id: m.id, result: { thread: { id: m.params.threadId ?? thread }, model: "gpt-5.5" } })
  const command = commands[m.method]
  if (command) {
    send({ id: m.id, result: command.result })
    for (const message of command.replay) send(message)
    return
  }
  if (m.method !== "turn/start") return
  send({ id: m.id, result: { turn: { id: "turn-1", status: "inProgress" } } })
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
