#!/usr/bin/env bun
// XCOD-204: stands in for Claude Code in tests. Replays the recorded stream-json session in
// claude-stream.jsonl, waiting at each can_use_tool request for the host's control_response and
// recording what the host sent (to FAKE_CLAUDE_LOG) so the test can check it.
import { appendFileSync, readFileSync } from "fs"
import path from "path"
import { createInterface } from "readline"

const log = process.env.FAKE_CLAUDE_LOG
const record = (line: string) => log && appendFileSync(log, line + "\n")
record(JSON.stringify({ argv: process.argv.slice(2) }))
if (process.argv.includes("--version")) {
  console.log("2.1.292 (Claude Code)")
  process.exit(0)
}
if (process.argv.includes("--help")) {
  console.log("--input-format <format>\n--output-format <format>\n--permission-prompts <target>")
  process.exit(0)
}
if (process.argv[2] === "auth" && process.argv[3] === "status") {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }))
  process.exit(0)
}
const lines = readFileSync(path.join(import.meta.dir, "claude-stream.jsonl"), "utf8")
  .trim()
  .split("\n")
const input = createInterface({ input: process.stdin })
const received: string[] = []
const waiters: ((line: string) => void)[] = []
input.on("line", (line) => {
  record(line)
  const next = waiters.shift()
  if (next) next(line)
  else received.push(line)
})
const nextLine = () =>
  new Promise<string>((resolve) => (received.length ? resolve(received.shift()!) : waiters.push(resolve)))

// XCOD-254: initialize is answered at once, as Claude Code does, with the models it offers. Not
// recorded: shaped as the Agent SDK's initialize response (`models: { value, displayName,
// description }[]`). FAKE_CLAUDE_MODELS=none answers without them, like a release that doesn't list them.
const init = JSON.parse(await nextLine())
console.log(
  JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: init.request_id,
      response: {
        commands: [],
        ...(process.env.FAKE_CLAUDE_MODELS === "none"
          ? {}
          : {
              models: [
                { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 with 1M context" },
                { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5.5 for everyday tasks" },
                { value: "haiku", displayName: "Haiku", description: "Haiku 5.5 for quick answers" },
              ],
            }),
      },
    },
  }),
)
// then the user prompt
await nextLine()
// XCOD-254: the replayed init names the model passed with --model, as Claude Code's would.
const chosen = process.argv[process.argv.indexOf("--model") + 1]
if (process.argv.includes("--model") && chosen) {
  const first = JSON.parse(lines[0]!)
  lines[0] = JSON.stringify({ ...first, model: chosen })
}
// XCOD-218: FAKE_CLAUDE_DELAY_MS slows the replay, so a test can stop a turn while it runs.
const delay = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? 0)
for (const line of lines) {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  console.log(line)
  const message = JSON.parse(line)
  if (message.type === "control_request") {
    const answer = JSON.parse(await nextLine())
    if (answer.response?.request_id !== message.request_id) {
      console.error("control_response for the wrong request")
      process.exit(3)
    }
    // Act on an approved Write the way Claude Code would, inside the working directory.
    if (answer.response.response?.behavior === "allow" && message.request.tool_name === "Write") {
      const { writeFileSync } = await import("fs")
      writeFileSync(
        path.join(process.cwd(), path.basename(message.request.input.file_path)),
        message.request.input.content,
      )
    }
  }
}
await new Promise((resolve) => input.on("close", resolve))
