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
  if (model._tag === "None") return refuse("No model is configured, and memory needs one to run")
  const parent = { providerID: model.value.providerID, modelID: model.value.modelID }
  const cfg = yield* Config.Service.use((config) => config.get())
  const label = (() => {
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
      .option("check", { type: "boolean", default: true, describe: "run the check (--no-check skips it)" }),
  handler: Effect.fn("Cli.memory.setup")(function* (args: { yes?: boolean; project?: boolean; check?: boolean }) {
    const { MemorySetup } = yield* Effect.promise(() => import("@opencode-ai/core/memory-setup"))
    const { ConfigSettings } = yield* Effect.promise(() => import("@/config/settings"))
    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
    const { MemorySetupCheck } = yield* Effect.promise(() => import("@/memory/setup-check"))
    const { MemoryExternal } = yield* Effect.promise(() => import("@/memory/external"))
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
        const where = yield* ask(() =>
          prompts.select({
            message: "2/6 Where is memory kept?",
            options: [
              { value: "embedded", label: "On this machine", hint: "recommended" },
              { value: "neo4j", label: "A team Neo4j database" },
            ],
            initialValue: draft.backend.type,
          }),
        )
        if (cancelled(where)) return yield* quit()
        if (where === "neo4j") {
          const field = (message: string, placeholder: string, initialValue?: string) =>
            ask(() => prompts.text({ message, placeholder, initialValue }))
          const url = yield* field("Neo4j URL", "bolt+s://graph.internal:7687")
          if (cancelled(url)) return yield* quit()
          const jurisdiction = yield* field("Where it runs (region)", "EU-DE")
          if (cancelled(jurisdiction)) return yield* quit()
          const username = yield* field("Username", "{env:NEO4J_USER}", "{env:NEO4J_USER}")
          if (cancelled(username)) return yield* quit()
          const password = yield* field(
            "Password (a reference, never the password)",
            "{env:NEO4J_PASSWORD}",
            "{env:NEO4J_PASSWORD}",
          )
          if (cancelled(password)) return yield* quit()
          const backend = {
            type: "neo4j" as const,
            url: String(url),
            jurisdiction: String(jurisdiction),
            username: String(username),
            password: String(password),
          }
          const refused = (() => {
            try {
              MemoryExternal.gate({
                memory: MemorySetup.block({ ...draft, backend, encryption: "off" }) as never,
                residency: AuditLog.residency(config),
              })
              return undefined
            } catch (error) {
              return error instanceof Error ? error.message : String(error)
            }
          })()
          if (refused) {
            yield* say(`That database can't be used: ${refused}`)
            process.exitCode = 1
            return
          }
          draft.backend = backend
          draft.encryption = "off"
        }
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
      if (draft.enabled && args.check) {
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
    if (draft.enabled && args.check) {
      yield* say("6/6 Checking memory works (the first run downloads the engine and can take a few minutes)…")
      check = yield* Effect.promise(() =>
        MemorySetupCheck.run({ directory: ctx.directory, memory: MemorySetup.block(draft) }),
      ) as Effect.Effect<CheckResult>
      yield* say(checkLine(check.ok ? check : { ...check, fix: check.fix ?? checkFix(check.error) }))
      // The draft isn't saved yet, so a later `lunos memory check` would test other settings.
      if (!check.ok && check.diagnostics)
        yield* say(`  Diagnostics for a bug report (no fact text, keys or tokens):${EOL}${check.diagnostics}`)
    }

    const writes = MemorySetup.writes(draft, memory, rows)
    for (const line of MemorySetup.conflicts(rows, scope)) yield* say(`Warning: ${line}`)
    if (!args.yes && writes.length) {
      const save = yield* ask(() =>
        prompts.confirm({
          message: `Save ${writes.map((write) => ("unset" in write ? `${write.key} (remove)` : `${write.key} = ${write.value}`)).join(", ")} to the ${scope} config?`,
        }),
      )
      if (cancelled(save) || save !== true) return yield* quit()
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
