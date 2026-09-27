#!/usr/bin/env bun

import { rm } from "fs/promises"
import path from "path"
import { parseArgs } from "util"

const root = path.resolve(import.meta.dir, "..")
const file = path.join(root, "UPCOMING_CHANGELOG.md")
const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    from: { type: "string", short: "f" },
    to: { type: "string", short: "t" },
    model: { type: "string", short: "m" },
    variant: { type: "string", default: "low" },
    quiet: { type: "boolean", default: false },
    print: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
})
const args = [...positionals]

if (values.from) args.push("--from", values.from)
if (values.to) args.push("--to", values.to)

if (values.help) {
  console.log(`
Usage: bun script/changelog.ts [options]

Generates UPCOMING_CHANGELOG.md by running the opencode changelog command.

Options:
  -f, --from <version>   Starting version (default: latest non-draft GitHub release)
  -t, --to <ref>         Ending ref (default: HEAD)
  -m, --model <id>       Model as provider/model (default: $CHANGELOG_MODEL, else whatever
                         provider is configured — any vendor with its API key set works)
      --variant <name>   Thinking variant for opencode run (default: low)
      --quiet            Suppress opencode command output unless it fails
      --print            Print the generated UPCOMING_CHANGELOG.md after success
  -h, --help             Show this help message

Examples:
  bun script/changelog.ts
  bun script/changelog.ts --from 1.0.200
  bun script/changelog.ts -f 1.0.200 -t 1.0.205
`)
  process.exit(0)
}

await rm(file, { force: true })

const quiet = values.quiet
const cmd = ["opencode", "run"]
// Provider-agnostic by design: no vendor is required. Any provider whose API key is present in
// the environment is auto-detected (see provider.ts — a provider is available when any of its
// declared env vars is set), so this works with Anthropic, OpenAI, Google, a local model, or
// OpenCode Zen equally. `--model provider/model` pins one explicitly; leaving it unset uses
// whatever is configured. CHANGELOG_MODEL lets CI choose without editing this script.
const model = values.model ?? process.env.CHANGELOG_MODEL
if (model) cmd.push("--model", model)
cmd.push("--variant", values.variant)
cmd.push("--command", "changelog", "--", ...args)

const proc = Bun.spawn(cmd, {
  cwd: root,
  stdin: "inherit",
  stdout: quiet ? "pipe" : "inherit",
  stderr: quiet ? "pipe" : "inherit",
})

const [out, err] = quiet
  ? await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  : ["", ""]
const code = await proc.exited
if (code === 0) {
  if (values.print) process.stdout.write(await Bun.file(file).text())
  process.exit(0)
}

if (quiet) {
  if (out) process.stdout.write(out)
  if (err) process.stderr.write(err)
}

process.exit(code)
