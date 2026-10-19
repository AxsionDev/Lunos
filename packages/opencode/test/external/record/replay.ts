#!/usr/bin/env bun
// XCOD-270: plays a recorded tool (REPLAY_FIXTURE, one process's lines from the external-fixture
// recorder) to the adapter that starts it. The tool's lines are written in recorded order; at each
// line the host sent, it waits for the adapter's next line and logs both to REPLAY_LOG with whether
// they match (same message kind and id, not the same values). A host line that doesn't come within
// REPLAY_WAIT_MS is logged as missing and the replay ends, rather than leaving the test hanging.
import { appendFileSync, readFileSync } from "fs"
import { createInterface } from "readline"

const entries = readFileSync(process.env.REPLAY_FIXTURE!, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
const log = process.env.REPLAY_LOG
const record = (entry: object) => log && appendFileSync(log, JSON.stringify(entry) + "\n")
const wait = Number(process.env.REPLAY_WAIT_MS ?? 5000)

/** What a host message is, for matching: its JSON-RPC method or response id, or its stream-json type. */
function signature(message: any): string {
  if (!message || typeof message !== "object") return String(message)
  if (typeof message.method === "string") return `method:${message.method}`
  if (message.id !== undefined) return `response:${message.id}${message.error ? ":error" : ""}`
  if (message.type === "control_request") return `control_request:${message.request?.subtype}`
  if (message.type === "control_response")
    return `control_response:${message.response?.request_id}:${message.response?.response?.behavior ?? message.response?.subtype}`
  return `type:${message.type}`
}

record({ argv: process.argv.slice(2) })
const received: string[] = []
const waiters: ((line: string | undefined) => void)[] = []
let closed = false
const input = createInterface({ input: process.stdin })
input.on("line", (line) => {
  const next = waiters.shift()
  if (next) next(line)
  else received.push(line)
})
input.on("close", () => {
  closed = true
  for (const next of waiters.splice(0)) next(undefined)
})
const nextLine = () =>
  new Promise<string | undefined>((resolve) => {
    if (received.length) return resolve(received.shift())
    if (closed) return resolve(undefined)
    const timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(done), 1)
      resolve(undefined)
    }, wait)
    const done = (line: string | undefined) => {
      clearTimeout(timer)
      resolve(line)
    }
    waiters.push(done)
  })

let code = 0
for (const entry of entries) {
  if (entry.from === "tool") process.stdout.write((entry.message ? JSON.stringify(entry.message) : entry.text) + "\n")
  if (entry.from === "stderr") process.stderr.write(entry.text + "\n")
  if (entry.from === "exit") code = entry.code ?? 0
  if (entry.from !== "host") continue
  const line = await nextLine()
  if (line === undefined) {
    record({ missing: entry.message ?? entry.text })
    process.exit(3)
  }
  let message: unknown = line
  try {
    message = JSON.parse(line)
  } catch {}
  const expected = entry.message ?? entry.text
  record({ received: message, expected, match: signature(message) === signature(expected) })
}
// As the tool would: stay until the host closes stdin (or stops it), then exit as it did.
if (!closed) await new Promise((resolve) => input.on("close", resolve))
// Anything the host sent that the recording didn't have.
for (const line of received) record({ extra: line })
process.exit(code)
