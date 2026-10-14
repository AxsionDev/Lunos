// Run by hand after `bun run build`: bun test/smoke.ts
// Serves dist/ plus a fixture page from a temp directory, mounts a small session in
// headless chromium and checks that user text, assistant text and a tool row render.
import { chromium } from "@playwright/test"
import { cp, mkdtemp, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

const dist = path.resolve(import.meta.dir, "../dist")
if (!existsSync(path.join(dist, "session-embed.js"))) throw new Error("dist/ is missing, run `bun run build` first")

const dir = await mkdtemp(path.join(tmpdir(), "session-embed-smoke-"))
await cp(dist, path.join(dir, "dist"), { recursive: true })

const session = { id: "ses_1", title: "Smoke" }
const base = { sessionID: "ses_1" }
const messages = [
  {
    info: { ...base, id: "msg_u", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "m" } },
    parts: [{ ...base, id: "prt_u", messageID: "msg_u", type: "text", text: "hello from the user" }],
  },
  {
    info: { ...base, id: "msg_a", role: "assistant", parentID: "msg_u", time: { created: 2, completed: 3 }, agent: "build", modelID: "m", providerID: "p", mode: "build", path: { cwd: "/", root: "/" }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [
      { ...base, id: "prt_t", messageID: "msg_a", type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: { filePath: "/a.txt" }, output: "x", title: "a.txt", metadata: {}, time: { start: 2, end: 3 } } },
      { ...base, id: "prt_a", messageID: "msg_a", type: "text", text: "hello from the assistant" },
    ],
  },
]
await writeFile(
  path.join(dir, "index.html"),
  `<!doctype html><html><head><link rel="stylesheet" href="./dist/session-embed.css"></head><body><div id="root"></div>
<script type="module">
  const { mount } = await import("./dist/session-embed.js")
  mount(document.getElementById("root"), ${JSON.stringify({ session, messages })})
  window.__mounted = true
</script></body></html>`,
)

const server = Bun.serve({ port: 0, fetch: (req) => {
  const file = Bun.file(path.join(dir, new URL(req.url).pathname))
  return file.exists().then((ok) => (ok ? new Response(file) : new Response("not found", { status: 404 })))
} })

// fall back to a cached headless shell when the pinned chromium build is not installed
async function executablePath() {
  if (existsSync(chromium.executablePath())) return undefined
  const cache = path.join(homedir(), "Library/Caches/ms-playwright")
  for (const d of (await readdir(cache).catch(() => [])).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse()) {
    const sub = (await readdir(path.join(cache, d))).find((s) => s.startsWith("chrome-headless-shell"))
    const bin = sub && path.join(cache, d, sub, "chrome-headless-shell")
    if (bin && existsSync(bin)) return bin
  }
}

const browser = await chromium.launch({ executablePath: await executablePath() })
const errors: string[] = []
try {
  const page = await browser.newPage()
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.goto(`http://localhost:${server.port}/index.html`)
  await page.waitForFunction(() => (window as any).__mounted === true)
  await page.getByText("hello from the user").first().waitFor({ timeout: 15000 })
  await page.getByText("hello from the assistant").first().waitFor({ timeout: 15000 })
  const tool = await page.locator('[data-component="context-tool-group-trigger"]').count()
  if (tool === 0) throw new Error("no tool row rendered")
  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`)
  console.log("smoke ok: user text, assistant text and tool row rendered, no console errors")
} finally {
  await browser.close()
  server.stop()
}
