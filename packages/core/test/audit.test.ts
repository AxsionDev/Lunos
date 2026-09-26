import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, readdir } from "fs/promises"
import os from "os"
import path from "path"
import { Audit } from "@opencode-ai/core/audit"

const tmp = async () => path.join(await mkdtemp(path.join(os.tmpdir(), "lunos-audit-")), "audit.log")
const lines = async (file: string) => (await readFile(file, "utf8")).split("\n").filter(Boolean)

describe("Audit writer (XCOD-103)", () => {
  test("lines are v1, numbered and hash-chained; verify passes on an untouched log", async () => {
    const file = await tmp()
    await Audit.write({ file }, "tool.run", { tool: "bash", command: "ls" })
    await Audit.write({ file }, "permission.decision", { permission: "bash", decision: "denied" })
    await Audit.write({ file }, "model.call", { providerID: "mistral", host: "api.mistral.ai", allowed: true })
    const [a, b, c] = (await lines(file)).map((line) => JSON.parse(line))
    expect(a).toMatchObject({ v: 1, event: "tool.run", seq: 1, prev: Audit.GENESIS })
    expect(b.seq).toBe(2)
    expect(c).toMatchObject({ providerID: "mistral", host: "api.mistral.ai", allowed: true })
    expect(await Audit.verify(file)).toEqual({ ok: true, lines: 3, files: 1 })
  })

  test("verify fails when a middle line is edited or removed", async () => {
    const file = await tmp()
    for (const command of ["a", "b", "c", "d"]) await Audit.write({ file }, "tool.run", { tool: "bash", command })
    const original = await lines(file)

    await writeFile(file, [original[0], original[1].replace('"b"', '"x"'), original[2], original[3]].join("\n") + "\n")
    expect(await Audit.verify(file)).toMatchObject({ ok: false, line: 3 })

    await writeFile(file, [original[0], original[2], original[3]].join("\n") + "\n")
    expect(await Audit.verify(file)).toMatchObject({ ok: false, line: 2 })
  })

  test("v0 residency lines before the upgrade are covered: the first v1 line chains to them", async () => {
    const file = await tmp()
    const v0 = JSON.stringify({
      timestamp: "2026-09-21T12:00:00.000Z",
      providerID: "scaleway",
      region: "eu",
      basis: "both",
      host: "api.scaleway.ai",
      allowed: true,
    })
    await writeFile(file, v0 + "\n")
    await Audit.write({ file }, "tool.run", { tool: "bash", command: "ls" })
    expect(JSON.parse((await lines(file))[1]).prev).toBe(Audit.hashLine(v0))
    expect(await Audit.verify(file)).toMatchObject({ ok: true, lines: 2 })
  })

  test("rotation keeps the chain across the file boundary", async () => {
    const file = await tmp()
    for (let i = 0; i < 6; i++)
      await Audit.write({ file, maxBytes: 300 }, "tool.run", { tool: "bash", command: `echo ${i}` })
    const all = await Audit.files(file)
    expect(all.length).toBeGreaterThan(1)
    expect(await Audit.verify(file)).toMatchObject({ ok: true, lines: 6 })
    expect((await Audit.read(file)).map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test("key-shaped strings are masked by default, and user patterns on top", async () => {
    expect(Audit.redact('curl -H "Authorization: Bearer abc.def.ghi" https://x')).toBe(
      'curl -H "Authorization: [redacted]" https://x',
    )
    expect(Audit.redact("export OPENAI_API_KEY=sk-live-123456789012345678")).toBe("export OPENAI_API_KEY=[redacted]")
    expect(Audit.redact("git push https://ghp_abcdefghijklmnopqrstuvwx@github.com")).not.toContain("ghp_")
    expect(Audit.redact("mysql --password=hunter2 db")).toBe("mysql --password=[redacted] db")
    expect(Audit.redact("cat /home/alice/secret-plan.md", ["/home/[^/]+"])).toBe("cat [redacted]/secret-plan.md")
    const file = await tmp()
    await Audit.write({ file }, "tool.run", { tool: "bash", command: "TOKEN=abc123 ./deploy" })
    expect(await readFile(file, "utf8")).not.toContain("abc123")
  })

  test("CSV neutralises formula cells and quotes what needs quoting", () => {
    const csv = Audit.toCsv([
      { timestamp: "t", event: "tool.run", command: "-rf /tmp, then =SUM(A1)", tool: "=HYPERLINK(1)" },
    ])
    const row = csv.split("\r\n")[1]
    expect(row).toContain(`"'-rf /tmp, then =SUM(A1)"`)
    expect(row).toContain(`'=HYPERLINK(1)`)
    expect(row).not.toMatch(/,=HYPERLINK/)
  })

  test("two processes appending at once still produce one unbroken chain", async () => {
    const file = await tmp()
    const script = `import { Audit } from "@opencode-ai/core/audit"; for (let i = 0; i < 25; i++) await Audit.write({ file: ${JSON.stringify(file)} }, "tool.run", { tool: "bash", command: String(i) }); await Audit.flush()`
    const run = () =>
      Bun.spawn(["bun", "-e", script], {
        cwd: path.resolve(import.meta.dir, ".."),
        stdout: "ignore",
        stderr: "inherit",
      }).exited
    expect(await Promise.all([run(), run()])).toEqual([0, 0])
    expect(await Audit.verify(file)).toEqual({ ok: true, lines: 50, files: 1 })
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".lock"))).toEqual([])
  })

  test("the last line is read from the end, whatever the file size or line length", async () => {
    const file = await tmp()
    const long = "x".repeat(200 * 1024)
    await writeFile(file, `${JSON.stringify({ n: 1 })}\n${JSON.stringify({ n: 2, pad: long })}\n`)
    expect(JSON.parse(Audit.lastLine(file)!).n).toBe(2)
    await writeFile(file, Array.from({ length: 50_000 }, (_, i) => JSON.stringify({ n: i })).join("\n") + "\n")
    expect(JSON.parse(Audit.lastLine(file)!).n).toBe(49_999)
    await writeFile(file, "")
    expect(Audit.lastLine(file)).toBeUndefined()
    expect(Audit.lastLine(file + ".missing")).toBeUndefined()
  })

  test("an event on a large log reads a tail, not the whole file", async () => {
    const file = await tmp()
    for (let i = 0; i < 3; i++) await Audit.write({ file }, "tool.run", { tool: "bash", command: String(i) })
    const filler = (await readFile(file, "utf8")).split("\n").filter(Boolean).at(-1)!
    // Grow the log to ~9 MB of unchained filler lines, then chain one more real line after them.
    await writeFile(file, (await readFile(file, "utf8")) + (filler + "\n").repeat(40_000))
    const started = performance.now()
    await Audit.write({ file }, "tool.run", { tool: "bash", command: "after" })
    const elapsed = performance.now() - started
    const last = JSON.parse(Audit.lastLine(file)!)
    expect(last).toMatchObject({ command: "after", prev: Audit.hashLine(filler) })
    expect(elapsed).toBeLessThan(50)
  })
})
