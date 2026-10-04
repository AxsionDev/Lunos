#!/usr/bin/env bun

// XCOD-121: proves LUNOS_OFFLINE. Runs `lunos run` from source under `strace -f -e trace=connect`
// against a local mock model endpoint, and fails if any connect() goes anywhere else: other hosts,
// DNS lookups, or subprocesses such as npm, uv or git. Linux only (needs strace).
//
//   bun script/offline-egress.ts            offline run; exit 1 on any other destination
//   bun script/offline-egress.ts --online   also run without the switch and list what it contacts
//
// XCOD-174: with --online it also proves no default path reaches upstream's services. CI points
// upstream's hostnames at SINKHOLE in /etc/hosts (`--hosts-line` prints the entry), then a normal
// `lunos run` and a `lunos github run` dry run must make no connection to it.

import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"

const root = path.resolve(import.meta.dir, "..")
const PORT = 18080
const ALLOWED = `127.0.0.1:${PORT}`
export const SINKHOLE = "127.0.0.9"
const UPSTREAM = ["opencode", "ai"].join(".")
/** Upstream hostnames Lunos has called or linked; resolved to SINKHOLE in CI. */
export const UPSTREAM_HOSTS = ["", "api.", "app.", "models.", "dev.", "docs.", "stats."].map((sub) => sub + UPSTREAM)

/** connect() destinations in an strace log, except unix sockets and the allowed endpoint. */
export function destinations(trace: string, allowed = ALLOWED) {
  const hits = new Map<string, number>()
  for (const line of trace.split("\n")) {
    const match =
      line.match(/sin_port=htons\((\d+)\), sin_addr=inet_addr\("([\d.]+)"\)/) ??
      line.match(/sin6_port=htons\((\d+)\).*inet_pton\(AF_INET6, "([^"]+)"/)
    if (!match) continue
    const target = `${match[2]}:${match[1]}`
    if (target !== allowed) hits.set(target, (hits.get(target) ?? 0) + 1)
  }
  return Object.fromEntries(hits)
}

/** An OpenAI-compatible endpoint that streams one fixed answer. */
function mock() {
  const chunk = (payload: object) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...payload })}\n\n`
  return Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    fetch() {
      const body =
        chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "offline ok" }, finish_reason: null }] }) +
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
        chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) +
        "data: [DONE]\n\n"
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    },
  })
}

async function run(label: string, offline: boolean, args = ["run", "Reply with the words offline ok"]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `lunos-egress-${label}-`))
  const work = path.join(home, "work")
  await fs.mkdir(work, { recursive: true })
  await Bun.write(path.join(work, "a.ts"), "export const a = 1\n")
  await $`git init -q .`.cwd(work).quiet()
  const trace = path.join(home, "trace.txt")
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "local/m",
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local",
          options: { baseURL: `http://${ALLOWED}/v1`, apiKey: "unused" },
          models: { m: { name: "m", tool_call: true } },
        },
      },
    }),
  }
  if (offline) env.LUNOS_OFFLINE = "1"
  else delete env.LUNOS_OFFLINE
  const result =
    await $`strace -f -qq -e trace=connect -o ${trace} bun run ${path.join(root, "packages/opencode/src/index.ts")} ${args}`
      .cwd(work)
      .env(env)
      .quiet()
      .nothrow()
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    trace: await Bun.file(trace).text(),
  }
}

/** Connections to SINKHOLE in an strace log: requests that would have reached upstream. */
export function upstreamHits(trace: string) {
  return Object.entries(destinations(trace)).filter(([target]) => target.startsWith(`${SINKHOLE}:`))
}

/** A `lunos github run` dry run: a fake issue comment, so it stops at GitHub's API (fake token). */
const GITHUB_DRY_RUN = [
  "github",
  "run",
  "--token",
  "dry-run",
  "--event",
  JSON.stringify({
    eventName: "issue_comment",
    repo: { owner: "lunos-egress", repo: "dry-run" },
    actor: "lunos-egress",
    payload: { issue: { number: 1 }, comment: { id: 1, body: "/lunos hello" } },
  }),
]

if (import.meta.main && process.argv.includes("--hosts-line")) {
  console.log(`${SINKHOLE} ${UPSTREAM_HOSTS.join(" ")}`)
} else if (import.meta.main) {
  if (process.platform !== "linux") throw new Error("offline-egress: needs Linux and strace")
  const server = mock()
  try {
    const offline = await run("offline", true)
    const reached = offline.trace.includes(`htons(${PORT})`)
    const other = destinations(offline.trace)
    console.log(`offline run: exit ${offline.exitCode}, answer ${JSON.stringify(offline.stdout.trim())}`)
    console.log(`  reached the model endpoint: ${reached}`)
    console.log(`  other destinations: ${JSON.stringify(other)}`)
    let upstream: [string, number][] = []
    if (process.argv.includes("--online")) {
      const online = await run("online", false)
      console.log(`online run: exit ${online.exitCode}; destinations: ${JSON.stringify(destinations(online.trace))}`)
      process.env.MODEL = "local/m"
      process.env.GITHUB_RUN_ID = "1"
      const github = await run("github", false, GITHUB_DRY_RUN)
      console.log(
        `github dry run: exit ${github.exitCode}; destinations: ${JSON.stringify(destinations(github.trace))}`,
      )
      upstream = [...upstreamHits(online.trace), ...upstreamHits(github.trace)]
      console.log(`  connections to upstream (${SINKHOLE}): ${JSON.stringify(upstream)}`)
      if (upstream.length > 0)
        console.error(`offline-egress: FAILED. A default run reached upstream (${UPSTREAM_HOSTS.join(", ")})`)
    }
    if (upstream.length > 0) process.exit(1)
    const failed = offline.exitCode !== 0 || !reached || Object.keys(other).length > 0
    if (failed) {
      console.error(offline.stderr.slice(-4000))
      console.error(
        "offline-egress: FAILED. With LUNOS_OFFLINE=1, Lunos contacted something other than the model endpoint",
      )
      process.exit(1)
    }
    console.log("offline-egress: ok. With LUNOS_OFFLINE=1 the only connection was the model endpoint")
  } finally {
    server.stop(true)
  }
}
