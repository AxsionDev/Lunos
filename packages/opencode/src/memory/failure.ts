export * as MemoryFailure from "./failure"

import os from "node:os"
import { Audit } from "@opencode-ai/core/audit"

/**
 * XCOD-263: why memory failed, as a structured error rather than a bare message. The sidecar
 * reports the exception's type, message, cause chain, pipeline stage and log file; Lunos adds the
 * sampling requests it failed to answer during the call and the model it answers them with.
 *
 * Shared by `lunos memory check` (and so the setup wizard) and anything else that has to explain an
 * engine failure: `reason` never returns an empty string, `fix` says what to do for the failures a
 * user can act on, and `diagnostics` is the redacted block "Copy diagnostics" puts on the clipboard.
 * No Effect or server imports, so any memory backend can use it.
 */

/** Where it failed. The engine's pipeline stages, or the Lunos step around them. */
export type Stage =
  | "start"
  | "setup"
  | "add"
  | "extraction"
  | "embedding"
  | "graph"
  | "database"
  | "remember"
  | "recall"
  | "forget"
  | "check"
  | (string & {})

/** A sampling request (the engine asking Lunos's model) that failed during the call. */
export interface Sampling {
  provider: string
  model: string
  message: string
}

export interface Info {
  /** The exception class, e.g. `InstructorRetryException`, `PermissionError`, `TimeoutError`. */
  type: string
  /** Its message; may be empty, which is what `reason` exists for. */
  message: string
  /** The cause chain, outermost first, as "Type: message". */
  cause: string[]
  stage: Stage
  /** The log file (or logs folder) with the full traceback. */
  log?: string
  /** The memory directory, for disk and permission errors. */
  dir?: string
  /** "provider/model" that answers the engine's sampling requests. */
  model?: string
  errno?: number
  sampling: Sampling[]
}

/** An engine failure. Its message is never empty: `Memory <tool> failed: <reason>`. */
export class EngineError extends Error {
  override name = "MemoryEngineError"
  constructor(
    readonly tool: string,
    readonly info: Info,
  ) {
    super(`Memory ${tool} failed: ${reason(info)}`)
  }
}

/** What FastMCP prefixes a tool's exception with. With an empty `str(e)` nothing follows it. */
const FASTMCP = /^Error executing tool \w+:\s*/

/** Cognee's wrapper around a failed cognify, which says nothing the cause doesn't. */
const COGNIFY = /^CognifyFailedError: Cognify failed for dataset (?:'\[.*?\]'|'[^']*'): /
const RAISE_ON_ERROR = /\s*\|\s*Pass raise_on_error=False.*$/

/**
 * The failed sampling request, or the message's first line, or the exception type when the engine
 * gave no message. Never empty.
 */
export function reason(info: Pick<Info, "type" | "message" | "sampling">) {
  const failed = info.sampling.at(-1)
  if (failed) return `the model ${failed.provider}/${failed.model} failed: ${failed.message || "no message"}`
  const message = (info.message.split("\n").find((line) => line.trim()) ?? "")
    .replace(FASTMCP, "")
    .replace(COGNIFY, "")
    .replace(RAISE_ON_ERROR, "")
    .trim()
  if (message && message !== "None") return message
  return `the memory engine stopped with ${info.type || "an error"} and no message`
}

const STAGE_LABELS: Record<string, string> = {
  start: "while starting the memory engine",
  setup: "while preparing the memory databases",
  add: "while adding it",
  extraction: "during extraction",
  embedding: "while computing embeddings",
  graph: "while writing the graph",
  database: "while writing the memory database",
  remember: "while storing it",
  recall: "while searching",
  forget: "while removing it",
}

export function stageLabel(stage: Stage) {
  return STAGE_LABELS[stage] ?? `during ${stage}`
}

/**
 * A thrown value as one line: status code, then the message's first line (or the error's name when
 * it's empty), with key-shaped strings masked: a provider error can echo the key it was given.
 */
export function summary(error: unknown): string {
  if (!(error instanceof Error)) return String(error ?? "").trim() || "unknown error"
  const status =
    (error as { statusCode?: unknown; status?: unknown }).statusCode ?? (error as { status?: unknown }).status
  const message = Audit.redact(error.message.split("\n")[0]!.trim() || `${error.name} with no message`)
  return typeof status === "number" && !message.includes(String(status)) ? `${status} ${message}` : message
}

export interface Context {
  /** Sampling requests that failed while the call was running. */
  sampling: Sampling[]
  /** Whether the engine asked for the model at all during the call. */
  sampled: boolean
  log?: string
  dir?: string
  model?: string
}

type ToolResult = { isError?: boolean; content?: unknown; structuredContent?: unknown }

/**
 * The failure in a sidecar tool result, or undefined when it succeeded. The sidecar returns
 * `{ error: {...} }`; an `isError` result (bad arguments, or a sidecar without XCOD-263) only has
 * text. A failed sampling request during the call means the stage was extraction, whatever frame
 * the engine raised from.
 */
export function fromToolResult(tool: string, result: ToolResult, context: Context): Info | undefined {
  const structured = result.structuredContent as { error?: Partial<Info> & { cause?: unknown } } | undefined
  const reported = structured?.error ?? (result.isError ? undefined : parsedError(result))
  if (!reported && !result.isError) return undefined
  const base: Info = reported
    ? {
        type: String(reported.type || "Error"),
        message: String(reported.message ?? ""),
        cause: Array.isArray(reported.cause) ? reported.cause.map(String) : [],
        stage: String(reported.stage || tool),
        log: typeof reported.log === "string" && reported.log ? reported.log : context.log,
        errno: typeof reported.errno === "number" ? reported.errno : undefined,
        sampling: [],
      }
    : {
        type: "ToolError",
        message: text(result).replace(FASTMCP, "").trim(),
        cause: [],
        stage: tool,
        log: context.log,
        sampling: [],
      }
  return withContext(base, context)
}

/** A call that never came back: a timeout, the sidecar exiting, the connection closing. */
export function fromThrown(tool: string, error: unknown, context: Context): Info {
  const timeout = isTimeout(error)
  return withContext(
    {
      type: timeout ? "TimeoutError" : error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error ?? ""),
      cause: causes(error),
      stage: timeout && context.sampled ? "extraction" : tool,
      log: context.log,
      sampling: [],
    },
    context,
  )
}

function withContext(info: Info, context: Context): Info {
  // The engine retries, so the same failure usually comes back several times: keep each once.
  const sampling = context.sampling.filter(
    (item, index, all) =>
      all.findIndex(
        (other) => other.provider === item.provider && other.model === item.model && other.message === item.message,
      ) === index,
  )
  return {
    ...info,
    stage: context.sampling.length ? "extraction" : info.stage,
    dir: info.dir ?? context.dir,
    model: info.model ?? context.model,
    sampling: sampling.slice(-5),
  }
}

function text(result: ToolResult) {
  return ((result.content ?? []) as { type: string; text?: string }[])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("")
}

function parsedError(result: ToolResult): (Partial<Info> & { cause?: unknown }) | undefined {
  if (result.structuredContent) return undefined
  try {
    return (JSON.parse(text(result)) as { error?: Partial<Info> }).error
  } catch {
    return undefined
  }
}

function isTimeout(error: unknown) {
  return (
    (error as { code?: unknown })?.code === -32001 ||
    (error instanceof Error && (error.name === "TimeoutError" || /timed? ?out/i.test(error.message)))
  )
}

function causes(error: unknown) {
  const out: string[] = []
  let current = error instanceof Error ? error.cause : undefined
  while (current !== undefined && out.length < 5) {
    out.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return out
}

export type FixKind =
  | "uv"
  | "python"
  | "offline"
  | "no-model"
  | "model-residency"
  | "residency"
  | "rate-limit"
  | "unreachable"
  | "timeout"
  | "storage"
  | "locked"
  | "embedding-download"
  | "structured-output"
  | "unknown"

/**
 * What to do about a failure, for the ones a user can act on; undefined otherwise. Takes a message
 * (a failure Lunos raised itself, e.g. no model) or an engine `Info`. Order matters: a refusal of
 * the memory model by residency is told apart from a database outside the allowed regions, and a
 * rate limit or timeout that instructor wrapped as a retry error isn't taken for bad output.
 */
export function fix(input: string | Info): { kind: FixKind; text: string } | undefined {
  const info = typeof input === "string" ? undefined : input
  const all = info
    ? [info.type, info.message, ...info.cause, ...info.sampling.map((item) => item.message)].join("\n")
    : (input as string)
  const model = info?.model ? `memory.model (now ${info.model})` : "memory.model"
  if (/uv \(https|needs uv/i.test(all))
    return { kind: "uv", text: "Install uv (https://docs.astral.sh/uv/), then run the check again." }
  // Only before the engine runs: a later traceback's paths contain "python3.12" too.
  if ((!info || info.stage === "start") && /python/i.test(all) && /3\.1[0-3]|not found|no interpreter/i.test(all))
    return { kind: "python", text: "Install Python 3.10–3.13 (uv finds it on PATH), then run the check again." }
  if (/offline|LUNOS_OFFLINE/i.test(all))
    return {
      kind: "offline",
      text: "Offline, the first start needs uv's and Hugging Face's caches already filled. Run the check once with network access, or see the memory docs on pre-seeding.",
    }
  if (/no model is configured/i.test(all))
    return { kind: "no-model", text: "Connect a provider with /providers, or set memory.model." }
  if (/residency|jurisdiction/i.test(all)) {
    if (info?.sampling.length || /memory\.(model|embedding)\b[^\n]*denied/i.test(all))
      return {
        kind: "model-residency",
        text: `Choose a ${model} your residency policy allows in Memory › Settings, then run the check again.`,
      }
    return { kind: "residency", text: "Pick a database in a region your residency policy allows." }
  }
  if (/\b429\b|rate.?limit|quota|too many requests|overloaded/i.test(all))
    return {
      kind: "rate-limit",
      text: `The provider is rate limiting or out of quota. Wait a minute and run the check again, or choose another ${model}.`,
    }
  if (
    info?.sampling.length &&
    /cannot connect|unable to connect|ECONNREFUSED|ENOTFOUND|fetch failed|network error|getaddrinfo/i.test(all)
  )
    return {
      kind: "unreachable",
      text: `Lunos couldn't reach the provider of ${model}. Check the network and the provider's settings, or choose another ${model}.`,
    }
  if (info?.type === "TimeoutError" || /timed? ?out|TimeoutError|deadline exceeded/i.test(all))
    return {
      kind: "timeout",
      text: `${info?.stage === "extraction" ? "Extraction" : "The memory engine"} took too long. Run the check again, or choose a faster ${model}.`,
    }
  if (
    (info?.errno !== undefined && [1, 13, 28, 30].includes(info.errno)) ||
    /PermissionError|Permission denied|Read-only file system|No space left|EACCES|EROFS|ENOSPC|EPERM/i.test(all)
  )
    return {
      kind: "storage",
      text: `Lunos can't write to the memory directory${info?.dir ? ` ${info.dir}` : ""}. Make sure it's writable and the disk has free space, then run the check again.`,
    }
  if (/database is locked|could not set lock|lock(ed)? by another|resource temporarily unavailable|EAGAIN/i.test(all))
    return {
      kind: "locked",
      text: "Another Lunos process has this memory open. Close it (or wait for it to finish), then run the check again.",
    }
  if (
    info?.stage === "embedding" ||
    /huggingface|hf_hub|fastembed|LocalEntryNotFound|snapshot_download|embedding model/i.test(all)
  )
    return {
      kind: "embedding-download",
      text: "The embedding model couldn't be loaded or downloaded. Check the network connection, or set LUNOS_MEMORY_MODELS to a directory that already holds it, then run the check again.",
    }
  if (
    /Instructor\w*Exception|ValidationError|JSONDecodeError|didn'?t match the schema|not valid JSON|invalid json|structured output|json_invalid|Expecting value/i.test(
      all,
    )
  )
    return {
      kind: "structured-output",
      text: `The model didn't return valid structured output. Choose a different ${model} in Memory › Settings, or run the check again.`,
    }
  // An engine failure nothing above explains still gets a next step; a plain message doesn't.
  if (info)
    return {
      kind: "unknown",
      text: `Run the check again. If it fails the same way, attach Copy diagnostics${info.log ? ` and ${info.log}` : ""} to a bug report.`,
    }
  return undefined
}

/**
 * One line of a message, safe for a bug report: the first line only, capped, with key- and
 * token-shaped strings masked (the audit log's patterns), anything a validation error echoed back
 * (`input_value=...`, long quoted strings: they hold the model's output, which repeats the fact)
 * cut, the given secrets (the fact text) removed, and the home directory shortened to `~`.
 */
export function redact(text: string, secrets: readonly string[] = []) {
  let out =
    text
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? ""
  for (const secret of secrets) if (secret) out = out.split(secret).join("<fact>")
  out = out
    .replace(/input_value=.*$/, "input_value=<omitted>")
    .replace(/(?<![\p{L}\p{N}])(["'`])(?:(?!\1).){24,}\1/gu, "<omitted>")
  out = Audit.redact(out)
  const home = os.homedir()
  if (home && home !== "/") out = out.split(home).join("~")
  return out.length > 200 ? out.slice(0, 199) + "…" : out
}

/** The "Copy diagnostics" block: which step failed and why, never the fact, a key or a token. */
export function diagnostics(input: {
  error: string
  info?: Info
  fix?: FixKind
  version: string
  secrets?: readonly string[]
}) {
  const secrets = input.secrets ?? []
  const info = input.info
  return JSON.stringify(
    {
      lunos: input.version,
      platform: `${process.platform}-${process.arch}`,
      error: redact(input.error, secrets),
      stage: info?.stage ?? null,
      type: info?.type ?? null,
      fix: input.fix ?? null,
      cause: info?.cause.map((item) => redact(item, secrets)) ?? [],
      model: info?.model ?? null,
      sampling: info?.sampling.map((item) => ({ ...item, message: redact(item.message, secrets) })) ?? [],
      log: info?.log ? redact(info.log) : null,
    },
    null,
    2,
  )
}
