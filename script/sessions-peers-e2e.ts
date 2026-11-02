#!/usr/bin/env bun

// XCOD-234 end-to-end, through lunos itself: two `lunos serve` processes on this machine (A runs a
// session, B plays the Sessions window), a throwaway HOME and XDG dirs, the file credential store,
// LUNOS_OFFLINE, and a local fake model only. Checks AC1 (B sees A's session waiting and running),
// AC2 (B stops it through A), AC3 (B answers A's permission; A audits it, B doesn't) and AC5 (after
// kill -9 on A, B shows the session stale).
//
//   bun script/sessions-peers-e2e.ts        exits 1 if any check fails
import { $ } from "bun"
import fs from "fs/promises"
import os from "os"
import path from "path"

const repo = path.resolve(import.meta.dir, "..")
const entry = path.join(repo, "packages/opencode/src/index.ts")
const MODEL_PORT = 18234
const A_PORT = 18235
const B_PORT = 18236

// A fake OpenAI-compatible model: asks to run `sleep 30` with bash until it sees a tool result.
let requests = 0
const chunk = (payload: object) =>
  `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...payload })}\n\n`
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: MODEL_PORT,
  async fetch(req) {
    const body = (await req.json()) as { messages: Array<{ role: string }> }
    requests++
    // Asks once per user message: a tool result after the latest user message means it was answered.
    const lastUser = body.messages.map((m) => m.role).lastIndexOf("user")
    const answered = body.messages.slice(lastUser + 1).some((m) => m.role === "tool")
    const parts = answered
      ? [
          chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        ]
      : [
          chunk({
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "bash",
                        arguments: JSON.stringify({ command: "sleep 30", description: "Wait" }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
        ]
    return new Response(
      parts.join("") +
        chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }) +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})

const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-e2e234-")))
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local/share"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_STATE_HOME: path.join(home, ".local/state"),
  LUNOS_CLOUD_STORE: "file",
  LUNOS_OFFLINE: "1",
  OPENCODE_SERVER_PASSWORD: "",
}
console.log(
  "env:",
  JSON.stringify({ HOME: env.HOME, XDG_DATA_HOME: env.XDG_DATA_HOME, LUNOS_CLOUD_STORE: env.LUNOS_CLOUD_STORE }),
)

async function project(name: string) {
  const dir = path.join(home, name)
  await fs.mkdir(dir, { recursive: true })
  await $`git init -q .`.cwd(dir).quiet()
  const audit = path.join(home, `audit-${name}.log`)
  await Bun.write(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      model: "local/m",
      permission: { bash: "ask" },
      audit: { enabled: true, path: audit },
      provider: {
        local: {
          npm: "@ai-sdk/openai-compatible",
          name: "Local",
          options: { baseURL: `http://127.0.0.1:${MODEL_PORT}/v1`, apiKey: "unused" },
          models: { m: { name: "m", tool_call: true } },
        },
      },
    }),
  )
  return { dir, audit }
}

const a = await project("a")
const b = await project("b")
const serve = (dir: string, port: number) =>
  Bun.spawn(["bun", "run", entry, "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: dir,
    env,
    stdout: "ignore",
    stderr: "pipe",
  })
// One at a time: two first starts on a fresh data dir race on the database migration.
const A = serve(a.dir, A_PORT)
let B: ReturnType<typeof serve> = undefined as never

const api = async (port: number, dir: string, method: string, p: string, body?: unknown) => {
  const url = new URL(`http://127.0.0.1:${port}${p}`)
  url.searchParams.set("directory", dir)
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : undefined }
}
const until = async <T>(what: string, fn: () => Promise<T | undefined>, ms = 30_000) => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await Bun.sleep(250)
  }
}
const overviewOnB = async (id: string) =>
  (await api(B_PORT, b.dir, "GET", "/experimental/session-overview")).json?.sessions?.find(
    (s: { id: string }) => s.id === id,
  )
const results: Record<string, unknown> = {}
const check = (name: string, ok: boolean, detail?: unknown) => {
  results[name] = ok ? "PASS" : { FAIL: detail }
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : JSON.stringify(detail))
}

try {
  await until("A up", async () => (await fetch(`http://127.0.0.1:${A_PORT}/global/health`)).ok || undefined, 120_000)
  B = serve(b.dir, B_PORT)
  await until("B up", async () => (await fetch(`http://127.0.0.1:${B_PORT}/global/health`)).ok || undefined, 120_000)
  const session = (await api(A_PORT, a.dir, "POST", "/session", { title: "E2E 234" })).json
  const id = session.id as string
  await api(A_PORT, a.dir, "POST", `/session/${id}/prompt_async`, { parts: [{ type: "text", text: "wait please" }] })

  // AC1: B (another process) shows A's session waiting for approval, as another Lunos's.
  const t0 = Date.now()
  const waiting = await until("B sees waiting", async () => {
    const row = await overviewOnB(id)
    return row?.state === "waiting" && row?.elsewhere ? row : undefined
  })
  check("AC1 B shows A's session waiting (elsewhere) with 1 permission", waiting.permissions === 1, waiting)
  console.log(`  seen in ${Date.now() - t0} ms after A asked (bounded by model + start)`)

  // AC3: B lists and answers the ask; A checks and audits it.
  const asks = await api(B_PORT, b.dir, "GET", `/experimental/peer/${id}/asks`)
  const ask = asks.json?.permissions?.[0]
  check("AC3 B lists A's pending permission", asks.status === 200 && ask?.permission === "bash", asks)
  const reply = await api(B_PORT, b.dir, "POST", `/experimental/peer/${id}/permission/${ask.id}/reply`, {
    reply: "once",
  })
  check("AC3 B's answer accepted", reply.status === 200 && reply.json === true, reply)
  const auditA = await until(
    "A audited",
    async () => {
      const text = await fs.readFile(a.audit, "utf8").catch(() => "")
      return text.includes('"permission.decision"') ? text : undefined
    },
    10_000,
  ).catch(() => "")
  const decision = auditA
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.event === "permission.decision")
  check("AC3 A's audit log has permission.decision (once)", !!decision, decision)
  const auditB = await fs.readFile(b.audit, "utf8").catch(() => "")
  check("AC3 B's audit log has no permission.decision", !auditB.includes('"permission.decision"'), auditB.slice(0, 300))

  // AC2: the approved `sleep 30` runs; B stops it through A.
  const running = await until("B sees running", async () => {
    const row = await overviewOnB(id)
    return row?.state === "running" && row?.elsewhere ? row : undefined
  })
  check("AC1 B shows A's session running (elsewhere)", !!running, running)
  const stop = await api(B_PORT, b.dir, "POST", `/experimental/peer/${id}/stop`)
  check("AC2 B's stop accepted", stop.status === 200 && stop.json === true, stop)
  const stopped = await until(
    "A idle",
    async () => {
      const st = (await api(A_PORT, a.dir, "GET", "/session/status")).json
      return st && !st[id] ? true : undefined
    },
    10_000,
  ).catch(() => false)
  check("AC2 A's session is no longer busy", stopped === true)
  const afterStop = await until(
    "B not running",
    async () => {
      const row = await overviewOnB(id)
      return row && row.state !== "running" && row.state !== "waiting" ? row : undefined
    },
    10_000,
  ).catch(() => undefined)
  check("AC2 B shows it stopped (not running/waiting)", !!afterStop, afterStop)

  // AC5: a new turn in A, then kill -9 A: B shows it stale, not running, within the timeout.
  await api(A_PORT, a.dir, "POST", `/session/${id}/prompt_async`, { parts: [{ type: "text", text: "again" }] })
  await until("B sees waiting again", async () => ((await overviewOnB(id))?.state === "waiting" ? true : undefined))
  A.kill("SIGKILL")
  await A.exited
  const t1 = Date.now()
  const stale = await until(
    "B sees stale",
    async () => {
      const row = await overviewOnB(id)
      return row?.stale ? row : undefined
    },
    15_000,
  ).catch(() => undefined)
  check("AC5 after kill -9, B shows it stale (not running)", !!stale && stale.state !== "running", stale)
  if (stale) console.log(`  stale after ${Date.now() - t1} ms`)
  const gone = await api(B_PORT, b.dir, "POST", `/experimental/peer/${id}/stop`)
  check("after kill -9, stop says nobody runs it (404)", gone.status === 404, gone)
} catch (error) {
  console.log("ERROR", error instanceof Error ? error.message : error)
  // Kill first: reading a live process's stderr waits for it to exit.
  A.kill("SIGKILL")
  console.log("A stderr:", (await new Response(A.stderr).text().catch(() => "")).slice(-1500))
} finally {
  A.kill("SIGKILL")
  B?.kill("SIGKILL")
  model.stop(true)
  console.log("model requests:", requests)
  console.log(JSON.stringify(results, null, 2))
  await fs.rm(home, { recursive: true, force: true })
}
const failed = Object.values(results).filter((r) => r !== "PASS").length
if (failed || Object.keys(results).length < 11) process.exit(1)
