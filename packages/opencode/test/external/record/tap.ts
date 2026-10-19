#!/usr/bin/env bun
// XCOD-270: sits between a Lunos adapter and the tool it drives while the external-fixture recorder
// runs. The adapter starts this as its `executable`; it starts the tool (REC_TARGET) with the same
// arguments, passes stdin and stdout through unchanged, and appends every line, redacted, to
// REC_LOG: `{ from: "argv" | "host" | "tool" | "stderr" | "exit", … }`. Nothing unredacted is
// written. REC_* settings are not passed on to the tool; REC_EXTRA_ENV adds variables the adapter's
// environment strips (CLAUDE_CODE_*).
import { spawn } from "child_process"
import { appendFileSync, readFileSync } from "fs"
import { createInterface } from "readline"
import { ExternalDetect } from "../../../src/external/detect"
import { compile } from "./redact"

const target = process.env.REC_TARGET!
const log = process.env.REC_LOG!
const redact = compile(JSON.parse(readFileSync(process.env.REC_CONTEXT!, "utf8")))
const extra = JSON.parse(process.env.REC_EXTRA_ENV ?? "{}") as Record<string, string>
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REC_")))

const write = (entry: object) => appendFileSync(log, JSON.stringify(redact.value(entry)) + "\n")
const entry = (from: string, line: string) => {
  try {
    return { from, message: JSON.parse(line) }
  } catch {
    return { from, text: line }
  }
}

const args = process.argv.slice(2)
write({ from: "argv", argv: args })
const cmd = ExternalDetect.command(target, args)
const child = spawn(cmd.file, cmd.args, {
  env: { ...env, ...extra },
  shell: cmd.shell,
  stdio: ["pipe", "pipe", "pipe"],
})
child.stdin.on("error", () => undefined)
createInterface({ input: process.stdin })
  .on("line", (line) => {
    write(entry("host", line))
    if (!child.stdin.destroyed) child.stdin.write(line + "\n")
  })
  .on("close", () => child.stdin.end())
createInterface({ input: child.stdout }).on("line", (line) => {
  write(entry("tool", line))
  process.stdout.write(line + "\n")
})
createInterface({ input: child.stderr }).on("line", (line) => {
  write({ from: "stderr", text: line })
  process.stderr.write(line + "\n")
})
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal))
child.on("error", (error) => {
  write({ from: "exit", error: error.message })
  process.exit(127)
})
child.on("close", (code, signal) => {
  write({ from: "exit", code, signal })
  process.exit(code ?? 1)
})
