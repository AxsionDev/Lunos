import { EOL } from "os"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { writeStdoutEffect } from "../stdout"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Memory } from "@/memory"
import { MemoryFailure } from "@/memory/failure"
import { MemorySidecar } from "@/memory/sidecar"

// XCOD-249: `lunos memory check` proves memory works end to end: it remembers a test fact,
// recalls it and forgets it again. The setup wizard (TUI and `lunos memory setup`) runs it in a
// fresh process with the settings it is about to save, since memory settings apply on restart.
// XCOD-263: a failure says which step failed, why and what to do, never an empty reason, and
// carries a redacted `diagnostics` block for a bug report.

export type CheckFailure = {
  ok: false
  error: string
  fix?: string
  scope?: string
  /** The pipeline stage that failed, e.g. "extraction", "embedding", "start". */
  stage?: string | null
  /** The exception class. */
  type?: string | null
  /** The cause chain, outermost first. */
  cause?: string | null
  /** The memory model, "provider/model". */
  model?: string | null
  /** The log with the full traceback. */
  log?: string | null
  /** Sampling requests (the engine asking the memory model) that failed. */
  sampling?: MemoryFailure.Sampling[]
  /** Redacted JSON for a bug report: no fact text, keys or tokens. */
  diagnostics?: string
}

export type CheckResult = { ok: true; scope: string; ms: number } | CheckFailure

/** What to do about a failure, for the errors a user can act on. */
export function checkFix(error: string | MemoryFailure.Info) {
  return MemoryFailure.fix(error)?.text
}

/**
 * A failed check, from whatever the step threw. An engine error keeps the sidecar's stage, type
 * and cause; anything else becomes the same shape with the step as its stage.
 */
export function checkFailure(input: {
  error: unknown
  step?: "remember" | "recall"
  scope?: string
  model?: string
  /** The check's fact text and marker: cut out of the diagnostics. */
  secrets?: readonly string[]
}): CheckFailure {
  const { error, step } = input
  const info: MemoryFailure.Info | undefined =
    error instanceof MemoryFailure.EngineError
      ? error.info
      : error instanceof MemorySidecar.UnavailableError
        ? { type: error.name, message: error.message, cause: [], stage: "start", log: error.log, sampling: [] }
        : step && error instanceof Error
          ? {
              type: error.name,
              message: error.message,
              cause: error.cause instanceof Error ? [`${error.cause.name}: ${error.cause.message}`] : [],
              stage: step,
              dir: pathOf(error),
              sampling: [],
            }
          : undefined
  const full = info && { ...info, model: info.model ?? input.model }
  const message =
    error instanceof MemoryFailure.EngineError && step
      ? `Couldn't ${step} the test fact: ${MemoryFailure.stageLabel(error.info.stage)}, ${MemoryFailure.reason(error.info)}`
      : full
        ? MemoryFailure.reason(full)
        : MemoryFailure.summary(error)
  const fixed = MemoryFailure.fix(full ?? message)
  return {
    ok: false,
    scope: input.scope,
    error: message,
    fix: fixed?.text,
    stage: full?.stage ?? null,
    type: full?.type ?? null,
    cause: full?.cause.length ? full.cause.join(" ← ") : null,
    model: full?.model ?? input.model ?? null,
    log: full?.log ?? null,
    sampling: full?.sampling ?? [],
    diagnostics: MemoryFailure.diagnostics({
      error: message,
      info: full,
      fix: fixed?.kind,
      version: InstallationVersion,
      secrets: input.secrets,
    }),
  }
}

const runCheck = Effect.fn("Cli.memory.check.run")(function* () {
  const memory = yield* Memory.Service
  const verdict = yield* memory.decision()
  const refuse = (error: string) => checkFailure({ error: new Error(error) })
  if (!verdict.on) return refuse(`Memory is off: ${verdict.reason}`)
  const { Provider } = yield* Effect.promise(() => import("@/provider/provider"))
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const { MemoryModel } = yield* Effect.promise(() => import("@/memory/model"))
  const model = yield* Provider.Service.use((provider) => provider.defaultModel()).pipe(Effect.option)
  // XCOD-264: a team database makes no model calls, so it needs no model to be checked.
  const external = (yield* memory.target()).type !== "embedded"
  if (model._tag === "None" && !external) return refuse("No model is configured, and memory needs one to run")
  const parent =
    model._tag === "Some"
      ? { providerID: model.value.providerID, modelID: model.value.modelID }
      : { providerID: "none", modelID: "" }
  const cfg = yield* Config.Service.use((config) => config.get())
  const label = external
    ? undefined
    : (() => {
        try {
          const chosen = MemoryModel.resolve({ memory: cfg.memory, small_model: cfg.small_model, parent }).model
          return `${chosen.providerID}/${chosen.modelID}`
        } catch {
          return undefined
        }
      })()
  const [scope] = yield* memory.scopes()
  if (!scope) return refuse("memory.scope lists no scope")
  const started = Date.now()
  const marker = Math.random().toString(36).slice(2, 10)
  const text = `The Lunos memory check ran on ${new Date().toISOString().slice(0, 10)} (check ${marker}).`
  const failed = (step: "remember" | "recall") => (error: unknown) =>
    Effect.fail(checkFailure({ error, step, scope, model: label, secrets: [text, marker] }))
  const fact = yield* memory
    .remember({
      fact: text,
      source: "memory-check",
      scope,
      sessionID: "memory-check",
      agent: "memory-check",
      parent,
      messages: [],
      kind: "observed",
    })
    .pipe(Effect.catch(failed("remember")))
  // Removed whatever happens next, so a failed recall leaves nothing behind.
  const recalled = yield* memory
    .search({ query: text, parent, limit: 5, origin: "cli" })
    .pipe(
      Effect.catch(failed("recall")),
      Effect.ensuring(memory.forget({ id: fact.id, parent, origin: "cli" }).pipe(Effect.ignore)),
    )
  const found = recalled.some((item) => item.facts.some((hit) => hit.fact.id === fact.id))
  if (!found) return { ...refuse("The test fact was stored but not recalled"), scope }
  return { ok: true as const, scope, ms: Date.now() - started }
})

/** The check's result for a terminal: the reason, the fix, then the details a bug report needs. */
export function checkLine(result: CheckResult) {
  if (result.ok)
    return `✓ Memory works: remembered, recalled and removed a test fact in ${result.scope} memory (${(result.ms / 1000).toFixed(1)} s).`
  return [
    `✗ ${result.error}`,
    ...(result.fix ? [`  Fix: ${result.fix}`] : []),
    ...checkDetails(result).map((line) => `  ${line}`),
  ].join(EOL)
}

/** The "Details" lines: stage, type, cause, model and log, the ones that are known. */
export function checkDetails(result: CheckFailure) {
  return [
    result.stage ? `Stage: ${result.stage}` : undefined,
    result.type ? `Type: ${result.type}` : undefined,
    result.cause ? `Cause: ${result.cause}` : undefined,
    result.model ? `Model: ${result.model}` : undefined,
    result.log ? `Log: ${result.log}` : undefined,
  ].filter((line): line is string => line !== undefined)
}

/** The file a Node filesystem error is about (EACCES, EROFS, ENOSPC carry it). */
function pathOf(error: Error) {
  const file = (error as Error & { path?: unknown }).path
  return typeof file === "string" ? file : undefined
}

function isCheckFailure(value: unknown): value is CheckFailure {
  return typeof value === "object" && value !== null && (value as CheckFailure).ok === false && "diagnostics" in value
}

export const MemoryCheckCommand = effectCmd({
  command: "check",
  describe: "check that memory works: remember, recall and remove a test fact",
  builder: (yargs) => yargs.option("json", { type: "boolean", describe: "print the result as JSON" }),
  handler: Effect.fn("Cli.memory.check")(function* (args: { json?: boolean }) {
    const result: CheckResult = yield* runCheck().pipe(
      Effect.catch((error: unknown) => Effect.succeed(isCheckFailure(error) ? error : checkFailure({ error }))),
    )
    yield* writeStdoutEffect((args.json ? JSON.stringify(result) : checkLine(result)) + EOL)
    if (!result.ok) process.exitCode = 1
  }),
})

/**
 * XCOD-249: `lunos memory setup`, the wizard's steps as prompts. `--yes` takes every recommended
 * answer (for scripts); without a terminal it refuses unless `--yes` is given. It saves through the
 * same settings code as `lunos settings set`, so it writes what the TUI wizard writes.
 */
export const MemorySetupCommand = effectCmd({
  command: "setup",
  describe: "set up memory in a few steps, each with a recommended answer",
  builder: (yargs) =>
    yargs
      .option("yes", { type: "boolean", describe: "accept every recommended answer" })
      .option("project", { type: "boolean", describe: "save to this project's config instead of your user config" })
      .option("check", { type: "boolean", default: true, describe: "run the check (--no-check skips it)" })
      .option("template", { type: "string", describe: "start from a template (see lunos memory templates)" })
      .option("start", {
        type: "boolean",
        describe: "with a Docker template and --yes: start the database (never started without it)",
      })
      .option("vendor", { type: "string", choices: ["neo4j", "postgres"], describe: "team templates: the database" })
      .option("url", { type: "string", describe: "team templates: the database's URL" })
      .option("jurisdiction", { type: "string", describe: 'team templates: where the database runs, e.g. "EU-DE"' }),
  handler: Effect.fn("Cli.memory.setup")(function* (args: {
    yes?: boolean
    project?: boolean
    check?: boolean
    template?: string
    start?: boolean
    vendor?: string
    url?: string
    jurisdiction?: string
  }) {
    const { MemorySetup } = yield* Effect.promise(() => import("@opencode-ai/core/memory-setup"))
    const { ConfigSettings } = yield* Effect.promise(() => import("@/config/settings"))
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { MemorySetupCheck } = yield* Effect.promise(() => import("@/memory/setup-check"))
    const { MemorySetupEnv } = yield* Effect.promise(() => import("@/memory/setup-env"))
    const { MemoryStorage } = yield* Effect.promise(() => import("@opencode-ai/core/memory-storage"))
    const Storage = yield* Effect.promise(() => import("./memory-storage"))
    const { AuditLog } = yield* Effect.promise(() => import("@/audit/log"))
    const prompts = yield* Effect.promise(() => import("@clack/prompts"))
    const say = (text: string) => writeStdoutEffect(text + EOL)

    if (!args.yes && !process.stdin.isTTY) {
      yield* say(
        "lunos memory setup asks a few questions. Run it in a terminal, or add --yes to accept the recommended answers.",
      )
      process.exitCode = 1
      return
    }
    const instance = yield* InstanceRef
    const ctx = { directory: instance?.directory ?? process.cwd(), worktree: instance?.worktree }
    const config = yield* Config.Service.use((cfg) => cfg.get())
    const origins = yield* Config.Service.use((cfg) => cfg.origins())
    const lockedKeys = yield* Effect.promise(() => ConfigSettings.lockedKeys())
    const rows = yield* Effect.promise(() => ConfigSettings.list({ config, origins, locked: lockedKeys, ctx }))
    const memory = config.memory as Parameters<typeof MemorySetup.initial>[0]
    const stop = MemorySetup.blocked(rows, memory)
    if (stop) {
      yield* say(stop)
      process.exitCode = 1
      return
    }
    const scope = args.project ? ("project" as const) : ("user" as const)
    const draft = MemorySetup.initial(memory)
    const cancelled = (value: unknown) => prompts.isCancel(value)
    const ask = <T>(run: () => Promise<T | symbol>) => Effect.promise(run)
    const quit = () => say("Cancelled. Nothing was saved.")

    // XCOD-264: step 2, where memory is stored. With --template it runs with --yes too.
    const storageEnv = yield* MemorySetupEnv.environment()
    let template: { name: string; scope: "user" | "project"; env: Record<string, string> } | undefined
    let notStarted = false
    const storageStep = Effect.fn("Cli.memory.setup.storage")(function* () {
      const outcome = yield* Effect.promise(() =>
        Storage.storage({
          prompts,
          env: storageEnv,
          draft,
          residency: AuditLog.residency(config),
          worktree: ctx.worktree ?? ctx.directory,
          args,
        }),
      )
      if (outcome.kind === "cancel") {
        yield* quit()
        return true
      }
      if (outcome.kind === "fail") {
        yield* say(outcome.message)
        process.exitCode = 1
        return true
      }
      Object.assign(draft, outcome.draft)
      template = outcome.template
      notStarted = !!args.template && !outcome.template && draft.backend.type !== "embedded"
      return false
    })
    if (args.yes && args.template && !MemorySetup.locked(rows, "memory.backend")) {
      if (yield* storageStep()) return
    }

    if (!args.yes) {
      prompts.intro("Set up memory")
      if (!MemorySetup.locked(rows, "memory.enabled")) {
        const on = yield* ask(() =>
          prompts.confirm({
            message: "1/6 Turn on memory? (it remembers facts about your project)",
            initialValue: true,
          }),
        )
        if (cancelled(on)) return yield* quit()
        draft.enabled = on as boolean
      }
      if (draft.enabled && !MemorySetup.locked(rows, "memory.backend")) {
        const failed = yield* storageStep()
        if (failed) return
      }
      if (draft.enabled && !MemorySetup.locked(rows, "memory.model")) {
        const model = yield* ask(() =>
          prompts.text({
            message: "3/6 Which model extracts facts? (empty: the small model)",
            placeholder: "provider/model",
            initialValue: draft.model ?? "",
          }),
        )
        if (cancelled(model)) return yield* quit()
        draft.model = String(model).trim() || undefined
      }
      if (draft.enabled && args.check && draft.backend.type === "embedded") {
        const now = yield* ask(() =>
          prompts.confirm({
            message: `4/6 ${process.env.LUNOS_OFFLINE ? MemorySetup.OFFLINE_DOWNLOAD : MemorySetup.DOWNLOAD} Download now?`,
            initialValue: true,
          }),
        )
        if (cancelled(now)) return yield* quit()
        args.check = now as boolean
      }
      if (draft.enabled && !MemorySetup.locked(rows, "memory.retention.days")) {
        const days = yield* ask(() =>
          prompts.text({
            message: "5/6 Keep facts for how many days? (empty: until you remove them)",
            initialValue: draft.retentionDays ? String(draft.retentionDays) : "",
          }),
        )
        if (cancelled(days)) return yield* quit()
        const parsed = Number(String(days).trim())
        draft.retentionDays = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
      }
      if (draft.enabled && draft.backend.type === "embedded" && !MemorySetup.locked(rows, "memory.encryption")) {
        const encrypt = yield* ask(() =>
          prompts.confirm({
            message: "5/6 Encrypt the fact ledger with the OS keychain? (the engine's own files aren't covered)",
            initialValue: draft.encryption === "os-keychain",
          }),
        )
        if (cancelled(encrypt)) return yield* quit()
        draft.encryption = encrypt ? "os-keychain" : "off"
      }
    }

    let check: CheckResult | undefined
    // A Docker template written but not started has nothing to check yet.
    if (notStarted && args.check)
      yield* say("The check is skipped: start the database first, then run lunos memory check.")
    if (draft.enabled && args.check && !notStarted) {
      yield* say("6/6 Checking memory works (the first run downloads the engine and can take a few minutes)…")
      check = yield* Effect.promise(() =>
        MemorySetupCheck.run({ directory: ctx.directory, memory: MemorySetup.block(draft), env: template?.env }),
      ) as Effect.Effect<CheckResult>
      yield* say(checkLine(check.ok ? check : { ...check, fix: check.fix ?? checkFix(check.error) }))
      // The draft isn't saved yet, so a later `lunos memory check` would test other settings.
      if (!check.ok && check.diagnostics)
        yield* say(`  Diagnostics for a bug report (no fact text, keys or tokens):${EOL}${check.diagnostics}`)
    }

    const writes = MemorySetup.writes(draft, memory, rows)
    // XCOD-264: the summary repeats what the chosen storage means before saving.
    if (draft.enabled) {
      const card = MemoryStorage.cards(storageEnv.environment, {
        host: draft.backend.type === "embedded" ? undefined : hostOf(draft.backend.url),
      }).find((item) => item.kind === draft.backend.type)
      if (card)
        yield* say(
          ["", `Memory will be stored: ${card.title}`, ...MemoryStorage.meaning(card).map((line) => `  ${line}`)].join(
            EOL,
          ),
        )
    }
    for (const line of MemorySetup.conflicts(rows, scope)) yield* say(`Warning: ${line}`)
    // XCOD-264: switching storage asks what happens to the facts already stored, before saving. With
    // --yes the new storage starts empty and the old facts stay where they are.
    let how: unknown = undefined
    if (MemorySetup.switching(memory, draft) && writes.length) {
      how = args.yes
        ? "empty"
        : yield* ask(() =>
            prompts.select({
              message: "You're switching storage. What happens to the facts you have?",
              options: [
                { value: "move", label: "Move my facts", hint: MemorySetup.MOVE.replace(/^Move my facts: /, "") },
                { value: "empty", label: "Start empty", hint: "the old facts stay where they are" },
              ],
            }),
          )
      if (cancelled(how)) return yield* quit()
    }
    if (!args.yes && writes.length) {
      const save = yield* ask(() =>
        prompts.confirm({
          message: `Save ${writes.map((write) => ("unset" in write ? `${write.key} (remove)` : `${write.key} = ${write.value}`)).join(", ")} to the ${scope} config?`,
        }),
      )
      if (cancelled(save) || save !== true) return yield* quit()
    }
    if (how === "empty") yield* say(MemorySetup.START_EMPTY)
    if (how === "move") {
      const moved = yield* moveFacts(MemorySetup.block(draft), template?.env)
      if (!moved.ok) return yield* fail(`Your facts weren't moved, and nothing was saved: ${moved.error}`)
      yield* say(`Moved ${moved.facts ?? 0} fact(s), each with where it came from. The old copy is unchanged.`)
    }
    for (const write of writes) {
      // The same validation and locks as `lunos settings set`; a refusal stops before the next key.
      yield* Effect.tryPromise({
        try: () =>
          "unset" in write
            ? ConfigSettings.unset({ key: write.key, scope, ctx, locked: lockedKeys, via: "lunos memory setup" })
            : ConfigSettings.set({
                key: write.key,
                value: write.value,
                scope,
                ctx,
                locked: lockedKeys,
                via: "lunos memory setup",
              }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          fail(`${write.key} not saved: ${error instanceof Error ? error.message : String(error)}`),
        ),
      )
    }
    yield* say(
      writes.length
        ? `Saved ${writes.length} setting(s) to the ${scope} config. Restart Lunos for memory to use them.`
        : "Nothing changed.",
    )
    if (check && !check.ok) process.exitCode = 1
  }),
})

function hostOf(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

/** Move my facts: export from the storage in use now, import into the new one in a fresh process. */
const moveFacts = Effect.fn("Cli.memory.setup.move")(function* (
  block: Record<string, unknown>,
  env: Record<string, string> | undefined,
) {
  const fs = yield* Effect.promise(() => import("node:fs/promises"))
  const os = yield* Effect.promise(() => import("node:os"))
  const path = yield* Effect.promise(() => import("node:path"))
  const { MemoryExport } = yield* Effect.promise(() => import("@/memory/export"))
  const { MemoryMove } = yield* Effect.promise(() => import("@/memory/move"))
  const { MemoryExternal } = yield* Effect.promise(() => import("@/memory/external"))
  const memory = yield* Memory.Service
  const dir = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "lunos-move-")))
  const bundle = path.join(dir, "bundle")
  return yield* Effect.gen(function* () {
    const exported = yield* MemoryExport.run({
      scopes: yield* memory.scopes(),
      graph: false,
      includeIndex: false,
      zip: false,
      out: bundle,
      directory: dir,
    }).pipe(Effect.result)
    if (exported._tag === "Failure")
      return { ok: false, error: `could not read the facts to move: ${exported.failure.message}` }
    if (!exported.success.manifest.counts.facts.total) return { ok: true, facts: 0 }
    yield* print(`Moving ${exported.success.manifest.counts.facts.total} fact(s)…`)
    return yield* Effect.promise(() =>
      MemoryMove.run({
        directory: process.cwd(),
        memory: block,
        to: MemoryExternal.type(block as never),
        bundle,
        env,
      }),
    )
  }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(dir, { recursive: true, force: true }))))
})

const print = (text: string) => writeStdoutEffect(text + EOL)
