import { expect, test } from "bun:test"

test("piped output is complete JSON, and the script exits 0", async () => {
  // A slow reader keeps the pipe full, which is what exposed the truncation.
  const child = Bun.spawn(["bash", "-c", "bun /app/print.ts | (sleep 1; cat)"], { stdout: "pipe" })
  const text = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  const skills = JSON.parse(text)
  expect(skills).toHaveLength(4000)
  expect(skills[3999].name).toBe("skill-3999")
}, 30_000)
