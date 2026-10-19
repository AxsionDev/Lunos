import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "fs"
import os from "os"
import path from "path"
import { compile, scan } from "./redact"
import { ROOT } from "./harness"

// Synthetic traffic only: every key, token and address below is made up.
const KEY = "sk-ant-api03-ThisIsAFakeTestKeyForRedaction_0123456789"
const OPENAI = "sk-proj-FakeFakeFakeFake0123456789abcdef"
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJlbWFpbCI6Im5vYm9keUBleGFtcGxlLmNvbSJ9.c2lnbmF0dXJlLWZha2U"
const HOME = "/var/folders/xy/abc123/T/lunos-record-Q1w2E3/home"
const PROJECT = "/var/folders/xy/abc123/T/lunos-record-Q1w2E3/project"

const redact = compile({
  secrets: [KEY],
  paths: [
    [PROJECT, "<project>"],
    [HOME, "<home>"],
    ["/Users/someone", "<user-home>"],
  ],
  user: "someone",
})

const traffic = [
  {
    type: "system",
    subtype: "init",
    session_id: "a6fd116c-92e4-4731-a522-99679ab93931",
    cwd: `/private${PROJECT}`,
    apiKeySource: "ANTHROPIC_API_KEY",
  },
  {
    type: "control_response",
    response: {
      response: {
        account: {
          email: "tester@example.com",
          organizationUuid: "1b2c3d4e-0000-4000-8000-000000000001",
          tokenSource: "none",
        },
      },
    },
  },
  { method: "account/read", result: { accountId: "acct_7f3e9a", user_id: "user-123", plan: "api" } },
  {
    id: 4,
    result: {
      codexHome: `${HOME}/.codex`,
      auth: { OPENAI_API_KEY: OPENAI, id_token: JWT, refresh_token: "rt-opaque-value-123" },
    },
  },
  { from: "stderr", text: `Authorization: Bearer ${OPENAI} failed for someone@laptop.local in /Users/someone/.claude` },
  {
    text: `session token sess-AbCdEf0123456789 and the key again ${KEY} in ~/.claude/projects/${PROJECT.replace(/[^A-Za-z0-9]/g, "-")}`,
  },
  { env: { LUNOS_BRIDGE_TOKEN: "bridge-secret-value", LUNOS_BRIDGE_SOCKET: `${HOME}/bridge.sock` } },
  { usage: { totalTokens: 1234, input_tokens: 6 }, thread: { id: "01a116f2-5e88-79d3-afb9-db1da07c9fcd" } },
]

describe("external-fixture redaction (XCOD-270)", () => {
  const output = traffic.map((line) => JSON.stringify(redact.value(line))).join("\n")

  test("removes keys, tokens, JWTs, e-mails, account ids and the user's paths", () => {
    for (const secret of [KEY, OPENAI, JWT, "sess-AbCdEf0123456789", "rt-opaque-value-123", "bridge-secret-value"])
      expect(output).not.toContain(secret)
    for (const id of [
      "tester@example.com",
      "someone@laptop.local",
      "acct_7f3e9a",
      "user-123",
      "1b2c3d4e-0000-4000-8000-000000000001",
    ])
      expect(output).not.toContain(id)
    expect(output).not.toContain("/var/folders")
    expect(output).not.toContain("/Users/")
    expect(output).not.toContain("someone")
    expect(scan(output, "someone")).toEqual([])
  })

  test("keeps what replay needs: session and thread ids, token counts, the shape", () => {
    const [init, , , codex, , dashed, bridge, usage] = output.split("\n").map((line) => JSON.parse(line))
    expect(init.session_id).toBe("a6fd116c-92e4-4731-a522-99679ab93931")
    expect(init.cwd).toBe("<project>")
    expect(codex.result.codexHome).toBe("<home>/.codex")
    expect(dashed.text).toContain("<project>")
    expect(bridge.env.LUNOS_BRIDGE_SOCKET).toBe("<home>/bridge.sock")
    expect(usage).toEqual({
      usage: { totalTokens: 1234, input_tokens: 6 },
      thread: { id: "01a116f2-5e88-79d3-afb9-db1da07c9fcd" },
    })
  })

  test("the scan catches what redaction would have missed", () => {
    const raw = traffic.map((line) => JSON.stringify(line)).join("\n")
    const kinds = new Set(scan(raw, "someone").map((finding) => finding.kind))
    for (const kind of [
      "anthropic key",
      "key",
      "session token",
      "JWT",
      "bearer token",
      "e-mail",
      "macOS home path",
      "user name",
    ])
      expect(kinds).toContain(kind)
  })

  test("every committed external recording is clean", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const file = path.join(dir, name)
        return statSync(file).isDirectory() ? files(file) : [file]
      })
    const all = files(ROOT)
    expect(all.length).toBeGreaterThan(0)
    for (const file of all)
      expect({
        file: path.relative(ROOT, file),
        leaks: scan(readFileSync(file, "utf8"), os.userInfo().username),
      }).toEqual({ file: path.relative(ROOT, file), leaks: [] })
  })
})
