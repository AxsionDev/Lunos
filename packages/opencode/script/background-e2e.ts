#!/usr/bin/env bun
// XCOD-288: end-to-end check of background commands on the live path: `lunos run` from source (the
// v1 session loop with the real shell and process tools), driven by a scripted OpenAI-compatible
// model on 127.0.0.1, against a tiny Bun app. No API key or outside network is needed.
//
//   bun run script/background-e2e.ts
//
// Scenarios: (A) start in the background, wait until ready, curl it, stop it; (B) left running by
// the agent, then `lunos run` exits; (C) Lunos SIGKILLed while the server runs. After each, nothing
// may still listen on the port and no process of it may be left. macOS and Linux (needs lsof).
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const opencode = path.resolve(import.meta.dirname, "..")
const PORT = 4319

type Req = { messages: { role: string; content: unknown }[]; tools?: { function: { name: string; parameters: any } }[] }
type Step = { tool: string; args: Record<string, unknown> } | { text: string } | { hang: true }
let script: ((req: Req) => Step)[] = []
const seen: { system: string; tools: string[]; bashParams: string[] }[] = []
let requests = 0

const toolResults = (req: Req) =>
  req.messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
const bgId = (req: Req) =>
  toolResults(req)
    .join("\n")
    .match(/Background process (bg_[0-9a-f]+)/)?.[1] ?? "missing"

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })

const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await req.json()) as Req
    const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" }
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    if (!body.tools?.length)
      return sse([
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "bg e2e" }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
      ])
    requests++
    const system = body.messages
      .filter((m) => m.role === "system")
      .map((m) => String(m.content))
      .join("\n")
    const bash = body.tools.find((t) => t.function.name === "bash")
    seen.push({
      system,
      tools: body.tools.map((t) => t.function.name),
      bashParams: Object.keys(bash?.function.parameters?.properties ?? {}),
    })
    const done = toolResults(body).length
    const step = script[done]?.(body) ?? { text: "done" }
    if ("hang" in step) {
      await Bun.sleep(120_000)
      return new Response("late", { status: 500 })
    }
    if ("tool" in step)
      return sse([
        {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${done}`,
                    type: "function",
                    function: { name: step.tool, arguments: JSON.stringify(step.args) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
      ])
    return sse([
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
    ])
  },
})

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-bg-e2e-"))
const fixture = path.join(root, "fixture")
await fs.mkdir(fixture, { recursive: true })
await Bun.write(
  path.join(fixture, "server.ts"),
  `const server = Bun.serve({ port: Number(process.env.PORT ?? ${PORT}), hostname: "127.0.0.1", fetch: (req) => new URL(req.url).pathname === "/" ? new Response("fixture app") : new Response("not found", { status: 404 }) })
console.log("listening on http://127.0.0.1:" + server.port)
`,
)
await Bun.write(
  path.join(fixture, "package.json"),
  JSON.stringify({ name: "fixture-app", private: true, scripts: { dev: "bun run server.ts" } }),
)
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `\n     ${detail.replaceAll("\n", "\n     ")}` : ""}`)
  if (!ok) failures.push(name)
}

/** Probe that proves it ran: prints the raw lsof result and its exit code. */
async function listeners() {
  const r = await $`lsof -nP -iTCP:${PORT} -sTCP:LISTEN`.nothrow().quiet()
  return { exit: r.exitCode, text: r.stdout.toString().trim() }
}
async function serverProcs() {
  const r = await $`ps -axo pid,pgid,command`.nothrow().quiet()
  return r.stdout
    .toString()
    .split("\n")
    .filter((l) => l.includes("server.ts") || l.includes("__lunos_parent"))
    .filter((l) => !l.includes("ps -axo"))
}

async function project(name: string) {
  const proj = path.join(root, name, "proj")
  await fs.mkdir(proj, { recursive: true })
  await $`cp -R ${fixture}/. ${proj}`.quiet()
  await $`git init -q && git add -A && git -c user.email=e2e@lunos -c user.name=e2e commit -qm init`.cwd(proj).quiet()
  await Bun.write(
    path.join(proj, "opencode.json"),
    JSON.stringify({
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake",
          options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "{env:FAKE_API_KEY}" },
          models: { m: { name: "m", tool_call: true } },
        },
      },
      model: "fake/m",
    }),
  )
  const home = path.join(root, name, "home")
  for (const sub of ["", "cfg", "data", "state", "cache"]) await fs.mkdir(path.join(home, sub), { recursive: true })
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "cfg"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    FAKE_API_KEY: "sk-e2e-0123456789abcdef",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    SHELL: process.platform === "darwin" ? "/bin/zsh" : "/bin/bash",
  }
  return { proj, env }
}

function lunos(proj: string, env: Record<string, string>) {
  return Bun.spawn(
    ["bun", "run", path.join(opencode, "src", "index.ts"), "run", "--format", "json", "build the health route"],
    {
      cwd: proj,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 240_000,
    },
  )
}

const start = () => ({
  tool: "bash",
  args: {
    command: `PORT=${PORT} bun run dev`,
    background: true,
    ready_url: `http://127.0.0.1:${PORT}/`,
    timeout: 20000,
  },
})
const curl = () => ({ tool: "bash", args: { command: `curl -s -w " HTTP=%{http_code}" http://127.0.0.1:${PORT}/` } })

function toolOutputs(stdout: string) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return undefined
      }
    })
    .filter((e) => e?.type === "tool_use")
    .map((e) => ({
      tool: e.part?.tool,
      status: e.part?.state?.status,
      output: String(e.part?.state?.output ?? e.part?.state?.error ?? ""),
    }))
}

const pre = await listeners()
check("port is free before the scenarios (lsof exit 1 = nothing)", pre.exit === 1, `lsof exit=${pre.exit} ${pre.text}`)

// A: start in the background, check it, stop it.
{
  console.log("\n# A: start, verify, stop")
  script = [
    () => start(),
    () => curl(),
    (req) => ({ tool: "process", args: { action: "stop", id: bgId(req) } }),
    () => ({ text: "Verified: / answered 200; stopped the server." }),
  ]
  const { proj, env } = await project("a")
  const proc = lunos(proj, env)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const outs = toolOutputs(stdout)
  check("lunos run exited 0", code === 0, code === 0 ? "" : stderr.slice(-2000))
  for (const o of outs) console.log(`     [${o.tool} ${o.status}] ${o.output.split("\n").slice(0, 6).join(" | ")}`)
  check(
    "bash background start returned once ready",
    outs[0]?.tool === "bash" && /answered HTTP 200/.test(outs[0].output),
  )
  check(
    "bash reported where it listens (127.0.0.1 only)",
    /Listening on: 127\.0\.0\.1:4319\./.test(outs[0]?.output ?? ""),
  )
  check("curl hit the running server while the turn went on", /fixture app HTTP=200/.test(outs[1]?.output ?? ""))
  check("process tool stopped it", outs[2]?.tool === "process" && /: stopped\./.test(outs[2].output))
  const post = await listeners()
  check("port free after the run", post.exit === 1, `lsof exit=${post.exit} ${post.text}`)
  const first = seen[0]
  check("system prompt carries 'Finish with proof' (build agent)", !!first?.system.includes("# Finish with proof"))
  check("model is offered the process tool", !!first?.tools.includes("process"), first?.tools.join(","))
  check(
    "bash schema has background + ready_url",
    !!first && ["background", "ready_url"].every((p) => first.bashParams.includes(p)),
    first?.bashParams.join(","),
  )
}

// B: started and NOT stopped by the agent: it must not outlive `lunos run`.
{
  console.log("\n# B: left running by the agent; lunos run exits")
  script = [() => start(), () => curl(), () => ({ text: "done, left it running" })]
  const { proj, env } = await project("b")
  const proc = lunos(proj, env)
  const [stdout, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const outs = toolOutputs(stdout)
  check("lunos run exited 0", code === 0)
  check("server was up during the run", /fixture app HTTP=200/.test(outs[1]?.output ?? ""))
  const post = await listeners()
  check("port free right after lunos exits", post.exit === 1, `lsof exit=${post.exit} ${post.text}`)
  const procs = await serverProcs()
  check("no fixture/watchdog processes left", procs.length === 0, procs.join("\n"))
}

// C: lunos is SIGKILLed while the server runs: the in-group watchdog must take it down.
{
  console.log("\n# C: lunos SIGKILLed mid-turn")
  script = [() => start(), () => ({ hang: true })]
  const { proj, env } = await project("c")
  const before = requests
  const proc = lunos(proj, env)
  const deadline = Date.now() + 60_000
  while (requests < before + 2 && Date.now() < deadline) await Bun.sleep(200)
  const up = await listeners()
  check("server up before the kill", up.exit === 0, up.text)
  proc.kill("SIGKILL")
  await proc.exited
  const killedAt = Date.now()
  let post = await listeners()
  while (post.exit === 0 && Date.now() - killedAt < 10_000) {
    await Bun.sleep(250)
    post = await listeners()
  }
  check(
    `port freed ${((Date.now() - killedAt) / 1000).toFixed(1)}s after SIGKILL of lunos`,
    post.exit === 1,
    `lsof exit=${post.exit} ${post.text}`,
  )
  let procs = await serverProcs()
  while (procs.length && Date.now() - killedAt < 10_000) {
    await Bun.sleep(250)
    procs = await serverProcs()
  }
  check(
    `no fixture/watchdog processes left ${((Date.now() - killedAt) / 1000).toFixed(1)}s after the kill`,
    procs.length === 0,
    procs.join("\n"),
  )
}

model.stop(true)
console.log(`\n${failures.length ? `FAILED: ${failures.join(", ")}` : "all checks passed"}`)
process.exit(failures.length ? 1 : 0)
