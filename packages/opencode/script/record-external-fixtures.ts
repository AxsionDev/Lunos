#!/usr/bin/env bun
// XCOD-270: record Claude Code's and Codex's traffic with the Lunos adapters into
// test/fixtures/external/<tool>-<version>/, for the contract tests to replay. Each scenario
// (test/external/record/scenarios.ts) runs the adapter exactly as a Lunos session does, with the
// tool started through tap.ts, which logs every line redacted.
//
// A real run sends a few trivial prompts to Anthropic and OpenAI, so it refuses to start unless
// LUNOS_RECORD_EXTERNAL=1 is set and each tool is given a key by the name of the variable holding
// it. The tools run in a throwaway HOME (and XDG dirs, TMPDIR and project) with an environment
// built from scratch, so the user's own login and settings aren't visible to them. See
// docs/external-fixtures.md.
//
//   LUNOS_RECORD_EXTERNAL=1 bun script/record-external-fixtures.ts \
//     --claude-key-env LUNOS_TEST_ANTHROPIC_KEY --codex-key-env LUNOS_TEST_OPENAI_KEY [--dry-run]
//
//   --tool claude|codex          only this tool (repeatable; default both)
//   --scenario <name>            only this scenario (repeatable; default all)
//   --binary <tool>=<path>       the tool to run (default: the one on PATH)
//   --models <tool>=<a>,<b>      the two models of resume-model-switch (default: the first two listed)
//   --fake                       the --binary is one of the test fakes: drive it with its FAKE_* switches
//                                and write to fake-<tool>-<version>/
//   --out <dir>                  where the <tool>-<version> folders go (default test/fixtures/external)
//   --keep                       keep the throwaway directory (it holds no key) for inspection
//   --dry-run                    print what would run, and run nothing
import { spawnSync } from "child_process"
import { createHash } from "crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { ExternalClaude } from "../src/external/claude"
import { ExternalCodex } from "../src/external/codex"
import { ExternalDetect } from "../src/external/detect"
import type { Manifest, ManifestStep } from "../test/external/record/harness"
import { compile, scan, type Context } from "../test/external/record/redact"
import { decision, SCENARIOS, VERSIONS, type Scenario, type Step } from "../test/external/record/scenarios"

const PACKAGE = path.resolve(import.meta.dir, "..")
const REPO = path.resolve(PACKAGE, "..", "..")
const TAP = path.join(PACKAGE, "test/external/record/tap.ts")
const STAND_IN = path.join(PACKAGE, "test/external/fixtures/fake-mcp-server.ts")
const TOOLS: ExternalDetect.Tool[] = ["claude", "codex"]
const KEY_VAR = { claude: "ANTHROPIC_API_KEY" } as const

class Failure extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message)
  }
}

/** Thrown, so the throwaway directory is still removed on the way out. */
function fail(message: string, code = 2): never {
  throw new Failure(message, code)
}

function parse(argv: string[]) {
  const flags = {
    tools: [] as ExternalDetect.Tool[],
    scenarios: [] as string[],
    keyEnv: {} as Partial<Record<ExternalDetect.Tool, string>>,
    binary: {} as Partial<Record<ExternalDetect.Tool, string>>,
    models: {} as Partial<Record<ExternalDetect.Tool, [string, string]>>,
    fake: false,
    dryRun: false,
    keep: false,
    out: path.join(PACKAGE, "test/fixtures/external"),
  }
  const pair = (value: string, flag: string) => {
    const [tool, rest] = [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)]
    if (!TOOLS.includes(tool as ExternalDetect.Tool) || !rest) fail(`${flag} takes <claude|codex>=<value>`)
    return [tool as ExternalDetect.Tool, rest] as const
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!
    const value = () => argv[++i] ?? fail(`${flag} needs a value`)
    if (flag === "--tool") {
      const tool = value() as ExternalDetect.Tool
      if (!TOOLS.includes(tool)) fail(`unknown tool ${tool}`)
      flags.tools.push(tool)
    } else if (flag === "--scenario") flags.scenarios.push(value())
    else if (flag === "--claude-key-env") flags.keyEnv.claude = value()
    else if (flag === "--codex-key-env") flags.keyEnv.codex = value()
    else if (flag === "--binary") {
      const [tool, file] = pair(value(), flag)
      flags.binary[tool] = path.resolve(file)
    } else if (flag === "--models") {
      const [tool, list] = pair(value(), flag)
      const models = list.split(",")
      if (models.length !== 2 || !models.every((m) => ExternalClaude.MODEL_ID.test(m)))
        fail("--models takes two model ids")
      flags.models[tool] = [models[0]!, models[1]!]
    } else if (flag === "--fake") flags.fake = true
    else if (flag === "--dry-run") flags.dryRun = true
    else if (flag === "--keep") flags.keep = true
    else if (flag === "--out") flags.out = path.resolve(value())
    else fail(`unknown flag ${flag}`)
  }
  if (!flags.tools.length) flags.tools = [...TOOLS]
  for (const name of flags.scenarios)
    if (!SCENARIOS.some((scenario) => scenario.name === name)) fail(`unknown scenario ${name}`)
  return flags
}

type Flags = ReturnType<typeof parse>

/** Every file under `dir` (sockets and the like skipped) with its SHA-256. */
function hashes(dir: string, base = dir, into = new Map<string, string>()) {
  if (!existsSync(dir)) return into
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    const stat = statSync(file, { throwIfNoEntry: false })
    if (stat?.isDirectory()) hashes(file, base, into)
    else if (stat?.isFile())
      into.set(path.relative(base, file), createHash("sha256").update(readFileSync(file)).digest("hex"))
  }
  return into
}

function diff(before: Map<string, string>, after: Map<string, string>): ManifestStep["home"] {
  return {
    added: [...after.keys()].filter((file) => !before.has(file)).sort(),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)).sort(),
    removed: [...before.keys()].filter((file) => !after.has(file)).sort(),
  }
}

/** The environment the tools get: nothing of the user's but PATH and the locale. */
function environment(dirs: { home: string; tmp: string }, extra: Record<string, string>) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: path.join(dirs.home, ".config"),
    XDG_DATA_HOME: path.join(dirs.home, ".local/share"),
    XDG_CACHE_HOME: path.join(dirs.home, ".cache"),
    XDG_STATE_HOME: path.join(dirs.home, ".local/state"),
    TMPDIR: dirs.tmp,
    TERM: "dumb",
    NO_COLOR: "1",
    // So the fakes, run by bun, don't leave bun's transpiler cache in the HOME being hashed.
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    ...extra,
  }
}

/** What the tool is started with for a step, shown by --dry-run. */
function describe(tool: ExternalDetect.Tool, binary: string, step: Step, bridge: string) {
  if (tool === "codex") {
    const calls =
      step.kind === "models"
        ? "initialize, initialized, model/list"
        : `initialize, initialized, ${step.resume ? "thread/resume" : "thread/start"} {${step.model ? ` model: <${step.model} model>,` : ""} sandbox: read-only, approvalPolicy: untrusted${step.bridge ? `, config: { "mcp_servers.lunos": ${bridge} }` : ""} }, ${ExternalCodex.command(step.prompt, !!step.resume).method} ${JSON.stringify(step.prompt)}`
    return `${binary} app-server   → ${calls}`
  }
  const args = ExternalClaude.args({})
  if (step.kind === "models")
    return `${binary} ${args.join(" ")}   → stdin: initialize (no prompt; stopped once it answers)`
  const extra = [
    ...(step.resume ? ["--resume", "<previous session>"] : []),
    ...(step.model ? ["--model", `<${step.model} model>`] : []),
    ...(step.bridge ? ["--mcp-config", "<scratch>/mcp.json"] : []),
  ]
  return `${binary} ${[...args, ...extra].join(" ")}   → stdin: initialize, user ${JSON.stringify(step.prompt)}`
}

function version(binary: string) {
  const cmd = ExternalDetect.command(binary, ["--version"])
  const out = spawnSync(cmd.file, cmd.args, { encoding: "utf8", env: process.env, timeout: 15_000 })
  const found = /\d+\.\d+\.\d+\S*/.exec(out.stdout ?? "")?.[0]
  if (out.status !== 0 || !found) fail(`${binary} --version didn't report a version (${(out.stderr ?? "").trim()})`)
  return found
}

/** The login a step's tool used, from its own report, or what makes it not the test key. Undefined is fine. */
export function loginProblem(tool: ExternalDetect.Tool, entries: any[]) {
  const messages = entries.filter((entry) => entry.from === "tool").map((entry) => entry.message ?? {})
  if (tool === "claude") {
    const account = messages.find((m) => m.type === "control_response")?.response?.response?.account
    if (
      account &&
      (account.subscriptionType ||
        /oauth|claude\.ai/i.test(`${account.tokenSource ?? ""}${account.apiKeySource ?? ""}`))
    )
      return `Claude Code reports a personal login: ${JSON.stringify(account)}`
    const init = messages.find((m) => m.type === "system" && m.subtype === "init")
    if (init && (!init.apiKeySource || init.apiKeySource === "none"))
      return `Claude Code's init doesn't say it used the given key (apiKeySource: ${JSON.stringify(init.apiKeySource)})`
  }
  return undefined
}

async function record(tool: ExternalDetect.Tool, flags: Flags, scenarios: Scenario[]) {
  const key = process.env[flags.keyEnv[tool]!]!
  const binary = flags.binary[tool] ?? ExternalDetect.locate(tool)!
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lunos-record-")))
  const dirs = {
    home: path.join(scratch, "home"),
    project: path.join(scratch, "project"),
    tmp: path.join(scratch, "tmp"),
    staging: path.join(scratch, "staging"),
  }
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const context: Context = {
    secrets: [key],
    paths: [
      [dirs.home, "<home>"],
      [dirs.project, "<project>"],
      [scratch, "<scratch>"],
      [REPO, "<repo>"],
      [process.execPath, "<bun>"],
      [os.homedir(), "<user-home>"],
    ],
    user: os.userInfo().username,
  }
  const contextFile = path.join(scratch, "context.json")
  await fs.writeFile(contextFile, JSON.stringify(context), { mode: 0o600 })
  const extra: Record<string, string> = tool === "claude" ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } : {}
  const base = environment(dirs, tool === "claude" ? { [KEY_VAR.claude]: key } : {})
  const set = (env: Record<string, string>) => {
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, env)
  }
  const saved = { ...process.env }
  const redact = compile(context)
  try {
    set(base)
    const found = version(binary)
    if (found !== VERSIONS[tool])
      console.warn(
        `${tool} is ${found}; the contract tests expect ${VERSIONS[tool]}, so they won't read this recording`,
      )
    const outDir = path.join(flags.out, `${flags.fake ? "fake-" : ""}${tool}-${found}`)
    if (tool === "codex" && !flags.fake) {
      // The key goes to Codex over stdin, into the throwaway HOME's ~/.codex, never on a command line.
      const login = spawnSync(binary, ["login", "--with-api-key"], {
        input: key + "\n",
        encoding: "utf8",
        env: process.env,
        timeout: 30_000,
      })
      if (login.status !== 0)
        fail(`codex login --with-api-key failed: ${redact.string((login.stderr ?? "").trim())}`, 1)
      const status = spawnSync(binary, ["login", "status"], { encoding: "utf8", env: process.env, timeout: 15_000 })
      const said = redact.string(`${status.stdout ?? ""}${status.stderr ?? ""}`.trim())
      if (!/api key/i.test(said)) fail(`codex login status doesn't report the API key login: ${said}`, 1)
    }
    if (tool === "claude" && !flags.fake) {
      // Before any prompt: ask Claude Code who it is logged in as (initialize only, no model call).
      const log = path.join(scratch, "preflight.jsonl")
      set({ ...base, REC_TARGET: binary, REC_LOG: log, REC_CONTEXT: contextFile, REC_EXTRA_ENV: JSON.stringify(extra) })
      await ExternalClaude.models({ executable: TAP, cwd: dirs.project, timeoutMs: 60_000 })
      const entries = existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : []
      const problem = loginProblem(tool, entries)
      if (problem) fail(`${problem}. Stopped before any prompt; nothing written.`, 1)
      set(base)
    }
    const mcpEntry = { command: process.execPath, args: [STAND_IN] }
    const mcpFile = path.join(scratch, "mcp.json")
    await fs.writeFile(mcpFile, JSON.stringify({ mcpServers: { lunos: { type: "stdio", ...mcpEntry } } }), {
      mode: 0o600,
    })
    let switchModels = flags.models[tool]
    const manifest: Manifest = { tool, version: found, fake: flags.fake, scenarios: {} }
    for (const scenario of scenarios) {
      const steps: ManifestStep[] = []
      let session: string | undefined
      for (const [index, step] of scenario.steps.entries()) {
        const file = `${scenario.name}.${index + 1}.jsonl`
        const log = path.join(dirs.staging, file)
        set({
          ...base,
          ...(flags.fake ? scenario.fake?.[tool] : {}),
          REC_TARGET: binary,
          REC_LOG: log,
          REC_CONTEXT: contextFile,
          REC_EXTRA_ENV: JSON.stringify(extra),
        })
        const before = hashes(dirs.home)
        const entry = { file, kind: step.kind } as ManifestStep
        if (step.kind === "models") {
          const models = await (tool === "claude" ? ExternalClaude : ExternalCodex).models({
            executable: TAP,
            cwd: dirs.project,
            timeoutMs: 60_000,
          })
          const ids = models.map((model) => model.id).filter((id) => id !== "default")
          if (!switchModels && ids.length >= 2) switchModels = [ids[0]!, ids[1]!]
        } else {
          const model = step.model ? switchModels?.[step.model === "first" ? 0 : 1] : undefined
          if (step.model && !model) fail(`${tool} listed fewer than two models; pass --models ${tool}=<a>,<b>`, 1)
          Object.assign(entry, {
            prompt: step.prompt,
            decide: step.decide,
            ...(model ? { model } : {}),
            ...(step.resume ? { resume: true } : {}),
            ...(step.bridge ? { bridge: true } : {}),
          })
          if (step.resume && !session) fail(`${scenario.name}: nothing to resume`, 1)
          const options = {
            cwd: dirs.project,
            prompt: step.prompt,
            executable: TAP,
            ask: async () => decision(step.decide),
            ...(model ? { model } : {}),
            ...(step.resume ? { resume: session } : {}),
          }
          const running =
            tool === "claude"
              ? ExternalClaude.start({ ...options, ...(step.bridge ? { mcpConfig: mcpFile } : {}) })
              : ExternalCodex.start({
                  ...options,
                  ...(step.bridge ? { config: { "mcp_servers.lunos": mcpEntry } } : {}),
                })
          const timer = setTimeout(() => running.stop(), 300_000)
          const result = await running.done
          clearTimeout(timer)
          // Wait for the tool to exit, so its last lines and what it writes to HOME are in.
          if (running.child.exitCode === null && running.child.signalCode === null)
            await Promise.race([new Promise((r) => running.child.once("close", r)), Bun.sleep(10_000)])
          if (result.type === "result") session = result.sessionID
          else console.warn(`${scenario.name} step ${index + 1}: ${redact.string(result.message)}`)
        }
        entry.home = diff(before, hashes(dirs.home))
        const entries = existsSync(log)
          ? readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => JSON.parse(l))
          : []
        if (!entries.length) fail(`${scenario.name} step ${index + 1}: nothing was recorded`, 1)
        const problem = flags.fake ? undefined : loginProblem(tool, entries)
        if (problem)
          fail(
            `${problem}. Stopped; nothing written. Run it where no personal login is reachable (docs/external-fixtures.md).`,
            1,
          )
        steps.push(entry)
      }
      manifest.scenarios[scenario.name] = { steps }
      console.log(`${tool} ${found}: recorded ${scenario.name}`)
    }
    // Nothing is copied out while anything identifying is left.
    const written = await fs.readdir(dirs.staging)
    const text = [
      JSON.stringify(manifest, null, 2),
      ...written.map((file) => readFileSync(path.join(dirs.staging, file), "utf8")),
    ]
    const leaks = text.flatMap((body) => scan(body, context.user))
    if (leaks.length)
      fail(
        `the redacted recording still has ${[...new Set(leaks.map((l) => l.kind))].join(", ")}; nothing written (rerun with --keep to inspect the redacted lines)`,
        1,
      )
    await fs.mkdir(outDir, { recursive: true })
    const previous = existsSync(path.join(outDir, "manifest.json"))
      ? (JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8")) as Manifest)
      : undefined
    for (const name of Object.keys(manifest.scenarios))
      for (const old of (await fs.readdir(outDir)).filter((file) => file.startsWith(`${name}.`)))
        await fs.rm(path.join(outDir, old))
    for (const file of written) await fs.copyFile(path.join(dirs.staging, file), path.join(outDir, file))
    manifest.scenarios = { ...previous?.scenarios, ...manifest.scenarios }
    await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    console.log(`${tool} ${found}: written to ${path.relative(process.cwd(), outDir) || outDir}`)
  } finally {
    set(saved as Record<string, string>)
    if (flags.keep) {
      await fs.rm(contextFile, { force: true })
      console.log(`kept ${scratch}`)
    } else await fs.rm(scratch, { recursive: true, force: true })
  }
}

function dryRun(flags: Flags, scenarios: Scenario[]) {
  console.log("Dry run: nothing is started, nothing is written.\n")
  for (const tool of flags.tools) {
    const binary = flags.binary[tool] ?? ExternalDetect.locate(tool) ?? `<${tool} not found on PATH>`
    const keyName = flags.keyEnv[tool]!
    const env = environment(
      { home: "<scratch>/home", tmp: "<scratch>/tmp" },
      tool === "claude" ? { [KEY_VAR.claude]: `<value of $${keyName}>` } : {},
    )
    console.log(
      `# ${tool} (${flags.fake ? "fake, " : ""}key from $${keyName}${process.env[keyName] ? "" : ", which is not set"})`,
    )
    console.log("environment (nothing else of yours is passed):")
    for (const [name, value] of Object.entries(env)) console.log(`  ${name}=${name === "PATH" ? "<your PATH>" : value}`)
    if (tool === "claude") console.log("  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1")
    console.log(`$ ${binary} --version`)
    if (tool === "claude" && !flags.fake)
      console.log(
        `$ ${binary} ${ExternalClaude.args({}).join(" ")}   → stdin: initialize (login check before any prompt)`,
      )
    if (tool === "codex" && !flags.fake) {
      console.log(`$ ${binary} login --with-api-key   (stdin: the value of $${keyName})`)
      console.log(`$ ${binary} login status`)
    }
    const bridge = JSON.stringify({ command: process.execPath, args: [STAND_IN] })
    for (const scenario of scenarios)
      for (const [index, step] of scenario.steps.entries()) {
        const fake = flags.fake && scenario.fake?.[tool]
        console.log(
          `[${scenario.name} ${index + 1}/${scenario.steps.length}] ${describe(tool, binary, step, bridge)}${
            fake
              ? `   (${Object.entries(fake)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")})`
              : ""
          }`,
        )
      }
    console.log(`→ ${path.join(flags.out, `${flags.fake ? "fake-" : ""}${tool}-<version>`)}\n`)
  }
}

async function main() {
  // Before anything else, and before any tool is so much as asked its version.
  if (process.env.LUNOS_RECORD_EXTERNAL !== "1")
    fail(
      "this sends prompts to Anthropic and OpenAI with a test key. Set LUNOS_RECORD_EXTERNAL=1 to confirm (docs/external-fixtures.md).",
    )
  const flags = parse(process.argv.slice(2))
  for (const tool of flags.tools)
    if (!flags.keyEnv[tool])
      fail(
        `--${tool}-key-env <VARIABLE> is required: the name of the variable holding the test key for ${tool}. Your own login is never used.`,
      )
  const scenarios = flags.scenarios.length ? SCENARIOS.filter((s) => flags.scenarios.includes(s.name)) : SCENARIOS
  if (flags.dryRun) return dryRun(flags, scenarios)
  for (const tool of flags.tools) {
    if (!process.env[flags.keyEnv[tool]!]) fail(`$${flags.keyEnv[tool]} is empty`)
    if (!flags.binary[tool] && !ExternalDetect.locate(tool)) fail(`${tool} isn't on PATH; pass --binary ${tool}=<path>`)
    if (flags.fake && !flags.binary[tool]) fail(`--fake needs --binary ${tool}=<path to the fake>`)
  }
  for (const tool of flags.tools) await record(tool, flags, scenarios)
}

if (import.meta.main)
  await main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(`record-external-fixtures: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(error instanceof Failure ? error.code : 1)
    },
  )
