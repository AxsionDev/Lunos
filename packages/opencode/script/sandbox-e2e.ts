#!/usr/bin/env bun
// XCOD-158: end-to-end check of sandboxed runs on a real container runtime. A scripted
// OpenAI-compatible model on this machine stands in for the provider, so no API key or outside
// network is needed. Each scenario runs `lunos run --sandbox` from source, under a throwaway HOME
// and XDG dirs, against a fresh git project, then checks what came back to the host.
//
//   bun run script/sandbox-e2e.ts [--runtime docker|podman] [--image lunos-sandbox:local] [--model-host <host>]
//
// Build the image first: `bun run script/sandbox-image.ts`. Used by .github/workflows/sandbox-e2e.yml
// (Linux: Docker Engine and rootless Podman) and script/sandbox-e2e.ps1 (Windows: Docker Desktop).
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SandboxDocker } from "../src/sandbox/docker"

const dir = path.resolve(import.meta.dirname, "..")
const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : undefined
}
const runtime = (arg("runtime") ?? "docker") as "docker" | "podman"
const image = arg("image") ?? "lunos-sandbox:local"
// How a container reaches this machine: Docker Desktop and Podman name it; Docker Engine on Linux
// has no such name unless the container is started with --add-host=host.docker.internal:host-gateway.
const modelHost = arg("model-host") ?? (runtime === "podman" ? "host.containers.internal" : "host.docker.internal")

type Step = { tool: string; args: Record<string, unknown> } | { text: string }
let script: Step[] = []

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })

// The step is chosen by how many tool results the conversation already holds. Requests without
// tools (title generation) get plain text.
const model = Bun.serve({
  port: 0,
  hostname: "0.0.0.0",
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await req.json()) as { messages: { role: string }[]; tools?: unknown[] }
    const done = body.messages.filter((message) => message.role === "tool").length
    const step: Step = body.tools?.length ? (script[done] ?? { text: "done" }) : { text: "sandbox task" }
    const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" }
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
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

const KINDS = ["container", "volume", "network"] as const
/** Sandbox containers, volumes and networks on this runtime, by id. */
async function leftovers() {
  const ids = (text: string) => text.split("\n").filter(Boolean)
  const filter = (kind: string) => `label=${kind === "network" ? `${SandboxDocker.LABEL}.net` : SandboxDocker.LABEL}`
  return {
    container: ids(await $`${runtime} ps -a -q --filter ${filter("container")}`.nothrow().quiet().text()),
    volume: ids(await $`${runtime} volume ls -q --filter ${filter("volume")}`.nothrow().quiet().text()),
    network: ids(await $`${runtime} network ls -q --filter ${filter("network")}`.nothrow().quiet().text()),
  }
}
// Sandboxes from earlier runs on this machine aren't this run's to account for.
const before = await leftovers()

const root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-sandbox-e2e-"))
const failures: string[] = []
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? `\n     ${detail}` : ""}`)
  if (!ok) failures.push(name)
}

async function project(name: string, sandbox: Record<string, unknown>) {
  const proj = path.join(root, name, "proj")
  await fs.mkdir(proj, { recursive: true })
  await Bun.write(path.join(proj, "a.txt"), "one\n")
  await Bun.write(
    path.join(proj, "opencode.json"),
    JSON.stringify({
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake",
          options: { baseURL: `http://${modelHost}:${model.port}/v1`, apiKey: "{env:FAKE_API_KEY}" },
          models: { m: { name: "m", tool_call: true } },
        },
      },
      model: "fake/m",
      sandbox: { image, runtime, ...sandbox },
    }),
  )
  await $`git init -q && git add -A && git -c user.email=e2e@lunos -c user.name=e2e commit -qm init`.cwd(proj).quiet()
  return proj
}

// Rootless Podman finds its images and state through HOME and the XDG dirs, which the throwaway
// ones below would hide: link its real store and config into them, so the image loaded before the
// run is there.
async function podmanStore(home: string): Promise<Record<string, string>> {
  if (runtime !== "podman") return {}
  const real = os.homedir()
  for (const [from, to] of [
    [
      path.join(process.env.XDG_DATA_HOME ?? path.join(real, ".local", "share"), "containers"),
      path.join(home, "data", "containers"),
    ],
    [
      path.join(process.env.XDG_CONFIG_HOME ?? path.join(real, ".config"), "containers"),
      path.join(home, "cfg", "containers"),
    ],
  ])
    if (await fs.exists(from)) await fs.symlink(from, to).catch(() => {})
  return process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}
}

async function run(name: string, proj: string, steps: Step[], env: Record<string, string> = {}) {
  script = steps
  const home = path.join(root, name, "home")
  for (const sub of ["", "cfg", "data", "state", "cache"]) await fs.mkdir(path.join(home, sub), { recursive: true })
  const proc = Bun.spawn(["bun", "run", path.join(dir, "src", "index.ts"), "run", "--sandbox", "do the task"], {
    cwd: proj,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, "cfg"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      FAKE_API_KEY: "sk-e2e-0123456789abcdef",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      ...(await podmanStore(home)),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300_000,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const output = stdout + stderr
  if (process.env.SANDBOX_E2E_VERBOSE) console.log(output)
  return { code, output, home }
}

async function results(proj: string) {
  const base = path.join(proj, ".opencode", "sandbox")
  const ids = await fs.readdir(base).catch(() => [] as string[])
  const id = ids.find((entry) => !entry.startsWith("."))
  if (!id) return undefined
  const summary = (await Bun.file(path.join(base, id, "summary.json"))
    .json()
    .catch(() => undefined)) as Record<string, any> | undefined
  const transcript = await Bun.file(path.join(base, id, "transcript.json"))
    .text()
    .catch(() => "")
  return { id, dir: path.join(base, id), summary, transcript }
}

const edit = (extra = "") => ({
  tool: "bash",
  args: {
    command: `echo edited >> a.txt && echo new > c.txt && touch "$HOME/escaped"${extra}`,
    description: "edit the files",
  },
})

try {
  console.log(`runtime ${runtime}, image ${image}, model at ${modelHost}:${model.port}`)
  console.log(`${runtime}: ${(await $`${runtime} --version`.nothrow().text()).trim()}`)

  // 1. Branch results under the network policy: the agent's edits come back as a branch, the host
  // tree and HOME are untouched, and an outside host is refused.
  {
    const proj = await project("branch", {})
    const res = await run("branch", proj, [
      edit(`; curl -sS -m 10 -o /dev/null https://example.com; echo "CURL_EXIT=$?"`),
      { text: "done" },
    ])
    const out = await results(proj)
    check("branch: run exits 0", res.code === 0, res.output.slice(-2000))
    check("branch: summary names a branch", typeof out?.summary?.branch === "string", JSON.stringify(out?.summary))
    const branch = out?.summary?.branch as string | undefined
    const shown = branch ? await $`git show ${branch}:c.txt`.cwd(proj).nothrow().quiet().text() : ""
    check("branch: the agent's new file is on the branch", shown === "new\n", shown)
    const edited = branch ? await $`git show ${branch}:a.txt`.cwd(proj).nothrow().quiet().text() : ""
    check("branch: the agent's edit is on the branch", edited === "one\nedited\n", edited)
    check("branch: the host working tree is untouched", (await Bun.file(path.join(proj, "a.txt")).text()) === "one\n")
    check("branch: nothing was written to the host HOME", !(await Bun.file(path.join(res.home, "escaped")).exists()))
    // The transcript holds the command too, so match curl's exit code, which only the output has.
    // 127 is a missing curl, not a refusal.
    const curl = out?.transcript.match(/CURL_EXIT=(\d+)/)?.[1]
    check("branch: outside hosts are refused", !!curl && curl !== "0" && curl !== "127", `curl exit ${curl}`)
  }

  // 2. Patch results: only the agent's changes, as a patch that applies; no branch is made.
  {
    const proj = await project("patch", { results: "patch" })
    const res = await run("patch", proj, [edit(), { text: "done" }])
    const out = await results(proj)
    check("patch: run exits 0", res.code === 0, res.output.slice(-2000))
    const patch = out ? path.join(out.dir, "changes.patch") : ""
    check("patch: changes.patch exists", !!patch && (await Bun.file(patch).exists()))
    const branches = await $`git branch --list ${"lunos/sandbox/*"}`.cwd(proj).quiet().text()
    check("patch: no branch is made", branches.trim() === "", branches)
    const applies = patch ? await $`git apply --check ${patch}`.cwd(proj).nothrow().quiet() : undefined
    check("patch: the patch applies to the host tree", applies?.exitCode === 0, applies?.stderr.toString())
  }

  // 3. No runtime on PATH: a clear error, and nothing runs on the host.
  {
    const proj = await project("noruntime", {})
    const bin = path.join(root, "noruntime", "bin")
    await fs.mkdir(bin, { recursive: true })
    for (const tool of ["bun", "git"]) {
      const found = Bun.which(tool)
      if (found) await fs.symlink(found, path.join(bin, path.basename(found)))
    }
    const res = await run("noruntime", proj, [edit(), { text: "done" }], { PATH: bin })
    check("no runtime: run fails", res.code !== 0)
    check(
      "no runtime: the error says neither runtime is available",
      res.output.includes("Nothing was run on this machine"),
      res.output.slice(-1000),
    )
    check("no runtime: the host tree is untouched", !(await Bun.file(path.join(proj, "c.txt")).exists()))
  }

  // 4. on_finish "destroy" (the default) leaves nothing behind.
  const after = await leftovers()
  for (const kind of KINDS) {
    const left = after[kind].filter((id) => !before[kind].includes(id))
    check(`cleanup: no sandbox ${kind}s are left`, left.length === 0, left.join(" "))
  }
} finally {
  model.stop(true)
  await fs.rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks passed")
process.exit(failures.length ? 1 : 0)
