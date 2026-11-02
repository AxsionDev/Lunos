// XCOD-335: the status line's template parsing, warning colours and script runner.
import { describe, expect, test } from "bun:test"
import {
  BUDGET_WARNING_PCT,
  CONTEXT_WARNING_PCT,
  PRESET_TEMPLATE,
  createScriptRunner,
  needsGitStatus,
  parse,
  parseGitStatus,
  plain,
  render,
  run,
  sanitize,
  shell,
  source,
  type Fields,
} from "../../src/util/statusline"

const posix = process.platform !== "win32"

describe("parse", () => {
  test("fields, literal text and separators", () => {
    const parsed = parse("{workflow} · ctx {context_pct}% | {model}")
    expect(parsed.unknown).toEqual([])
    expect(parsed.chunks.map((chunk) => chunk.separator)).toEqual(["", " · ", " | "])
    expect(parsed.chunks[1].tokens).toEqual([
      { kind: "text", text: "ctx " },
      { kind: "field", name: "context_pct" },
      { kind: "text", text: "%" },
    ])
  })

  test("an unknown field stays as written and is reported", () => {
    const parsed = parse("{nope} and {model} {nope}")
    expect(parsed.unknown).toEqual(["nope"])
    expect(plain(render(parsed, { model: "opus" }))).toBe("{nope} and opus {nope}")
  })

  test("a lone brace is literal text", () => {
    expect(plain(render("a { b } {model}", { model: "m" }))).toBe("a { b } m")
  })
})

describe("render", () => {
  test("a chunk whose fields are all empty goes, with its separator", () => {
    expect(plain(render("{model} · ctx {context_pct}% · {branch}", { model: "opus", branch: "dev" }))).toBe(
      "opus · dev",
    )
    expect(plain(render("{model} · ctx {context_pct}%", {}))).toBe("")
    // Literal-only chunks stay.
    expect(plain(render("Lunos · {model}", {}))).toBe("Lunos")
  })

  test("Default reads as the line Lunos has always shown", () => {
    const legacy = (input: { context: string; cost?: string; budget?: string; workflows?: string }) =>
      [input.context, input.cost, input.budget, input.workflows].filter(Boolean).join(" · ")
    const fields: Fields = {
      context_tokens: 12345,
      context_pct: 40,
      cost_session: 1.5,
      budget: "€12.30 of €50 this month",
      workflows: "Dynamic workflows: on · main agent orchestrating",
    }
    expect(plain(render(PRESET_TEMPLATE.default, fields, { muted: true }))).toBe(
      legacy({
        context: "12,345 (40%)",
        cost: "$1.50",
        budget: "€12.30 of €50 this month",
        workflows: "Dynamic workflows: on · main agent orchestrating",
      }),
    )
    expect(plain(render(PRESET_TEMPLATE.default, { context_tokens: 900 }, { muted: true }))).toBe(
      legacy({ context: "900" }),
    )
    // Default is one muted line, apart from warnings.
    expect(render(PRESET_TEMPLATE.default, { context_tokens: 900 }, { muted: true })).toEqual([
      { text: "900", tone: "muted" },
    ])
  })

  test("Cost shows cost, budget left and context", () => {
    const line = render(PRESET_TEMPLATE.cost, {
      cost_session: 2.25,
      budget_left: 47.75,
      budget_pct: 5,
      budget_currency: "EUR",
      context_pct: 12,
    })
    expect(plain(line)).toBe("$2.25 · €47.75 left · ctx 12%")
  })

  test("the warning colour from 80% of a budget and 90% of the context window", () => {
    const tone = (template: string, fields: Fields) => render(template, fields).find((s) => s.tone !== "muted")?.tone
    expect(tone("{budget_left}", { budget_left: 10, budget_pct: BUDGET_WARNING_PCT - 1 })).toBe("text")
    expect(tone("{budget_left}", { budget_left: 10, budget_pct: BUDGET_WARNING_PCT })).toBe("warning")
    expect(tone("{budget}", { budget: "€40 of €50", budget_pct: 95 })).toBe("warning")
    expect(tone("{context_pct}", { context_pct: CONTEXT_WARNING_PCT - 1 })).toBe("text")
    expect(tone("{context_pct}", { context_pct: CONTEXT_WARNING_PCT })).toBe("warning")
    expect(tone("{context}", { context_tokens: 1000, context_pct: 91 })).toBe("warning")
    // Warnings stand out on Default's muted line too.
    expect(render("{context}", { context_tokens: 1000, context_pct: 91 }, { muted: true }).map((s) => s.tone)).toEqual([
      "warning",
    ])
    expect(tone("{approval}", { approval: "Auto" })).toBe("warning")
    expect(tone("{approval}", { approval: "Manual" })).toBe("text")
    expect(tone("{lsp}", { lsp: "error" })).toBe("error")
  })

  test("literal text is muted, fields are text", () => {
    expect(render("ctx {context_pct}%", { context_pct: 3 })).toEqual([
      { text: "ctx ", tone: "muted" },
      { text: "3", tone: "text" },
      { text: "%", tone: "muted" },
    ])
  })

  test("Agents and Git hide what isn't there", () => {
    expect(plain(render(PRESET_TEMPLATE.agents, {}))).toBe("")
    expect(
      plain(render(PRESET_TEMPLATE.agents, { subagents_running: 2, subagents_waiting: 1, subagents_done: 0 })),
    ).toBe("2 working · 1 waiting · 0 done")
    expect(plain(render(PRESET_TEMPLATE.git, { branch: "dev", ahead: 1, behind: 0 }))).toBe("dev · ↑1 ↓0")
  })
})

describe("source", () => {
  test("a command wins over a template, a template over a preset", () => {
    expect(source(undefined)).toEqual({ kind: "preset", preset: "default", template: PRESET_TEMPLATE.default })
    expect(source({ preset: "cost" }).kind).toBe("preset")
    expect(source({ preset: "cost", template: "{model}" })).toEqual({ kind: "template", template: "{model}" })
    expect(source({ template: "{model}", command: " ~/bin/line " })).toEqual({
      kind: "command",
      command: "~/bin/line",
    })
    expect(source({ template: "  ", command: "" }).kind).toBe("preset")
  })

  test("git status only runs for templates that need it", () => {
    expect(needsGitStatus(PRESET_TEMPLATE.git)).toBe(true)
    expect(needsGitStatus(PRESET_TEMPLATE.cost)).toBe(false)
  })
})

describe("parseGitStatus", () => {
  test("branch, changed files, ahead and behind", () => {
    const output = [
      "# branch.oid abc",
      "# branch.head feature",
      "# branch.upstream origin/feature",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 a b src/a.ts",
      "? new.txt",
      "",
    ].join("\n")
    expect(parseGitStatus(output)).toEqual({ branch: "feature", dirty: 2, ahead: 2, behind: 3 })
    expect(parseGitStatus("# branch.head (detached)\n")).toEqual({
      branch: undefined,
      dirty: undefined,
      ahead: undefined,
      behind: undefined,
    })
  })
})

describe("sanitize", () => {
  test("first line, no escape sequences or control characters, cut to length", () => {
    expect(sanitize("\n\x1b[31mred\x1b[0m line\nsecond")).toBe("red line")
    expect(sanitize("a\x07b\tc")).toBe("abc")
    expect(sanitize("\x1b]0;title\x07ok")).toBe("ok")
    expect(sanitize("x".repeat(400)).length).toBe(300)
  })
})

describe.skipIf(!posix)("script runner", () => {
  test("a script gets the session as JSON on stdin and its line is shown", async () => {
    const result = await run(shell("cat"), { stdin: JSON.stringify({ model: "opus" }), timeout: 2000 })
    expect(result).toEqual({ ok: true, output: '{"model":"opus"}' })
  })

  test("a slow script is cut off at the timeout, without waiting for it", async () => {
    const started = Date.now()
    const result = await run(shell("sleep 2; echo late"), { timeout: 100 })
    expect(result).toEqual({ ok: false, reason: "timeout" })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("a timeout kills what the script started too, and so does closing", async () => {
    const dir = await import("os").then((os) => os.tmpdir())
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const pidfile = `${dir}/statusline-child-${process.pid}-${Date.now()}`
    const script = `sleep 30 & echo $! > ${pidfile}; wait`
    expect(await run(shell(script), { timeout: 200 })).toEqual({ ok: false, reason: "timeout" })
    await Bun.sleep(100)
    expect(alive(Number((await Bun.file(pidfile).text()).trim()))).toBe(false)

    const runner = createScriptRunner({ command: script, timeout: 10_000, onLine: () => {} })
    runner.update("{}")
    await Bun.sleep(300)
    const child = Number((await Bun.file(pidfile).text()).trim())
    expect(alive(child)).toBe(true)
    runner.dispose()
    await Bun.sleep(100)
    expect(alive(child)).toBe(false)
    await Bun.$`rm -f ${pidfile}`.quiet()
  })

  test("a failing script is a failure", async () => {
    expect(await run(shell("echo nope; exit 1"), { timeout: 2000 })).toEqual({ ok: false, reason: "exit" })
  })

  test("update returns at once, and a failing or slow script keeps the last good line", async () => {
    const dir = await import("os").then((os) => os.tmpdir())
    const flag = `${dir}/statusline-${process.pid}-${Date.now()}`
    // Good the first time, then slow (past the timeout), then failing.
    const command = `if [ ! -e ${flag} ]; then touch ${flag}; read x; echo "line: $x"; elif [ ! -e ${flag}.2 ]; then touch ${flag}.2; sleep 2; else exit 3; fi`
    const lines: string[] = []
    const errors: string[] = []
    const runner = createScriptRunner({
      command,
      timeout: 150,
      interval: 50,
      onLine: (line) => lines.push(line),
      onError: (reason) => errors.push(reason),
    })
    const started = Date.now()
    runner.update("first")
    // Never blocks the caller (the render loop): scheduling is all update does.
    expect(Date.now() - started).toBeLessThan(20)
    await Bun.sleep(300)
    expect(lines).toEqual(["line: first"])
    runner.update("second")
    await Bun.sleep(400)
    runner.update("third")
    await Bun.sleep(300)
    runner.dispose()
    expect(errors).toEqual(["timeout", "exit"])
    expect(lines).toEqual(["line: first"])
    expect(runner.line()).toBe("line: first")
    await Bun.$`rm -f ${flag} ${flag}.2`.quiet()
  })

  test("runs at most once per interval, with the latest state", async () => {
    const seen: string[] = []
    const runner = createScriptRunner({ command: "cat", interval: 400, onLine: (line) => seen.push(line) })
    runner.update("1")
    await Bun.sleep(100)
    runner.update("2")
    runner.update("3")
    await Bun.sleep(150)
    // Still inside the interval: only the first ran.
    expect(seen).toEqual(["1"])
    await Bun.sleep(500)
    runner.dispose()
    expect(seen).toEqual(["1", "3"])
  })
})
