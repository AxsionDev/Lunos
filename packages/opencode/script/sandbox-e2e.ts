#!/usr/bin/env bun
// XCOD-158: end-to-end check of sandboxed runs on a real container runtime. A scripted
// OpenAI-compatible model on this machine stands in for the provider, so no API key or outside
// network is needed. Each scenario runs `lunos run --sandbox` from source, under a throwaway HOME
// and XDG dirs, against a fresh git project, then checks what came back to the host.
//
//   bun run script/sandbox-e2e.ts [--runtime docker|podman] [--image lunos-sandbox:local] [--model-host <host>] [--lunos <binary>]
//
// Build the image first: `bun run script/sandbox-image.ts`. Used by .github/workflows/sandbox-e2e.yml
// (Linux: Docker Engine and rootless Podman) and script/sandbox-e2e.ps1 (Windows: Docker Desktop).
import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { SandboxDocker } from "../src/sandbox/docker"

const dir = path.resolve(import.meta.dirname, "..")
const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : undefined
}
const runtime = (arg("runtime") ?? "docker") as "docker" | "podman"
// `--only fastexit,branch`: just those scenarios (by the names in `want(...)` below).
const only = arg("only")?.split(",")
const want = (name: string) => !only || only.includes(name)
const image = arg("image") ?? "lunos-sandbox:local"
// XCOD-321: `--lunos <binary>` runs an installed build on the host instead of the source.
const lunos = arg("lunos") ? [arg("lunos")!] : ["bun", "run", path.join(dir, "src", "index.ts")]
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
      // The scripted model calls bash itself; with dynamic workflows (XCOD-303) Build has no bash.
      workflows: { dynamic: false },
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

/** A throwaway HOME and XDG dirs for one scenario, and the environment that points Lunos at them. */
async function sandboxEnv(name: string, env: Record<string, string> = {}) {
  const home = path.join(root, name, "home")
  for (const sub of ["", "cfg", "data", "state", "cache"]) await fs.mkdir(path.join(home, sub), { recursive: true })
  return {
    home,
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
  }
}

async function run(name: string, proj: string, steps: Step[], extra: Record<string, string> = {}) {
  script = steps
  const { home, env } = await sandboxEnv(name, extra)
  const proc = Bun.spawn([...lunos, "run", "--sandbox", "do the task"], {
    cwd: proj,
    env,
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
  if (want("branch")) {
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
  if (want("patch")) {
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
  if (want("noruntime")) {
    const proj = await project("noruntime", {})
    const bin = path.join(root, "noruntime", "bin")
    await fs.mkdir(bin, { recursive: true })
    // Copied, not linked: symlinks need Developer Mode on Windows. Git for Windows' git.exe finds
    // the rest of Git relative to itself, so there its own directory goes on PATH instead (it holds
    // no container runtime).
    const git = Bun.which("git")
    const gitDir = process.platform === "win32" && git ? [path.dirname(git)] : []
    for (const found of [Bun.which("bun"), gitDir.length ? undefined : git])
      if (found) await fs.copyFile(found, path.join(bin, path.basename(found)))
    const res = await run("noruntime", proj, [edit(), { text: "done" }], {
      PATH: [bin, ...gitDir].join(path.delimiter),
    })
    check("no runtime: run fails", res.code !== 0)
    check(
      "no runtime: the error says neither runtime is available",
      res.output.includes("Nothing was run on this machine"),
      res.output.slice(-1000),
    )
    check("no runtime: the host tree is untouched", !(await Bun.file(path.join(proj, "c.txt")).exists()))
  }

  // 4. `/sandbox` and `/sandbox end` in the TUI, through the same server calls the TUI makes: a host
  // server (experimental workspaces on) creates a docker workspace and warps a session into it; the
  // agent's tools run inside, with default permissions; copying file changes back is refused; ending
  // it brings the agent's change back as a branch.
  if (want("warp")) {
    const proj = await project("warp", {})
    const { env } = await sandboxEnv("warp", { OPENCODE_EXPERIMENTAL_WORKSPACES: "1" })
    const port = 20_000 + Math.floor(Math.random() * 10_000)
    // Its output goes to a file: an unread pipe fills up and then the server can't even exit.
    const serverLog = path.join(root, "warp", "server.log")
    const server = Bun.spawn([...lunos, "serve", "--port", String(port)], {
      cwd: proj,
      env,
      stdout: Bun.file(serverLog),
      stderr: Bun.file(serverLog),
    })
    try {
      const base = `http://127.0.0.1:${port}`
      for (let i = 0; i < 120; i++) {
        const up = await fetch(`${base}/session?directory=${encodeURIComponent(proj)}`).then(
          (response) => response.ok,
          () => false,
        )
        if (up) break
        await Bun.sleep(500)
      }
      const client = createOpencodeClient({ baseUrl: base, directory: proj })
      const session = await client.session.create({})
      const sessionID = session.data?.id
      check("warp: a session on the host", !!sessionID, JSON.stringify(session.error))
      const created = await client.experimental.workspace.create({ type: "docker", branch: null })
      const workspace = created.data
      check("warp: a sandbox workspace is created", workspace?.type === "docker", JSON.stringify(created.error))
      if (sessionID && workspace) {
        const into = await client.experimental.workspace.warp({ id: workspace.id, sessionID, copyChanges: false })
        check("warp: the session moves into the sandbox", !into.error, JSON.stringify(into.error))
        script = [
          {
            tool: "write",
            args: { filePath: path.posix.join(SandboxDocker.WORKSPACE, "w.txt"), content: "written in the sandbox\n" },
          },
          { tool: "bash", args: { command: 'echo "INSIDE=$LUNOS_SANDBOX"', description: "where am I" } },
          { text: "done" },
        ]
        const prompt = await client.session.prompt({
          sessionID,
          workspace: workspace.id,
          parts: [{ type: "text", text: "do the task" }],
        })
        check("warp: the prompt runs", !prompt.error, JSON.stringify(prompt.error))
        const messages = JSON.stringify((await client.session.messages({ sessionID })).data ?? [])
        const sandboxID = (workspace.extra as { sandbox?: string } | null)?.sandbox
        check("warp: the tool ran inside the sandbox", messages.includes(`INSIDE=${sandboxID}`))
        check("warp: nothing was written to the host tree", !(await Bun.file(path.join(proj, "w.txt")).exists()))
        const pending = (await client.permission.list()).data ?? []
        check("warp: default permissions asked nothing", pending.length === 0, JSON.stringify(pending))
        const copy = await client.experimental.workspace.warp({ id: null, sessionID, copyChanges: true })
        check("warp: copying file changes back is refused", !!copy.error, "the warp was allowed")
        const back = await client.experimental.workspace.warp({ id: null, sessionID, copyChanges: false })
        check("warp: the session comes back", !back.error, JSON.stringify(back.error))
        const removed = await client.experimental.workspace.remove({ id: workspace.id })
        check("warp: ending the sandbox succeeds", !removed.error, JSON.stringify(removed.error))
        const shown = await $`git show ${workspace.branch ?? ""}:w.txt`.cwd(proj).nothrow().quiet().text()
        check("warp: the agent's change is on the branch", shown === "written in the sandbox\n", shown)
      }
    } finally {
      server.kill()
      if ((await Promise.race([server.exited.then(() => true), Bun.sleep(10_000).then(() => false)])) === false)
        server.kill(9)
      await server.exited
      if (process.env.SANDBOX_E2E_VERBOSE)
        console.log(
          await Bun.file(serverLog)
            .text()
            .catch(() => ""),
        )
    }
  }

  // 5. workspace "mount", chosen in your global config (a repository can't): the agent's edit lands in
  // your working tree, owned by you; .git stays read-only; no branch is made; the warning is shown.
  if (want("mount")) {
    const proj = await project("mount", {})
    await Bun.write(
      path.join(root, "mount", "home", "cfg", "opencode", "opencode.json"),
      JSON.stringify({ sandbox: { workspace: "mount" } }),
    )
    const res = await run("mount", proj, [
      {
        tool: "bash",
        args: {
          command:
            'echo mounted > m.txt; (echo "exit 1" > .git/hooks/pre-commit && echo HOOK=WRITTEN) || echo HOOK=REFUSED',
          description: "edit the tree and try a git hook",
        },
      },
      { text: "done" },
    ])
    check("mount: run exits 0", res.code === 0, res.output.slice(-2000))
    check("mount: the warning is shown", res.output.includes("workspace mount"), res.output.slice(-1000))
    const file = path.join(proj, "m.txt")
    check(
      "mount: the agent's edit is in the working tree",
      (await Bun.file(file)
        .text()
        .catch(() => "")) === "mounted\n",
    )
    if (process.platform !== "win32") {
      const owner = (await fs.stat(file).catch(() => undefined))?.uid
      check("mount: and it's owned by you", owner === process.getuid?.(), `owner ${owner}, you ${process.getuid?.()}`)
    }
    const out = await results(proj)
    check(
      "mount: a git hook can't be written",
      out?.transcript.includes("HOOK=REFUSED") ?? false,
      out?.transcript.slice(-500),
    )
    check("mount: no hook reached the host", !(await Bun.file(path.join(proj, ".git", "hooks", "pre-commit")).exists()))
    const branches = await $`git branch --list ${"lunos/sandbox/*"}`.cwd(proj).quiet().text()
    check("mount: no branch is made", branches.trim() === "", branches)
  }

  // 6. The project's devcontainer as the sandbox's toolchain. The Lunos image is set in your global
  // config, as for a mirror; the project's config sets no image, so its devcontainer is used.
  if (want("devcontainer")) {
    const devcontainer = async (name: string, json: unknown, global: Record<string, unknown> = {}) => {
      const proj = await project(name, {})
      const config = JSON.parse(await Bun.file(path.join(proj, "opencode.json")).text())
      delete config.sandbox.image
      // The probe reads files outside the project (/etc, /built); permissions aren't what this tests.
      config.permission = "allow"
      await Bun.write(path.join(proj, "opencode.json"), JSON.stringify(config))
      await Bun.write(path.join(proj, ".devcontainer", "devcontainer.json"), JSON.stringify(json))
      await Bun.write(
        path.join(proj, ".devcontainer", "Dockerfile"),
        "FROM debian:bookworm-slim\nRUN echo built > /built\n",
      )
      await $`git add -A && git -c user.email=e2e@lunos -c user.name=e2e commit -qm devcontainer`.cwd(proj).quiet()
      await Bun.write(
        path.join(root, name, "home", "cfg", "opencode", "opencode.json"),
        JSON.stringify({ sandbox: { image, ...global } }),
      )
      return proj
    }
    // The markers are assembled by the shell, so they're in the output only, never in the command.
    const probe = {
      tool: "bash",
      args: {
        command:
          'M=MARK; echo "${M}_DEBIAN_$(cat /etc/debian_version 2>/dev/null || echo none)"; ' +
          'apt-get --version >/dev/null 2>&1 && echo "${M}_APT_OK"; ' +
          'echo "${M}_BUILT_$(cat /built 2>/dev/null || echo no)"',
        description: "what is this image",
      },
    }

    // The image: used automatically, with Lunos added; the image's own glibc tools still work.
    const proj = await devcontainer("devc-image", { image: "debian:bookworm-slim", postCreateCommand: "echo hi" })
    const res = await run("devc-image", proj, [probe, { text: "done" }])
    check("devcontainer: run exits 0", res.code === 0, res.output.slice(-2000))
    check("devcontainer: its image is used", res.output.includes("devcontainer image debian:bookworm-slim"))
    check(
      "devcontainer: editor-only keys are named, not applied",
      res.output.includes("not applied in a sandbox: postCreateCommand"),
    )
    const transcript = (await results(proj))?.transcript ?? ""
    check("devcontainer: the tool ran in the image", /MARK_DEBIAN_\d+/.test(transcript), transcript.slice(-800))
    check("devcontainer: the image's own tools still work", transcript.includes("MARK_APT_OK"))

    // A Dockerfile without your opt-in: not built, and you're told how to allow it.
    const unbuilt = await devcontainer("devc-nobuild", { build: { dockerfile: "Dockerfile" } })
    const refused = await run("devc-nobuild", unbuilt, [probe, { text: "done" }])
    check(
      "devcontainer: a Dockerfile isn't built without your opt-in",
      refused.output.includes('"devcontainer": "build"'),
      refused.output.slice(-1000),
    )
    const notBuilt = (await results(unbuilt))?.transcript ?? ""
    check(
      "devcontainer: and the default image is used",
      notBuilt.includes("MARK_BUILT_no") && notBuilt.includes("MARK_DEBIAN_none"),
      notBuilt.slice(-800),
    )

    // With your opt-in (global config), it's built and used.
    const built = await devcontainer("devc-build", { build: { dockerfile: "Dockerfile" } }, { devcontainer: "build" })
    const ok = await run("devc-build", built, [probe, { text: "done" }])
    check("devcontainer: with your opt-in, the Dockerfile is built", ok.code === 0, ok.output.slice(-1500))
    const builtTranscript = (await results(built))?.transcript ?? ""
    check(
      "devcontainer: and its image is used",
      builtTranscript.includes("MARK_BUILT_built"),
      builtTranscript.slice(-800),
    )
  }

  // 7. `lunos agent run` reaching a limit (XCOD-211): the run stops by itself, hands back what the
  // agent did, and counts as a success. Steps: the budget ends the session loop. Time: the run aborts
  // its session at the deadline, a tool in progress included.
  if (want("agent"))
    for (const [name, limit, steps] of [
      [
        "agent-steps",
        ["--max-steps", "2"],
        [edit(), { tool: "bash", args: { command: "echo two", description: "two" } }],
      ],
      [
        "agent-time",
        ["--max-time", "25s"],
        [edit(), { tool: "bash", args: { command: "sleep 120", description: "wait", timeout: 600_000 } }],
      ],
    ] as const) {
      const proj = await project(name, {})
      script = [
        ...steps,
        ...Array.from({ length: 8 }, () => ({ tool: "bash", args: { command: "true", description: "more" } })),
      ]
      const { env, home } = await sandboxEnv(name)
      await fs.mkdir(path.join(home, "cfg", "opencode", "agents"), { recursive: true })
      await Bun.write(
        path.join(home, "cfg", "opencode", "agents", "nightly.md"),
        "---\ndescription: Night shift\nmode: all\npermission:\n  bash: allow\n---\nDo the job.\n",
      )
      const started = Date.now()
      const proc = Bun.spawn([...lunos, "agent", "run", "nightly", "--prompt", "go", ...limit], {
        cwd: proj,
        env,
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
      const seconds = (Date.now() - started) / 1000
      const file = output.match(/report: (\S+\.json)/)?.[1]
      const report = file ? ((await Bun.file(file).json()) as Record<string, any>) : undefined
      const reason = name === "agent-steps" ? "steps" : "time"
      check(`${name}: the run succeeds`, code === 0, output.slice(-2000))
      check(
        `${name}: the report says ok, ${reason}`,
        report?.status === "ok" && report?.reason === reason,
        JSON.stringify(report),
      )
      const branch = report?.results as string | undefined
      check(`${name}: the report names the results branch`, !!branch?.startsWith("lunos/sandbox/"), String(branch))
      const edited = branch ? await $`git show ${branch}:a.txt`.cwd(proj).nothrow().quiet().text() : ""
      check(`${name}: the agent's edit is on the branch`, edited === "one\nedited\n", edited)
      if (name === "agent-time") check(`${name}: it ends soon after the limit`, seconds < 60, `${seconds}s`)
    }

  // 8. Interrupted (Ctrl+C): the agent stops at once and the sandbox is kept, stopped. The server is
  // PID 1 in its container, so before it handled SIGTERM, `docker stop` waited its full timeout while
  // the agent kept going.
  if (want("interrupt")) {
    const proj = await project("interrupt", {})
    script = Array.from({ length: 40 }, (_, i) => ({
      tool: "bash",
      args: { command: `sleep 1; echo tick${i}`, description: "tick" },
    }))
    const { env } = await sandboxEnv("interrupt")
    const proc = Bun.spawn([...lunos, "run", "--sandbox", "--format", "json", "go"], {
      cwd: proj,
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 300_000,
    })
    const stderr = new Response(proc.stderr).text()
    let steps = 0
    let stepsAtInterrupt = 0
    let interruptedAt = 0
    let buffer = ""
    const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += value
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      steps += lines.filter((line) => line.includes('"type":"step_finish"')).length
      if (steps >= 1 && !interruptedAt) {
        stepsAtInterrupt = steps
        interruptedAt = Date.now()
        proc.kill("SIGINT")
      }
    }
    const code = await proc.exited
    const seconds = interruptedAt ? (Date.now() - interruptedAt) / 1000 : -1
    const output = await stderr
    check("interrupt: the run exits 130", code === 130, `exit ${code}\n${output.slice(-1500)}`)
    check("interrupt: it stops within 5s", seconds >= 0 && seconds < 5, `${seconds}s`)
    check("interrupt: at most one step more", steps - stepsAtInterrupt <= 1, `${stepsAtInterrupt} then ${steps}`)
    const id = output.match(/keeping (\w+) \(stopped\)/)?.[1]
    check("interrupt: the sandbox is kept", !!id, output.slice(-1000))
    if (id) {
      const inspect = await $`${runtime} inspect -f ${"{{.State.ExitCode}}"} ${SandboxDocker.containerName(id)}`
        .nothrow()
        .quiet()
        .text()
      check("interrupt: the container stopped on SIGTERM, not SIGKILL", inspect.trim() === "143", inspect.trim())
      const destroyed = await Bun.spawn([...lunos, "sandbox", "destroy", id], {
        cwd: proj,
        env,
        stdout: "pipe",
        stderr: "pipe",
      }).exited
      check("interrupt: `lunos sandbox destroy` removes it", destroyed === 0)
    }
  }

  // 8b. XCOD-301: quitting hands the results back in a detached helper. `lunos run` with its output
  // piped waits for it (a step per line); "background" returns at once and `lunos sandbox status`
  // follows it; nothing changed skips the handoff; a failed one keeps the sandbox and `lunos sandbox
  // conclude` tries again; a new start waits for a running one; Ctrl+C during "wait" leaves it running.
  if (want("fastexit")) {
    const cli = (args: string[], cwd: string, env: Record<string, string>) =>
      $`${lunos} ${args}`.cwd(cwd).env(env).nothrow().quiet()
    const statusDir = (home: string) => path.join(home, "state", "opencode", "sandbox", "conclude")
    const settled = async (id: string, cwd: string, env: Record<string, string>, timeout = 120_000) => {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const out = (await cli(["sandbox", "status", id], cwd, env)).text()
        if (!out.includes("saving its results in the background")) return out
        await Bun.sleep(500)
      }
      return "timed out"
    }
    const exists = async (id: string) =>
      (await $`${runtime} container inspect ${SandboxDocker.containerName(id)}`.nothrow().quiet()).exitCode === 0

    // Waiting (piped output): each step with its time, then the report; the branch as before.
    {
      const proj = await project("exit-wait", {})
      const res = await run("exit-wait", proj, [edit(), { text: "done" }])
      check("exit wait: run exits 0", res.code === 0, res.output.slice(-2000))
      check(
        "exit wait: a line per step, with its time",
        /Handing back results… 2 files, 1 commit · \d+\.\d s/.test(res.output),
        res.output.slice(-1500),
      )
      check(
        "exit wait: the old start-up line isn't printed",
        !res.output.includes("sandbox server http"),
        res.output.slice(-1500),
      )
      const branch = (await results(proj))?.summary?.branch as string | undefined
      const shown = branch ? await $`git show ${branch}:c.txt`.cwd(proj).nothrow().quiet().text() : ""
      check("exit wait: the branch has the agent's changes", shown === "new\n", shown)
    }

    // Nothing changed: the handoff is skipped (no branch), the transcript still comes back.
    {
      const proj = await project("exit-same", {})
      const res = await run("exit-same", proj, [
        { tool: "bash", args: { command: "ls", description: "look" } },
        { text: "done" },
      ])
      check("exit unchanged: run exits 0", res.code === 0, res.output.slice(-2000))
      check(
        "exit unchanged: the handoff is skipped",
        res.output.includes("Saving the transcript… skipped: no changes"),
        res.output.slice(-1500),
      )
      const branches = await $`git branch --list ${"lunos/sandbox/*"}`.cwd(proj).quiet().text()
      check("exit unchanged: no branch is made", branches.trim() === "", branches)
      check("exit unchanged: the transcript came back", !!(await results(proj))?.transcript)
      const logs = await fs.readdir(path.join(res.home, "data", "opencode", "log")).catch(() => [] as string[])
      const texts = await Promise.all(
        logs.map((name) => Bun.file(path.join(res.home, "data", "opencode", "log", name)).text()),
      )
      check(
        'exit unchanged: the log says "handoff skipped: no changes"',
        texts.some((text) => text.includes("handoff skipped: no changes")),
        logs.join(" "),
      )
    }

    // Background: the run returns while the helper works, in its own session; status follows it.
    {
      const proj = await project("exit-bg", { on_exit: "background" })
      const started = Date.now()
      const res = await run("exit-bg", proj, [edit(), { text: "done" }])
      const id = res.output.match(/in the background \(sandbox (\w+)\)/)?.[1]
      check(
        "exit background: run exits 0, saying it saves in the background",
        res.code === 0 && !!id,
        res.output.slice(-2000),
      )
      if (id) {
        type State = { state: string; pid?: number }
        const read = () =>
          Bun.file(path.join(statusDir(res.home), `${id}.json`))
            .json()
            .catch(() => undefined) as Promise<State | undefined>
        let state = await read()
        check(
          "exit background: the helper was still working when the run returned",
          state?.state === "running",
          JSON.stringify(state),
        )
        // Its pid is written once it has started.
        for (let i = 0; i < 100 && state?.state === "running" && !state.pid; i++) {
          await Bun.sleep(100)
          state = await read()
        }
        if (process.platform !== "win32") {
          const ours = (await $`ps -o pgid= -p ${process.pid}`.quiet().text()).trim()
          const group = state?.pid ? (await $`ps -o pgid= -p ${state.pid}`.nothrow().quiet().text()).trim() : ""
          check(
            "exit background: the helper outlived the run, in a process group of its own",
            !!group && group === String(state?.pid) && group !== ours,
            `helper ${state?.pid} group ${group}, ours ${ours}`,
          )
        }
        const { env } = await sandboxEnv("exit-bg")
        const out = await settled(id, proj, env)
        check("exit background: `lunos sandbox status` says done", out.includes(`Sandbox ${id}: done`), out)
        const branch = (await results(proj))?.summary?.branch as string | undefined
        const shown = branch ? await $`git show ${branch}:a.txt`.cwd(proj).nothrow().quiet().text() : ""
        check("exit background: the branch has the agent's changes", shown === "one\nedited\n", shown)
        check("exit background: the container is removed in the background", !(await exists(id)))
        console.log(`     (background run took ${((Date.now() - started) / 1000).toFixed(1)}s end to end)`)
      }
    }

    // A failed handoff (the results directory can't be made): kept, stopped; status says why; the
    // conclude command tries again and saves them.
    {
      const proj = await project("exit-fail", { on_exit: "background" })
      await fs.mkdir(path.join(proj, ".opencode"), { recursive: true })
      await Bun.write(path.join(proj, ".opencode", "sandbox"), "in the way\n")
      const res = await run("exit-fail", proj, [edit(), { text: "done" }])
      const id = res.output.match(/in the background \(sandbox (\w+)\)/)?.[1]
      check("exit failed: run exits 0 in the background", res.code === 0 && !!id, res.output.slice(-2000))
      if (id) {
        const { env } = await sandboxEnv("exit-fail")
        const out = await settled(id, proj, env)
        check(
          "exit failed: status says failed, with the reason",
          out.includes(`Sandbox ${id}: failed`) && out.includes("log: "),
          out,
        )
        const running = (
          await $`${runtime} inspect -f ${"{{.State.Running}}"} ${SandboxDocker.containerName(id)}`
            .nothrow()
            .quiet()
            .text()
        ).trim()
        check("exit failed: the sandbox is kept, stopped", running === "false", running)
        await fs.rm(path.join(proj, ".opencode", "sandbox"))
        const retry = await cli(["sandbox", "conclude", id], proj, env)
        check(
          "exit failed: `lunos sandbox conclude` saves them",
          retry.exitCode === 0,
          retry.stderr.toString().slice(-1500),
        )
        const shown = await $`git show ${`lunos/sandbox/${id}`}:c.txt`.cwd(proj).nothrow().quiet().text()
        check("exit failed: the retried branch has the agent's changes", shown === "new\n", shown)
        check("exit failed: on_finish applies after the retry (destroyed)", !(await exists(id)))
      }
    }

    // A new start in the project while a handoff runs waits for it; both branches are intact.
    {
      const proj = await project("exit-overlap", { on_exit: "background" })
      const first = await run("exit-overlap", proj, [edit(), { text: "done" }])
      const id = first.output.match(/in the background \(sandbox (\w+)\)/)?.[1]
      const second = await run("exit-overlap", proj, [
        { tool: "bash", args: { command: "echo second > d.txt", description: "second" } },
        { text: "done" },
      ])
      check(
        "exit overlap: the second start waited for the first handoff",
        !!id && second.output.includes(`waiting for sandbox ${id} to finish saving its results`),
        second.output.slice(-2000),
      )
      const { env } = await sandboxEnv("exit-overlap")
      if (id) await settled(id, proj, env)
      const firstShown = id ? await $`git show ${`lunos/sandbox/${id}`}:c.txt`.cwd(proj).nothrow().quiet().text() : ""
      check("exit overlap: the first branch is intact", firstShown === "new\n", firstShown)
      const second_id = second.output.match(/in the background \(sandbox (\w+)\)/)?.[1]
      if (second_id) await settled(second_id, proj, env)
      const secondShown = second_id
        ? await $`git show ${`lunos/sandbox/${second_id}`}:d.txt`.cwd(proj).nothrow().quiet().text()
        : ""
      check("exit overlap: the second branch is intact", secondShown === "second\n", secondShown)
    }

    // Ctrl+C while waiting: the run stops following, the helper finishes anyway.
    {
      const proj = await project("exit-ctrlc", { on_exit: "wait" })
      script = [edit(), { text: "done" }]
      const { home, env } = await sandboxEnv("exit-ctrlc")
      const proc = Bun.spawn([...lunos, "run", "--sandbox", "do the task"], {
        cwd: proj,
        env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 300_000,
      })
      const stderr = new Response(proc.stderr).text()
      let id: string | undefined
      while (proc.exitCode === null && !id) {
        const names = await fs.readdir(statusDir(home)).catch(() => [] as string[])
        id = names.find((name) => name.endsWith(".json"))?.slice(0, -".json".length)
        if (!id) await Bun.sleep(100)
      }
      proc.kill("SIGINT")
      await proc.exited
      const output = await stderr
      check(
        "exit ctrl+c: following stops, saying it goes on in the background",
        output.includes("Continuing in the background"),
        output.slice(-1500),
      )
      if (id) {
        const out = await settled(id, proj, env)
        check("exit ctrl+c: the helper still finishes", out.includes(`Sandbox ${id}: done`), out)
        const shown = await $`git show ${`lunos/sandbox/${id}`}:c.txt`.cwd(proj).nothrow().quiet().text()
        check("exit ctrl+c: the branch has the agent's changes", shown === "new\n", shown)
      }
    }
  }

  // 9. on_finish "destroy" (the default) leaves nothing behind.
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
