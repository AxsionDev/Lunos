#!/usr/bin/env bun
// XCOD-321: the release end-to-end check, on one machine, against the build that is about to ship.
// It installs that build with npm from a fake registry on 127.0.0.1, signs in with the device flow
// against a fake OpenID provider, runs a first TUI turn on a scripted model, gives Claude Code and
// Codex a task (stand-ins replaying recorded sessions), runs the sandbox fast-exit checks where a
// Linux container runtime exists, and updates the published `latest` (N) to this build (N+1) with
// `lunos update`. Used by .github/workflows/e2e-matrix.yml on Linux, macOS and Windows.
//
//   bun run script/release-e2e.ts [--dist dist] [--from <N>|none] [--only install,signin,...]
//                                 [--sandbox-image lunos-sandbox:local] [--results e2e.json]
//
// --dist holds the build's platform packages (dist/lunos-<os>-<arch>/, as script/build.ts makes
// them). N is read from registry.npmjs.org unless --from names it; installing N is the only outside
// call. Everything runs under a throwaway HOME and XDG dirs; no hosted model is ever asked anything,
// and anything else the TUI tries to reach goes to a proxy that records and refuses it. A step that
// can't run here is "skip" with its reason, never "pass". Exits 1 if any step failed.
import { $ } from "bun"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import semver from "semver"
import * as FakeIdp from "../test/cloud/fixtures/fake-idp"
import * as Pty from "../test/cli/fixtures/tui-pty"

const dir = path.resolve(import.meta.dirname, "..")
const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`)
  return index > 0 ? process.argv[index + 1] : undefined
}
const dist = path.resolve(arg("dist") ?? path.join(dir, "dist"))
const only = arg("only")?.split(",")
const want = (name: string) => !only || only.includes(name)
const windows = process.platform === "win32"
const exe = windows ? ".exe" : ""
const { KEY } = Pty

type Status = "pass" | "fail" | "skip"
const results: { step: string; status: Status; detail: string; seconds: number }[] = []
async function step(name: string, body: () => Promise<{ status: Status; detail: string } | string>) {
  if (!want(name)) return
  const started = Date.now()
  console.log(`\n== ${name}`)
  const outcome = await body().catch((error: unknown) => ({
    status: "fail" as const,
    detail: error instanceof Error ? error.message : String(error),
  }))
  const { status, detail } = typeof outcome === "string" ? { status: "pass" as const, detail: outcome } : outcome
  const seconds = Math.round((Date.now() - started) / 100) / 10
  results.push({ step: name, status, detail, seconds })
  console.log(
    `${status.toUpperCase()} ${name} (${seconds} s)${detail ? `\n     ${detail.replace(/\n/g, "\n     ")}` : ""}`,
  )
}
const skip = (detail: string) => ({ status: "skip" as const, detail })
const fail = (detail: string) => ({ status: "fail" as const, detail })

// Everything this run writes lives here.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "lunos-release-e2e-"))
console.log(`throwaway root ${root}`)

// ---- the build under test ------------------------------------------------------------------------

const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string] ?? process.platform
// The platform packages this machine can run: the plain one first (postinstall.mjs's preference).
const packages = (await fs.readdir(dist).catch(() => [] as string[]))
  .filter((name) => name.startsWith(`lunos-${platform}-${process.arch}`) && !name.endsWith(".zip"))
  .sort((a, b) => a.length - b.length)
if (!packages.length) throw new Error(`no dist/lunos-${platform}-${process.arch}* package in ${dist}`)
const manifest = (await Bun.file(path.join(dist, packages[0]!, "package.json")).json()) as { version: string }
const next = manifest.version
console.log(`build under test: ${next} (${packages.join(", ")})`)

// ---- a fake npm registry -------------------------------------------------------------------------

type Packument = { name: string; "dist-tags": Record<string, string>; versions: Record<string, any> }
const packuments = new Map<string, Packument>()
const tarballs = new Map<string, string>()
const registry = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const file = tarballs.get(url.pathname)
    if (file) return new Response(Bun.file(file))
    const [name, tag] = decodeURIComponent(url.pathname.slice(1)).split("/")
    const doc = packuments.get(name ?? "")
    if (!doc) return Response.json({ error: "Not found" }, { status: 404 })
    if (!tag) return Response.json(doc)
    const version = doc["dist-tags"][tag] ?? (doc.versions[tag] ? tag : undefined)
    return version ? Response.json(doc.versions[version]) : Response.json({ error: "Not found" }, { status: 404 })
  },
})
const registryUrl = `http://127.0.0.1:${registry.port}`

/** `npm pack`s a package directory and serves it as `name@version`, the newest being `latest`. */
async function serve(pkgDir: string) {
  const out = path.join(root, "tarballs")
  await fs.mkdir(out, { recursive: true })
  const pkg = (await Bun.file(path.join(pkgDir, "package.json")).json()) as { name: string; version: string }
  const packed = (await $`npm pack --silent --pack-destination ${out}`.cwd(pkgDir).env(npmEnv()).text()).trim()
  const file = path.join(out, packed.split("\n").at(-1)!)
  const bytes = new Uint8Array(await Bun.file(file).arrayBuffer())
  const at = `/-/tarballs/${path.basename(file)}`
  tarballs.set(at, file)
  const doc: Packument = packuments.get(pkg.name) ?? { name: pkg.name, "dist-tags": {}, versions: {} }
  doc.versions[pkg.version] = {
    ...pkg,
    dist: {
      tarball: registryUrl + at,
      shasum: createHash("sha1").update(bytes).digest("hex"),
      integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
    },
  }
  doc["dist-tags"].latest = pkg.version
  packuments.set(pkg.name, doc)
}

/** The `lunos-ai` entry package for this build, as script/publish.ts writes it, for this platform only. */
async function entryPackage() {
  const entry = path.join(root, "lunos-ai")
  await fs.mkdir(path.join(entry, "bin"), { recursive: true })
  await fs.copyFile(path.join(dir, "script", "postinstall.mjs"), path.join(entry, "postinstall.mjs"))
  await Bun.write(
    path.join(entry, "bin", "lunos.exe"),
    'echo "lunos-ai\'s postinstall script was not run." >&2\nexit 1\n',
  )
  await Bun.write(
    path.join(entry, "package.json"),
    JSON.stringify({
      name: "lunos-ai",
      version: next,
      bin: { lunos: "./bin/lunos.exe" },
      scripts: { postinstall: "node ./postinstall.mjs" },
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: Object.fromEntries(packages.map((name) => [name, next])),
    }),
  )
  return entry
}

// ---- npm, isolated -------------------------------------------------------------------------------

/** npm's prefix, cache and config files under the throwaway root; `registry` is where it installs from. */
function npmVars(prefix: string, registryOverride?: string): Record<string, string> {
  return {
    npm_config_prefix: prefix,
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_userconfig: path.join(root, "npmrc"),
    npm_config_globalconfig: path.join(root, "npmrc-global"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    ...(registryOverride ? { npm_config_registry: registryOverride } : {}),
    PATH: [windows ? prefix : path.join(prefix, "bin"), process.env.PATH ?? process.env.Path ?? ""].join(
      path.delimiter,
    ),
  }
}

/** npm itself: this environment minus any npm credential and npm settings, with a throwaway HOME. */
function npmEnv(prefix = path.join(root, "npm-unused"), registryOverride?: string): Record<string, string> {
  const home = path.join(root, "npm-home")
  const env = { ...(process.env as Record<string, string>) }
  for (const key of Object.keys(env)) if (/^npm_config_|NODE_AUTH_TOKEN|NPM_TOKEN/i.test(key)) delete env[key]
  return { ...env, HOME: home, USERPROFILE: home, ...npmVars(prefix, registryOverride) }
}
await fs.mkdir(path.join(root, "npm-home"), { recursive: true })
for (const file of ["npmrc", "npmrc-global"]) await Bun.write(path.join(root, file), "")

/** Where npm puts the real binary (postinstall.mjs copies the platform one there). */
const binaryIn = (prefix: string) =>
  path.join(prefix, ...(windows ? [] : ["lib"]), "node_modules", "lunos-ai", "bin", "lunos.exe")

async function npmInstall(prefix: string, spec: string, registryOverride: string) {
  // npm 12 skips postinstall scripts unless allowed; older npm takes the flag as an unknown setting.
  const result = await $`npm install -g ${spec} --allow-scripts=lunos-ai --no-audit --no-fund --loglevel=error`
    .env(npmEnv(prefix, registryOverride))
    .nothrow()
    .quiet()
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() }
}

async function versionOf(binary: string) {
  const result = await $`${binary} --version`.env(isolated("version")).nothrow().quiet()
  return (result.stdout.toString() + result.stderr.toString()).trim()
}

/** The environment a `lunos` command runs in: a fresh HOME and XDG dirs, and no Lunos auth from the runner. */
function isolated(name: string, extra: Record<string, string> = {}): Record<string, string> {
  const home = path.join(root, "homes", name)
  const keep = windows
    ? ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"]
    : []
  return {
    ...Object.fromEntries(keep.filter((key) => process.env[key]).map((key) => [key, process.env[key]!])),
    PATH: process.env.PATH ?? process.env.Path ?? "",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    LUNOS_CLOUD_STORE: "test-keychain",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    ...extra,
  }
}

// ---- a scripted model ----------------------------------------------------------------------------

const REPLY = "e2e reply from the scripted model"
const sse = (chunks: unknown[]) =>
  new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  })
let modelRequests = 0
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
    const body = (await req.json()) as { tools?: unknown[] }
    if (body.tools?.length) modelRequests++
    const base = { id: "c1", object: "chat.completion.chunk", created: 0, model: "m" }
    return sse([
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: body.tools?.length ? REPLY : "e2e" } }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    ])
  },
})
const modelConfig = {
  model: "local/m",
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible",
      name: "Local",
      options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: "unused" },
      models: { m: { name: "m", tool_call: true } },
    },
  },
}

// ---- the TUI in a pty ----------------------------------------------------------------------------

/** Claude Code and Codex: the test stand-ins, which replay recorded sessions, behind a launcher the build can start. */
async function externalShims() {
  const bin = path.join(root, "external")
  await fs.mkdir(bin, { recursive: true })
  const shim = async (tool: string) => {
    const fake = path.join(dir, "test", "external", "fixtures", `fake-${tool}.ts`)
    if (windows) {
      const file = path.join(bin, `${tool}.cmd`)
      await Bun.write(file, `@"${process.execPath}" "${fake}" %*\r\n`)
      return file
    }
    const file = path.join(bin, tool)
    await Bun.write(file, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
    await fs.chmod(file, 0o755)
    return file
  }
  return { claude: { path: await shim("claude") }, codex: { path: await shim("codex") } }
}

/** Moves the highlight to the action labelled `label` and chooses it (as tui-signin-pty.test.ts does). */
async function choose(tui: Awaited<ReturnType<typeof Pty.launch>>, label: string) {
  const screen = tui.screen.text().split("\n")
  const current = screen.findIndex((line) => /^\s*›\S/.test(line))
  if (current < 0) throw new Error(`no highlighted action. Screen:\n${screen.join("\n")}`)
  const column = screen[current]!.indexOf("›")
  const action = (line: string | undefined) =>
    line !== undefined && line.slice(0, column).trim() === "" && /^[› ]\S/.test(line.slice(column))
  let first = current
  while (action(screen[first - 1])) first--
  let last = current
  while (action(screen[last + 1])) last++
  const at = screen.slice(first, last + 1).findIndex((line) => line.includes(label))
  if (at < 0) throw new Error(`no "${label}" to choose. Screen:\n${screen.join("\n")}`)
  const moves = at - (current - first)
  for (let i = 0; i < Math.abs(moves); i++) {
    tui.press(moves > 0 ? KEY.down : KEY.up)
    await Bun.sleep(80)
  }
  await Bun.sleep(150)
  tui.press(KEY.enter)
}

async function waitForFile(file: string, timeout: number) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const text = await fs.readFile(file, "utf8").catch(() => undefined)
    if (text !== undefined) return text
    await Bun.sleep(200)
  }
  return undefined
}

const lastScreen = (tui: { screen: { text(): string } } | undefined) =>
  tui ? `\nScreen:\n${tui.screen.text().split("\n").filter(Boolean).slice(-25).join("\n")}` : ""

// ---- the steps -----------------------------------------------------------------------------------

let installed: string | undefined
const proxy = await Pty.recordingProxy()
const idp = FakeIdp.start({ pendingPolls: 2 })
let tuiHome: string | undefined
let externals: Awaited<ReturnType<typeof externalShims>> | undefined
const tuiConfig = () => ({ cloud: { issuer: idp.origin, endpoint: idp.origin }, external: externals })
const tuiEnv = () => ({
  HTTPS_PROXY: proxy.url,
  HTTP_PROXY: proxy.url,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(modelConfig),
})

try {
  for (const name of packages) await serve(path.join(dist, name))
  await serve(await entryPackage())

  await step("install", async () => {
    const prefix = path.join(root, "npm-next")
    const result = await npmInstall(prefix, `lunos-ai@${next}`, registryUrl)
    if (result.code !== 0) return fail(`npm install exited ${result.code}\n${result.output.slice(-2000)}`)
    const version = await versionOf(binaryIn(prefix))
    if (version !== next) return fail(`lunos --version printed "${version}", expected ${next}`)
    installed = binaryIn(prefix)
    return `npm installed lunos-ai@${next} from the fake registry; lunos --version is ${version}`
  })

  // The official build's Welcome screen, Create account / Sign in, the device flow, then home.
  await step("signin", async () => {
    if (!installed) return skip("nothing installed (the install step didn't pass)")
    externals = await externalShims()
    const tui = await Pty.launch({ binary: installed, config: tuiConfig(), env: tuiEnv() })
    tuiHome = tui.home
    try {
      await tui.waitFor("Welcome to Lunos", 90_000)
      tui.press(KEY.space)
      await tui.waitFor("[x] I accept the Terms")
      await choose(tui, "Sign in")
      await tui.waitFor("Signed in as pat@lunos.test", 60_000)
      await tui.waitFor("Ask anything", 30_000)
      if (!idp.requests.some((request) => request.path === "/device")) return fail("no device authorization request")
      return "Welcome screen → device flow against the fake provider → Signed in as pat@lunos.test → home"
    } catch (error) {
      return fail(String(error instanceof Error ? error.message : error))
    } finally {
      await tui.stop()
    }
  })

  // A first turn: the prompt goes to the scripted model and its answer is on screen.
  await step("turn", async () => {
    if (!installed || !tuiHome) return skip("not signed in (the signin step didn't pass)")
    const tui = await Pty.launch({ binary: installed, home: tuiHome, config: tuiConfig(), env: tuiEnv() })
    try {
      await tui.waitFor("Ask anything", 90_000)
      const before = modelRequests
      await tui.type("Say hello")
      await Bun.sleep(300)
      tui.press(KEY.enter)
      await tui.waitFor(REPLY, 60_000)
      if (modelRequests === before) return fail("the reply is on screen but the model was never asked")
      return `the scripted model answered on screen (${modelRequests - before} request(s))`
    } catch (error) {
      return fail(String(error instanceof Error ? error.message : error) + lastScreen(tui))
    } finally {
      await tui.stop()
    }
  })

  // /claude and /codex with a task: the stand-ins replay recorded sessions that each write a file.
  for (const [tool, task, file, content] of [
    ["claude", "Create hello.txt containing hi", "hello.txt", "hi"],
    ["codex", "Create note.txt containing from codex", "note.txt", "from codex"],
  ] as const)
    await step(tool, async () => {
      if (!installed || !tuiHome) return skip("not signed in (the signin step didn't pass)")
      const tui = await Pty.launch({ binary: installed, home: tuiHome, config: tuiConfig(), env: tuiEnv() })
      try {
        await tui.waitFor("Ask anything", 90_000)
        await tui.type(`/${tool} ${task}`)
        await Bun.sleep(400)
        tui.press(KEY.enter)
        const target = path.join(tui.dirs.project, file)
        const until = Date.now() + 60_000
        let written: string | undefined
        while (Date.now() < until && written === undefined) {
          written = await waitForFile(target, 1_000)
          if (written !== undefined) break
          const screen = tui.screen.text()
          // Sharing Lunos's tools with the tool (the bridge) is its own feature: "Not now".
          if (screen.includes("Share Lunos tools")) {
            tui.press(KEY.down)
            await Bun.sleep(150)
            tui.press(KEY.enter)
            await Bun.sleep(500)
          }
          // An approval the stand-in asks for: allow it once (the first option).
          else if (/Allow once|Permission required/.test(screen)) {
            tui.press(KEY.enter)
            await Bun.sleep(500)
          }
        }
        if (written !== content) return fail(`${file} is ${JSON.stringify(written)}${lastScreen(tui)}`)
        return `/${tool} <task> ran the recorded ${tool} session; it wrote ${file}`
      } catch (error) {
        return fail(String(error instanceof Error ? error.message : error) + lastScreen(tui))
      } finally {
        await tui.stop()
      }
    })

  // The sandbox: background start, a turn, a fast quit and the detached handoff (sandbox-e2e.ts --only fastexit).
  await step("sandbox", async () => {
    if (!installed) return skip("nothing installed (the install step didn't pass)")
    const docker = Bun.which("docker")
    if (!docker) return skip("no docker on PATH (hosted macOS runners have none)")
    const info = await $`docker info --format ${"{{.OSType}}"}`.nothrow().quiet()
    if (info.exitCode !== 0) return skip(`no Docker daemon answering: ${info.stderr.toString().trim().split("\n")[0]}`)
    const type = info.stdout.toString().trim()
    if (type !== "linux") return skip(`Docker here runs ${type} containers; the sandbox needs Linux containers`)
    const image = arg("sandbox-image")
    if (!image) return skip("no --sandbox-image given (build one with script/sandbox-image.ts)")
    if ((await $`docker image inspect ${image}`.nothrow().quiet()).exitCode !== 0)
      return fail(`--sandbox-image ${image} isn't in the local image store`)
    const run =
      await $`bun run ${path.join(dir, "script", "sandbox-e2e.ts")} --runtime docker --image ${image} --only fastexit --lunos ${installed}`
        .cwd(dir)
        .env({ ...(process.env as Record<string, string>), SANDBOX_E2E_VERBOSE: "" })
        .nothrow()
        .quiet()
    const output = run.stdout.toString() + run.stderr.toString()
    console.log(output)
    const failed = output.split("\n").filter((line) => line.startsWith("FAIL"))
    if (run.exitCode !== 0)
      return fail(`sandbox-e2e.ts exited ${run.exitCode}: ${failed.join("; ") || output.slice(-1500)}`)
    const passed = output.split("\n").filter((line) => line.startsWith("ok")).length
    return `sandbox-e2e.ts --only fastexit: ${passed} checks passed on Docker with the installed build`
  })

  // N → N+1: the published `latest` from npm, then `lunos update` against the fake registry.
  await step("update", async () => {
    const from = arg("from")
    if (from === "none") return skip("--from none")
    const published: string =
      from ??
      (await fetch("https://registry.npmjs.org/lunos-ai/latest", { signal: AbortSignal.timeout(20_000) })
        .then((res) => res.json() as Promise<{ version: string }>)
        .then((data) => data.version))
    if (!semver.valid(next) || !semver.gt(next, published))
      return fail(`the build under test (${next}) isn't newer than ${published}: nothing to update to`)
    const prefix = path.join(root, "npm-from")
    const install = await npmInstall(prefix, `lunos-ai@${published}`, "https://registry.npmjs.org")
    if (install.code !== 0)
      return fail(`npm install lunos-ai@${published} exited ${install.code}\n${install.output.slice(-1500)}`)
    const binary = binaryIn(prefix)
    const before = await versionOf(binary)
    if (before !== published) return fail(`lunos-ai@${published} reports ${before}`)
    const shim = path.join(prefix, ...(windows ? ["lunos.cmd"] : ["bin", "lunos"]))
    const update = await $`${shim} update`
      .env(isolated("update", npmVars(prefix, registryUrl)))
      .nothrow()
      .quiet()
    const output = update.stdout.toString() + update.stderr.toString()
    console.log(output)
    const after = await versionOf(binary)
    if (update.exitCode !== 0 || after !== next)
      return fail(`lunos update exited ${update.exitCode}; lunos --version is now ${after}\n${output.slice(-1500)}`)
    if (!output.includes(`From ${published} → ${next}`) || !output.includes("Update complete"))
      return fail(`lunos update didn't report the update\n${output.slice(-1500)}`)
    return `lunos update: ${published} → ${next}; lunos --version is ${after}`
  })

  // No Lunos production host was tried by anything that ran in the TUI.
  if (want("signin") || want("turn") || want("claude") || want("codex"))
    await step("no-production-hosts", async () => {
      const lunos = proxy.lunos()
      return lunos.length ? fail(`tried to reach ${[...new Set(lunos)].join(", ")}`) : "no request to a lunos.tech host"
    })
} finally {
  idp.stop()
  model.stop(true)
  registry.stop(true)
  await proxy.close()
}

// ---- the report ----------------------------------------------------------------------------------

const icon = { pass: "✅", fail: "❌", skip: "⏭️" }
const report = [
  `### Release E2E: ${process.platform}-${process.arch}, lunos ${next}`,
  "",
  "| step | result | time | detail |",
  "| --- | --- | --- | --- |",
  ...results.map(
    (r) =>
      `| ${r.step} | ${icon[r.status]} ${r.status} | ${r.seconds} s | ${r.detail.split("\n")[0]!.replace(/\|/g, "\\|")} |`,
  ),
  "",
].join("\n")
console.log("\n" + report)
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, report + "\n")
const out = arg("results")
if (out)
  await Bun.write(
    out,
    JSON.stringify({ platform: `${process.platform}-${process.arch}`, version: next, results }, null, 2),
  )
if (!process.env.RELEASE_E2E_KEEP) await fs.rm(root, { recursive: true, force: true }).catch(() => {})
const failed = results.filter((r) => r.status === "fail")
console.log(
  failed.length ? `${failed.length} step(s) failed: ${failed.map((r) => r.step).join(", ")}` : "no step failed",
)
process.exit(failed.length ? 1 : 0)
