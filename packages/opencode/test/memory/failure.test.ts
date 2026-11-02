import { describe, expect, test } from "bun:test"
import os from "node:os"
import { MemoryFailure } from "../../src/memory/failure"
import { MemorySetupCheck } from "../../src/memory/setup-check"
import { MemorySidecar } from "../../src/memory/sidecar"
import { checkFailure, checkFix, checkLine } from "../../src/cli/cmd/memory-setup"

const LOG = "/m/logs/2026-10-19_10-00-00.log"
const none: MemoryFailure.Context = { sampling: [], sampled: false, model: "mistral/mistral-small-latest" }
const sampled: MemoryFailure.Context = { ...none, sampled: true }
const structured = (error: Record<string, unknown>) => ({ structuredContent: { error: { log: LOG, ...error } } })
const EMPTY_TAIL = /Memory \w+ failed:\s*$/

describe("XCOD-263: an engine failure is never an empty reason", () => {
  const cases: [string, Parameters<typeof MemoryFailure.fromToolResult>[1]][] = [
    ["an isError result with empty text", { isError: true, content: [{ type: "text", text: "" }] }],
    [
      "the bare FastMCP prefix",
      { isError: true, content: [{ type: "text", text: "Error executing tool remember: " }] },
    ],
    ["an isError result with no content", { isError: true, content: [] }],
    ["a structured error with an empty message", structured({ type: "CogneeSystemError", message: "" })],
    ["a structured error with no fields at all", { structuredContent: { error: {} } }],
  ]
  for (const [name, result] of cases)
    test(name, () => {
      const info = MemoryFailure.fromToolResult("remember", result, none)!
      const error = new MemoryFailure.EngineError("remember", info)
      expect(error.message).not.toMatch(EMPTY_TAIL)
      expect(MemoryFailure.reason(info).trim()).not.toBe("")
      expect(MemoryFailure.reason(info)).not.toContain("Error executing tool")
    })

  test("a thrown value with no message, and the fallback names the type", () => {
    const info = MemoryFailure.fromThrown("recall", new Error(""), none)
    expect(new MemoryFailure.EngineError("recall", info).message).toBe(
      "Memory recall failed: the memory engine stopped with Error and no message",
    )
    expect(MemoryFailure.reason({ type: "", message: "", sampling: [] })).toBe(
      "the memory engine stopped with an error and no message",
    )
  })

  test("a successful result is not a failure; the existing duplicate-fact error keeps its message", () => {
    expect(MemoryFailure.fromToolResult("remember", { structuredContent: { id: "a", dataset_id: "b" } }, none)).toBe(
      undefined,
    )
    const message = "expected one new data item, found 0 (is this fact already stored?)"
    const info = MemoryFailure.fromToolResult("remember", structured({ type: "RuntimeError", message }), none)!
    expect(MemoryFailure.reason(info)).toBe(message)
  })

  test("cognee's wrapper and multi-line validation output are trimmed to the line that says why", () => {
    const message =
      "CognifyFailedError: Cognify failed for dataset '[UUID('2ef2')]': ValueError: MCP sampling could not produce structured output matching KnowledgeGraph after 5 attempts.\n  Invalid JSON [input_value='Sure!'] | Pass raise_on_error=False to get the original exception instead. (Status code: 422)"
    expect(MemoryFailure.reason({ type: "CognifyFailedError", message, sampling: [] })).toBe(
      "ValueError: MCP sampling could not produce structured output matching KnowledgeGraph after 5 attempts.",
    )
    expect(
      MemoryFailure.reason({
        type: "CognifyFailedError",
        message: "CognifyFailedError: Cognify failed for dataset 'x': None | Pass raise_on_error=False to get it",
        sampling: [],
      }),
    ).toBe("the memory engine stopped with CognifyFailedError and no message")
    expect(MemoryFailure.reason({ type: "McpError", message: "None", sampling: [] })).toContain(
      "McpError and no message",
    )
  })

  test("a failing check that printed nothing still says why", () => {
    const result = MemorySetupCheck.unparsed({ code: 1, stderr: "" })
    expect(result.error).toBe("The check exited with code 1 and printed nothing")
    const crashed = MemorySetupCheck.unparsed({ code: 1, stderr: "Traceback\n  frame\nKeyError: 'x'\n\n" })
    expect(crashed.error).toBe("KeyError: 'x'")
    expect(crashed.cause).toBe("Traceback\n  frame")
    expect(MemorySetupCheck.unparsed({ code: null, stderr: "" }).error).toContain("11 minutes")
  })
})

describe("XCOD-263: each simulated failure has a reason, the right stage and a fix", () => {
  const cases: {
    name: string
    info: () => MemoryFailure.Info
    stage: string
    kind: MemoryFailure.FixKind
    reason?: RegExp
  }[] = [
    {
      name: "an exception with an empty message in cognee.remember",
      info: () =>
        MemoryFailure.fromToolResult(
          "remember",
          structured({ type: "CogneeSystemError", message: "", stage: "remember" }),
          none,
        )!,
      stage: "remember",
      kind: "unknown",
      reason: /CogneeSystemError and no message/,
    },
    {
      name: "a failed sampling request (provider 429)",
      info: () =>
        MemoryFailure.fromToolResult(
          "remember",
          structured({ type: "InstructorRetryException", message: "", stage: "graph" }),
          {
            ...sampled,
            sampling: [{ provider: "mistral", model: "mistral-small-latest", message: "429 rate limited" }],
          },
        )!,
      stage: "extraction",
      kind: "rate-limit",
      reason: /mistral\/mistral-small-latest failed: 429 rate limited/,
    },
    {
      name: "a residency refusal",
      info: () =>
        MemoryFailure.fromToolResult("remember", structured({ type: "McpError", message: "", stage: "extraction" }), {
          ...sampled,
          sampling: [
            {
              provider: "openai",
              model: "gpt-5-mini",
              message: "Blocked by data-residency policy. openai is not in the allowed jurisdictions (EU)",
            },
          ],
        })!,
      stage: "extraction",
      kind: "model-residency",
    },
    {
      name: "a model returning invalid JSON",
      info: () =>
        MemoryFailure.fromToolResult(
          "remember",
          structured({
            type: "InstructorRetryException",
            message: "",
            cause: ["ValidationError: 1 validation error for KnowledgeGraph"],
            stage: "extraction",
          }),
          sampled,
        )!,
      stage: "extraction",
      kind: "structured-output",
    },
    {
      name: "an embedding download failure",
      info: () =>
        MemoryFailure.fromToolResult(
          "remember",
          structured({
            type: "LocalEntryNotFoundError",
            message: "Cannot find the requested files",
            stage: "embedding",
          }),
          none,
        )!,
      stage: "embedding",
      kind: "embedding-download",
    },
    {
      name: "a read-only memory directory",
      info: () =>
        MemoryFailure.fromToolResult(
          "remember",
          structured({
            type: "OSError",
            message: "[Errno 30] Read-only file system: '/m/data'",
            stage: "add",
            errno: 30,
          }),
          { ...none, dir: "/m" },
        )!,
      stage: "add",
      kind: "storage",
    },
    {
      name: "a timeout during extraction",
      info: () =>
        MemoryFailure.fromThrown("remember", Object.assign(new Error("Request timed out"), { code: -32001 }), sampled),
      stage: "extraction",
      kind: "timeout",
    },
    {
      name: "a provider that can't be reached",
      info: () =>
        MemoryFailure.fromToolResult("remember", structured({ type: "CognifyFailedError", message: "McpError: x" }), {
          ...sampled,
          sampling: [{ provider: "fake", model: "m", message: "Cannot connect to API: Unable to connect." }],
        })!,
      stage: "extraction",
      kind: "unreachable",
    },
    {
      name: "the database locked by another Lunos",
      info: () =>
        MemoryFailure.fromToolResult(
          "remember",
          structured({ type: "RuntimeError", message: "IO exception: Could not set lock on file", stage: "graph" }),
          none,
        )!,
      stage: "graph",
      kind: "locked",
    },
  ]
  for (const item of cases)
    test(item.name, () => {
      const info = item.info()
      expect(info.stage).toBe(item.stage)
      expect(MemoryFailure.reason(info).trim()).not.toBe("")
      if (item.reason) expect(MemoryFailure.reason(info)).toMatch(item.reason)
      const fix = MemoryFailure.fix(info)
      expect(fix?.kind).toBe(item.kind)
      expect(fix?.text.length).toBeGreaterThan(10)
    })

  test("the fix for a storage error names the memory directory; the model fixes name memory.model", () => {
    const storage = MemoryFailure.fix({
      type: "PermissionError",
      message: "",
      cause: [],
      stage: "add",
      errno: 13,
      dir: "/m",
      sampling: [],
    })
    expect(storage?.text).toContain("/m")
    const json = MemoryFailure.fix({
      type: "InstructorRetryException",
      message: "JSONDecodeError",
      cause: [],
      stage: "extraction",
      model: "a/b",
      sampling: [],
    })
    expect(json?.text).toContain("memory.model (now a/b)")
  })

  test("a model residency refusal isn't given the database-region fix, and the old fixes still apply", () => {
    expect(checkFix("memory.model → openai/gpt-5 denied by residency policy. not in EU")).toContain("memory.model")
    expect(checkFix("Blocked by data-residency policy. memory.backend declares jurisdiction")).toContain("region")
    expect(checkFix("Memory needs uv (https://docs.astral.sh/uv/) and Python 3.10–3.13")).toContain("Install uv")
    expect(checkFix("something else")).toBeUndefined()
    // A traceback path mentioning python3.12 is not a missing Python.
    expect(
      MemoryFailure.fix({
        type: "FileNotFoundError",
        message: "/x/lib/python3.12/y not found",
        cause: [],
        stage: "add",
        sampling: [],
      })?.kind,
    ).not.toBe("python")
  })
})

describe("XCOD-263: the check's result", () => {
  const info: MemoryFailure.Info = {
    type: "InstructorRetryException",
    message: "",
    cause: ["ValidationError: 1 validation error for KnowledgeGraph"],
    stage: "extraction",
    log: LOG,
    model: "mistral/mistral-small-latest",
    sampling: [],
  }

  test("names the step, the stage and the reason, with stage, type, cause, model and log for --json", () => {
    const result = checkFailure({
      error: new MemoryFailure.EngineError("remember", info),
      step: "remember",
      scope: "project",
    })
    expect(result.error).toBe(
      "Couldn't remember the test fact: during extraction, the memory engine stopped with InstructorRetryException and no message",
    )
    expect(result).toMatchObject({
      ok: false,
      scope: "project",
      stage: "extraction",
      type: "InstructorRetryException",
      cause: "ValidationError: 1 validation error for KnowledgeGraph",
      model: "mistral/mistral-small-latest",
      log: LOG,
    })
    expect(result.fix).toContain("structured output")
    const json = JSON.parse(JSON.stringify(result))
    for (const key of ["stage", "type", "cause", "model", "log"]) expect(key in json).toBe(true)
    const line = checkLine(result)
    expect(line).toContain("Fix: ")
    expect(line).toContain(`Log: ${LOG}`)
  })

  test("a start failure carries the sidecar's log", () => {
    const result = checkFailure({
      error: new MemorySidecar.UnavailableError(
        "Memory could not start: Connection closed",
        "/m/logs/sidecar-2026-10-19T07-00-00-000Z.stderr.txt",
      ),
      step: "remember",
    })
    expect(result).toMatchObject({
      stage: "start",
      type: "MemoryUnavailable",
      log: "/m/logs/sidecar-2026-10-19T07-00-00-000Z.stderr.txt",
    })
  })

  test("a refusal before anything runs keeps its own fix and still has every key", () => {
    const result = checkFailure({ error: new Error("No model is configured, and memory needs one to run") })
    expect(result.fix).toContain("/providers")
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      stage: null,
      type: null,
      cause: null,
      model: null,
      log: null,
    })
  })

  test("diagnostics keep a reason with an apostrophe and a quoted path readable", () => {
    const result = checkFailure({
      error: new MemoryFailure.EngineError("remember", {
        type: "PermissionError",
        message:
          "[Errno 13] Permission denied: '/private/var/folders/xy/T/opencode-test/.opencode/memory/graph/system/databases'",
        cause: [],
        stage: "database",
        errno: 13,
        sampling: [],
      }),
      step: "remember",
    })
    const error = JSON.parse(result.diagnostics!).error as string
    expect(error).toStartWith(
      "Couldn't remember the test fact: while writing the memory database, [Errno 13] Permission denied",
    )
    expect(error).not.toContain("/private/var/folders")
  })

  test("Copy diagnostics holds no fact text, keys or tokens", () => {
    const fact = "The Lunos memory check ran on 2026-10-19 (check zq81xk2v)."
    const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
    const echoed: MemoryFailure.Info = {
      type: "InstructorRetryException",
      message: `Invalid completion for ${fact} with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl`,
      cause: [
        `ValidationError: 1 validation error for KnowledgeGraph nodes input_value='{"nodes":[{"name":"zq81xk2v check"}]}'`,
        `AuthenticationError: Incorrect API key provided: ${key}`,
      ],
      stage: "extraction",
      log: `${os.homedir()}/.local/share/lunos/memory/user/logs/x.log`,
      model: "openai/gpt-5-mini",
      sampling: [
        { provider: "openai", model: "gpt-5-mini", message: `401 Incorrect API key provided: ${key}` },
        { provider: "openai", model: "gpt-5-mini", message: `response didn't match the schema: "${fact}"` },
      ],
    }
    const result = checkFailure({
      error: new MemoryFailure.EngineError("remember", echoed),
      step: "remember",
      secrets: [fact, "zq81xk2v"],
    })
    const diagnostics = result.diagnostics!
    expect(() => JSON.parse(diagnostics)).not.toThrow()
    for (const forbidden of [
      fact,
      "zq81xk2v",
      "memory check ran",
      key,
      "AbCdEfGhIjKlMnOp",
      "eyJhbGciOiJIUzI1NiJ9",
      os.homedir() + "/",
    ])
      expect(diagnostics).not.toContain(forbidden)
    expect(JSON.parse(diagnostics)).toMatchObject({
      stage: "extraction",
      type: "InstructorRetryException",
      model: "openai/gpt-5-mini",
      log: "~/.local/share/lunos/memory/user/logs/x.log",
    })
  })
})
