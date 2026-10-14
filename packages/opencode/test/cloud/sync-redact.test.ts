import { describe, expect, test } from "bun:test"
import { CloudSyncRedact } from "@/cloud/sync-redact"

const dir = "/work/app"
const secret = CloudSyncRedact.matcher(dir, ["config/prod/**"])
const tool = (tool: string, input: Record<string, unknown>, output: string, metadata: Record<string, unknown> = {}) => ({
  info: { id: "msg_a", sessionID: "ses_1", role: "assistant" },
  parts: [{ id: "prt_1", messageID: "msg_a", sessionID: "ses_1", type: "tool", tool, callID: "c1",
    state: { status: "completed", input, output, title: "t", metadata, time: { start: 1, end: 2 } } }],
}) as any
const bytes = (v: unknown) => JSON.stringify(v)

describe("matcher", () => {
  test.each([".env", ".env.local", "sub/.env.production", "auth.json", "k.pem", "a/b.key", "id_rsa", "id_rsa.pub", "/work/app/config/prod/db.yml"])("%s is secret", (p) => expect(secret(p)).toBe(true))
  test.each(["src/env.ts", "README.md", "config/dev/db.yml", "keys.ts"])("%s is not", (p) => expect(secret(p)).toBe(false))
})

describe("path rule", () => {
  test("read of .env: output, metadata and attachments replaced", () => {
    const out = CloudSyncRedact.message(tool("read", { filePath: "/work/app/.env" }, "API_KEY=abc123", { preview: "API_KEY=abc123" }), secret)
    const s = (out.parts[0] as any).state
    expect(s.output).toBe("[not synced: /work/app/.env]")
    expect(bytes(out)).not.toContain("abc123")
  })
  test("edit of .env: input content and diff metadata replaced", () => {
    const m = tool("edit", { filePath: ".env", oldString: "A=1", newString: "A=supersecret" }, "ok",
      { diff: "-A=1\n+A=supersecret", filediff: { file: ".env", patch: "+A=supersecret", additions: 1, deletions: 1 } })
    expect(bytes(CloudSyncRedact.message(m, secret))).not.toContain("supersecret")
  })
  test("write of auth.json: input content replaced", () => {
    expect(bytes(CloudSyncRedact.message(tool("write", { filePath: "auth.json", content: "{\"k\":\"tok_live\"}" }, "ok"), secret))).not.toContain("tok_live")
  })
  test("apply_patch touching .env among other files: whole call replaced", () => {
    const patchText = "*** Begin Patch\n*** Update File: src/a.ts\n+x\n*** Update File: .env\n+DB_PASS=hunter2\n*** End Patch"
    expect(bytes(CloudSyncRedact.message(tool("apply_patch", { patchText }, "ok"), secret))).not.toContain("hunter2")
  })
  test("grep over the whole project drops only the lines naming secret files", () => {
    const output = "Found 2 matches\n/work/app/.env:\n  Line 1: DB_PASS=hunter2\n\n/work/app/src/db.ts:\n  Line 4: const pass = process.env.DB_PASS"
    const out = CloudSyncRedact.message(tool("grep", { pattern: "DB_PASS", path: "." }, output), secret)
    const text = (out.parts[0] as any).state.output as string
    expect(text).not.toContain("hunter2")
    expect(text).toContain("src/db.ts")
    expect(text).toContain("[not synced: /work/app/.env]")
    expect(text).toContain("Line 4: const pass")
    expect(text).toContain("Found 2 matches")
  })
  test("grep truncation note after a secret group is kept", () => {
    const output = "Found 100 matches (more matches available)\n/work/app/.env:\n  Line 1: K=hunter2\n\n(Results truncated. Consider using a more specific path or pattern.)"
    const text = (CloudSyncRedact.message(tool("grep", { pattern: "K" }, output), secret).parts[0] as any).state.output as string
    expect(text).not.toContain("hunter2")
    expect(text).toContain("(Results truncated")
  })
  test("read of .env: real metadata (preview, display.text) and title go", () => {
    const m = tool("read", { filePath: "/work/app/.env" }, "<content>1: K=hunter2</content>",
      { preview: "K=hunter2", loaded: [], display: { type: "file", path: "/work/app/.env", text: "K=hunter2", lineStart: 1 } })
    expect(bytes(CloudSyncRedact.message(m, secret))).not.toContain("hunter2")
  })
  test("apply_patch with Move to a secret path: real metadata (diff, files[].patch) goes", () => {
    const patchText = "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: deploy/prod.key\n@@\n-a\n+KEYDATA\n*** End Patch"
    const m = tool("apply_patch", { patchText }, "Success. Updated the following files:\nM src/a.ts", {
      diff: "+KEYDATA", files: [{ filePath: "/work/app/src/a.ts", relativePath: "deploy/prod.key", type: "move", patch: "+KEYDATA", movePath: "/work/app/deploy/prod.key" }], diagnostics: {},
    })
    expect(bytes(CloudSyncRedact.message(m, secret))).not.toContain("KEYDATA")
  })
  test("apply_patch touching only ordinary files is untouched", () => {
    const m = tool("apply_patch", { patchText: "*** Begin Patch\n*** Add File: src/b.ts\n+ok\n*** End Patch" }, "done", { diff: "+ok" })
    expect(bytes(CloudSyncRedact.message(m, secret))).toEqual(bytes(m))
  })
  test("a pending call with only raw arguments naming .env is replaced", () => {
    const m = { info: { id: "m", sessionID: "s", role: "assistant" }, parts: [{ id: "p", type: "tool", tool: "write", callID: "c",
      state: { status: "pending", input: {}, raw: '{"filePath":".env","content":"K=hunter2"}' } }] } as any
    expect(bytes(CloudSyncRedact.message(m, secret))).not.toContain("hunter2")
  })
  test("lsp on a secret file: output replaced", () => {
    const out = CloudSyncRedact.message(tool("lsp", { operation: "hover", filePath: "a/id_rsa", line: 1, character: 1 }, "K=hunter2"), secret)
    expect(bytes(out)).not.toContain("hunter2")
  })
  test("read attachment (binary) of a .pem is dropped", () => {
    const m = tool("read", { filePath: "k.pem" }, "x")
    ;(m.parts[0] as any).state.attachments = [{ type: "file", mime: "image/png", url: "data:image/png;base64,QUJD" }]
    expect(bytes(CloudSyncRedact.message(m, secret))).not.toContain("QUJD")
  })
  test("glob listing names secret files but carries no content: kept", () => {
    const out = CloudSyncRedact.message(tool("glob", { pattern: "**/*" }, "/work/app/.env\n/work/app/src/a.ts"), secret)
    expect((out.parts[0] as any).state.output).toContain("src/a.ts")
  })
  test("an attached file part of .env (user @-mention) is replaced", () => {
    const m = { info: { id: "msg_u", sessionID: "ses_1", role: "user" }, parts: [
      { id: "p", messageID: "msg_u", sessionID: "ses_1", type: "file", mime: "text/plain", filename: ".env",
        url: "data:text/plain;base64," + Buffer.from("TOKEN=zzz").toString("base64"),
        source: { type: "file", path: "/work/app/.env", text: { value: "TOKEN=zzz", start: 0, end: 9 } } }] } as any
    const out = bytes(CloudSyncRedact.message(m, secret))
    expect(out).not.toContain("zzz")
    expect(out).not.toContain(Buffer.from("TOKEN=zzz").toString("base64"))
  })
  test("user message summary diffs of secret files lose their patch", () => {
    const m = { info: { id: "msg_u", sessionID: "ses_1", role: "user", summary: { diffs: [
      { file: ".env", patch: "+K=leak", additions: 1, deletions: 0 }, { file: "a.ts", patch: "+ok", additions: 1, deletions: 0 }] } }, parts: [] } as any
    const out = bytes(CloudSyncRedact.message(m, secret))
    expect(out).not.toContain("leak")
    expect(out).toContain("+ok")
  })
  test("does not mutate its input", () => {
    const m = tool("read", { filePath: ".env" }, "A=1")
    CloudSyncRedact.message(m, secret)
    expect((m.parts[0] as any).state.output).toBe("A=1")
  })
})

describe("chunkMessages", () => {
  test("path rule then scanner", () => {
    const out = CloudSyncRedact.chunkMessages([tool("read", { filePath: ".env" }, "A=1"), tool("read", { filePath: "a.ts" }, "export TOKEN=sk-abcdefghijklmnop1234")], dir, [])
    expect(bytes(out)).not.toContain("sk-abcdefghijklmnop1234")
    expect(bytes(out)).toContain("[not synced: .env]")
  })
})

describe("scanner", () => {
  test("credential-shaped strings anywhere are redacted", () => {
    const v = CloudSyncRedact.scan({ a: ["export API_KEY=sk-abcdefghijklmnop1234", { b: "Authorization: Bearer abc.def.ghi" }], n: 3 })
    expect(bytes(v)).not.toContain("sk-abcdefghijklmnop1234")
    expect(bytes(v)).not.toContain("abc.def.ghi")
    expect(v.n).toBe(3)
  })
})
