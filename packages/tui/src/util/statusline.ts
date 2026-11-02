// XCOD-335: the status line under the prompt, from a preset, a template or a script. Pure apart from
// the script runner, so parsing, the warning thresholds and the timeout are tested without a terminal.
// The prompt footer and the /settings preview both render through `render`, so they can't disagree.

export const PRESETS = ["default", "minimal", "cost", "git", "agents"] as const
export type Preset = (typeof PRESETS)[number]

export const PRESET_LABEL: Record<Preset, string> = {
  default: "Default",
  minimal: "Minimal",
  cost: "Cost",
  git: "Git",
  agents: "Agents",
}

/** Each preset is a template; Default is the line Lunos has always shown. */
export const PRESET_TEMPLATE: Record<Preset, string> = {
  default: "{context} · {cost_session} · {budget} · {workflows}",
  minimal: "{model} · ctx {context_pct}%",
  cost: "{cost_session} · {budget_left} left · ctx {context_pct}%",
  git: "{branch} · {dirty} changed · ↑{ahead} ↓{behind}",
  agents: "{subagents_running} working · {subagents_waiting} waiting · {subagents_done} done",
}

/** Budget at or past this share of its amount turns the budget fields to the warning colour. */
export const BUDGET_WARNING_PCT = 80
/** Context at or past this share of the model's window turns the context fields to the warning colour. */
export const CONTEXT_WARNING_PCT = 90

export const SCRIPT_TIMEOUT_MS = 300
export const SCRIPT_INTERVAL_MS = 1000
/** After a script fails or times out this many times in a row, it's run less often. */
const BACKOFF_AFTER = 3
const BACKOFF_MS = 5000
const MAX_LINE = 300

/** What Lunos knows that a status line can show; also the JSON a script gets on stdin. */
export type Fields = {
  session_id?: string
  directory?: string
  workflow?: string
  approval?: "Manual" | "Auto"
  model?: string
  provider?: string
  variant?: string
  project?: string
  branch?: string
  /** Changed files in the working tree; undefined when clean or unknown. */
  dirty?: number
  /** Commits ahead of / behind the upstream; undefined without one. */
  ahead?: number
  behind?: number
  context_tokens?: number
  context_pct?: number
  cost_session?: number
  cost_today?: number
  budget_left?: number
  budget_pct?: number
  budget_currency?: "EUR" | "USD"
  /** The budget meter's own line ("€12.30 of €50 this month"), as Default shows it. */
  budget?: string
  /** "Dynamic workflows" (or its narrow form), as Default shows it. */
  workflows?: string
  subagents_running?: number
  subagents_waiting?: number
  subagents_done?: number
  sandbox?: string
  lsp?: "ok" | "starting" | "error"
  mcp?: "ok" | "error"
  version?: string
  update?: string
}

export const FIELD_NAMES = [
  "workflow",
  "approval",
  "model",
  "provider",
  "variant",
  "project",
  "directory",
  "branch",
  "dirty",
  "ahead",
  "behind",
  "context",
  "context_tokens",
  "context_pct",
  "cost_session",
  "cost_today",
  "budget",
  "budget_left",
  "budget_pct",
  "workflows",
  "subagents_running",
  "subagents_waiting",
  "subagents_done",
  "sandbox",
  "lsp",
  "mcp",
  "version",
  "update",
] as const
export type FieldName = (typeof FIELD_NAMES)[number]

/** Theme tokens a segment is drawn in; `text` takes the vendor accent in a Claude Code / Codex session. */
export type Tone = "text" | "muted" | "warning" | "error"
export type Segment = { text: string; tone: Tone }

export type Token = { kind: "text"; text: string } | { kind: "field"; name: FieldName }
export type Parsed = { chunks: { separator: string; tokens: Token[] }[]; unknown: string[] }

const SEPARATOR = / [·|] /g

/**
 * `{field}` placeholders between literal text. ` · ` and ` | ` split the line into chunks; a chunk
 * whose fields are all empty is left out with its separator, so "ctx {context_pct}%" doesn't show
 * as "ctx %" before the first turn. An unknown `{name}` stays as written and is reported.
 */
export function parse(template: string): Parsed {
  const unknown: string[] = []
  const pieces: { separator: string; text: string }[] = []
  let last = 0
  let separator = ""
  for (const match of template.matchAll(SEPARATOR)) {
    pieces.push({ separator, text: template.slice(last, match.index) })
    separator = match[0]
    last = match.index + match[0].length
  }
  pieces.push({ separator, text: template.slice(last) })
  const chunks = pieces.map((piece) => ({
    separator: piece.separator,
    tokens: [...piece.text.matchAll(/\{([a-z_]+)\}|[^{]+|\{/g)].map((match): Token => {
      const name = match[1]
      if (name === undefined) return { kind: "text", text: match[0] }
      if ((FIELD_NAMES as readonly string[]).includes(name)) return { kind: "field", name: name as FieldName }
      if (!unknown.includes(name)) unknown.push(name)
      return { kind: "text", text: match[0] }
    }),
  }))
  return { chunks, unknown }
}

export type Format = { money: (value: number, currency?: "EUR" | "USD") => string; number: (value: number) => string }

const DEFAULT_FORMAT: Format = {
  money: (value, currency) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(value),
  number: (value) => new Intl.NumberFormat("en-US").format(value),
}

/** A field as text, and the colour it's drawn in; undefined when there's nothing to show. */
export function field(name: FieldName, fields: Fields, format: Format = DEFAULT_FORMAT): Segment | undefined {
  const contextTone: Tone = (fields.context_pct ?? 0) >= CONTEXT_WARNING_PCT ? "warning" : "text"
  const budgetTone: Tone = (fields.budget_pct ?? 0) >= BUDGET_WARNING_PCT ? "warning" : "text"
  const show = (value: string | number | undefined, tone: Tone = "text") =>
    value === undefined || value === "" ? undefined : { text: String(value), tone }
  switch (name) {
    case "approval":
      return show(fields.approval, fields.approval === "Auto" ? "warning" : "text")
    case "context": {
      if (fields.context_tokens === undefined) return undefined
      const tokens = format.number(fields.context_tokens)
      return show(fields.context_pct === undefined ? tokens : `${tokens} (${fields.context_pct}%)`, contextTone)
    }
    case "context_tokens":
      return show(fields.context_tokens === undefined ? undefined : format.number(fields.context_tokens), contextTone)
    case "context_pct":
      return show(fields.context_pct, contextTone)
    case "cost_session":
      return show(fields.cost_session ? format.money(fields.cost_session) : undefined)
    case "cost_today":
      return show(fields.cost_today ? format.money(fields.cost_today) : undefined)
    case "budget":
      return show(fields.budget, budgetTone)
    case "budget_left":
      return show(
        fields.budget_left === undefined ? undefined : format.money(fields.budget_left, fields.budget_currency),
        budgetTone,
      )
    case "budget_pct":
      return show(fields.budget_pct, budgetTone)
    case "lsp":
      return show(fields.lsp, fields.lsp === "error" ? "error" : "text")
    case "mcp":
      return show(fields.mcp, fields.mcp === "error" ? "error" : "text")
    case "update":
      return show(fields.update, "warning")
    default:
      return show(fields[name])
  }
}

/**
 * The line as coloured segments. Literal text is muted, fields are drawn in `text` unless a
 * threshold turns them to the warning colour. `muted` draws ordinary fields muted too (Default,
 * which has always been one muted line).
 */
export function render(
  template: string | Parsed,
  fields: Fields,
  options: { muted?: boolean; format?: Format } = {},
): Segment[] {
  const parsed = typeof template === "string" ? parse(template) : template
  const kept = parsed.chunks.flatMap((chunk) => {
    const values = chunk.tokens.map((token) =>
      token.kind === "text"
        ? ({ text: token.text, tone: "muted" } satisfies Segment)
        : field(token.name, fields, options.format),
    )
    const hasField = chunk.tokens.some((token) => token.kind === "field")
    const empty = hasField && chunk.tokens.every((token, index) => token.kind === "text" || !values[index])
    if (empty) return []
    const segments = values
      .filter((value): value is Segment => !!value)
      .map((value) => (options.muted && value.tone === "text" ? { ...value, tone: "muted" as const } : value))
    if (segments.every((segment) => !segment.text.trim())) return []
    return [{ separator: chunk.separator, segments }]
  })
  return merge(
    kept.flatMap((chunk, index) => [
      ...(index > 0 && chunk.separator ? [{ text: chunk.separator, tone: "muted" as const }] : []),
      ...chunk.segments,
    ]),
  )
}

/** Neighbouring segments of one colour as one, so the line draws as few spans as it needs. */
function merge(segments: Segment[]) {
  return segments.reduce<Segment[]>((result, segment) => {
    const previous = result.at(-1)
    if (previous && previous.tone === segment.tone) previous.text += segment.text
    else result.push({ ...segment })
    return result
  }, [])
}

export function plain(segments: readonly Segment[]) {
  return segments.map((segment) => segment.text).join("")
}

export type Config = { preset?: Preset; template?: string; command?: string }

/** What the line is drawn from: a command wins over a template, a template over a preset. */
export function source(config: Config | undefined) {
  if (config?.command?.trim()) return { kind: "command" as const, command: config.command.trim() }
  if (config?.template?.trim()) return { kind: "template" as const, template: config.template }
  const preset = config?.preset ?? "default"
  return { kind: "preset" as const, preset, template: PRESET_TEMPLATE[preset] }
}

/** Which git details the line needs, so `git status` only runs for templates that show them. */
export function needsGitStatus(template: string) {
  return /\{(dirty|ahead|behind)\}/.test(template)
}

/**
 * A script's output as one line: its first non-empty line, without escape sequences or control
 * characters (they'd corrupt the terminal's drawing), cut to a sane length.
 */
export function sanitize(output: string) {
  const line =
    output
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
      .split(/\r?\n/)
      .find((item) => item.trim()) ?? ""
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trimEnd()
  return clean.length > MAX_LINE ? clean.slice(0, MAX_LINE - 1) + "…" : clean
}

/** `git status --porcelain=v2 --branch` as the Git preset's fields. */
export function parseGitStatus(output: string): Pick<Fields, "branch" | "dirty" | "ahead" | "behind"> {
  const lines = output.split("\n")
  const head = lines.find((line) => line.startsWith("# branch.head "))?.slice("# branch.head ".length)
  const ab = lines.find((line) => line.startsWith("# branch.ab "))?.match(/\+(\d+) -(\d+)/)
  const dirty = lines.filter((line) => line && !line.startsWith("#")).length
  return {
    branch: head && head !== "(detached)" ? head : undefined,
    dirty: dirty || undefined,
    ahead: ab ? Number(ab[1]) : undefined,
    behind: ab ? Number(ab[2]) : undefined,
  }
}

export type RunResult = { ok: true; output: string } | { ok: false; reason: "timeout" | "exit" | "spawn" }

/**
 * Runs `argv` with `input` on stdin, and gives up after `timeout` ms: the process (and, on POSIX,
 * everything it started) is killed and the result is a timeout. Never waits on the child past that.
 */
export function run(
  argv: string[],
  input: { stdin?: string; cwd?: string; timeout: number; signal?: AbortSignal },
): Promise<RunResult> {
  const posix = process.platform !== "win32"
  const proc = (() => {
    try {
      return Bun.spawn(argv, {
        cwd: input.cwd,
        stdin: input.stdin === undefined ? "ignore" : new Blob([input.stdin]),
        stdout: "pipe",
        stderr: "ignore",
        // Its own process group, so a timeout kills a script's children too.
        detached: posix,
        env: { ...process.env, LUNOS_STATUSLINE: "1" },
      })
    } catch {
      return undefined
    }
  })()
  if (!proc) return Promise.resolve({ ok: false, reason: "spawn" })
  return new Promise<RunResult>((resolve) => {
    const stop = () => {
      kill(proc.pid, posix)
      resolve({ ok: false, reason: "timeout" })
    }
    const timer = setTimeout(stop, input.timeout)
    // Stopped early (the TUI closing): nothing it started is left behind.
    input.signal?.addEventListener("abort", stop, { once: true })
    Promise.all([new Response(proc.stdout).text(), proc.exited])
      .then(([output, code]) => resolve(code === 0 ? { ok: true, output } : { ok: false, reason: "exit" }))
      .catch(() => resolve({ ok: false, reason: "exit" }))
      .finally(() => {
        clearTimeout(timer)
        input.signal?.removeEventListener("abort", stop)
      })
  })
}

function kill(pid: number, group: boolean) {
  try {
    process.kill(group ? -pid : pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

export function shell(command: string) {
  return process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["/bin/sh", "-c", command]
}

/**
 * Runs a status line script with the session state on stdin, at most once per `interval`, one run
 * at a time, each cut off after `timeout`. `update` never waits: it schedules a run and returns.
 * The last good line is kept through failures and timeouts; a script failing again and again is
 * run less often, so a hung one doesn't fork a process every second.
 */
export function createScriptRunner(input: {
  command: string
  cwd?: string
  timeout?: number
  interval?: number
  onLine: (line: string) => void
  onError?: (reason: "timeout" | "exit" | "spawn") => void
}) {
  const timeout = input.timeout ?? SCRIPT_TIMEOUT_MS
  const interval = input.interval ?? SCRIPT_INTERVAL_MS
  const state = {
    pending: undefined as string | undefined,
    running: false,
    lastStart: 0,
    failures: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    disposed: false,
    line: undefined as string | undefined,
    abort: new AbortController(),
  }

  const gap = () => (state.failures >= BACKOFF_AFTER ? BACKOFF_MS : interval)

  const schedule = () => {
    if (state.disposed || state.running || state.timer || state.pending === undefined) return
    const wait = Math.max(0, state.lastStart + gap() - Date.now())
    state.timer = setTimeout(start, wait)
  }

  const start = () => {
    state.timer = undefined
    const stdin = state.pending
    if (state.disposed || stdin === undefined) return
    state.pending = undefined
    state.running = true
    state.lastStart = Date.now()
    void run(shell(input.command), { stdin, cwd: input.cwd, timeout, signal: state.abort.signal }).then((result) => {
      state.running = false
      if (state.disposed) return
      if (result.ok) {
        state.failures = 0
        state.line = sanitize(result.output)
        input.onLine(state.line)
      } else {
        state.failures += 1
        input.onError?.(result.reason)
      }
      schedule()
    })
  }

  return {
    /** The session state changed: run with it, now or once the interval allows. */
    update(json: string) {
      state.pending = json
      schedule()
    },
    line: () => state.line,
    running: () => state.running,
    dispose() {
      state.disposed = true
      if (state.timer) clearTimeout(state.timer)
      state.timer = undefined
      state.abort.abort()
    },
  }
}
