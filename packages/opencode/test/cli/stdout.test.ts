import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs/promises"

// XCOD-77: debug commands are piped into jq, grep and scripts. Writing more than the pipe buffer
// and exiting before a slow reader has drained it used to cut the output off (at 64 KiB here).
// Each case runs a real process whose stdout is a pipe into a reader that waits before reading.
async function throughSlowPipe(body: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stdout-test-"))
  const script = path.join(dir, "write.ts")
  await fs.writeFile(script, body)
  const proc = Bun.spawn(["sh", "-c", `bun run ${JSON.stringify(script)} | (sleep 1; wc -c)`], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  await fs.rm(dir, { recursive: true, force: true })
  return Number(out.trim())
}

const SIZE = 300_000
const helper = JSON.stringify(path.resolve(import.meta.dir, "../../src/cli/stdout.ts"))

describe("writeStdout", () => {
  test("delivers every byte to a slow pipe reader before the process exits", async () => {
    const bytes = await throughSlowPipe(
      `import { writeStdout } from ${helper}\nawait writeStdout("x".repeat(${SIZE}))\nprocess.exit(0)\n`,
    )
    expect(bytes).toBe(SIZE)
  }, 30_000)

  test("control: an unawaited process.stdout.write loses output past the pipe buffer", async () => {
    const bytes = await throughSlowPipe(`process.stdout.write("x".repeat(${SIZE}))\nprocess.exit(0)\n`)
    expect(bytes).toBeLessThan(SIZE)
  }, 30_000)
})
