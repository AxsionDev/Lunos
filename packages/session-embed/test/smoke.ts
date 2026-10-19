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
    info: {
      ...base,
      id: "msg_u",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    },
    parts: [{ ...base, id: "prt_u", messageID: "msg_u", type: "text", text: "hello from the user" }],
  },
  {
    info: {
      ...base,
      id: "msg_a",
      role: "assistant",
      parentID: "msg_u",
      time: { created: 2, completed: 3 },
      agent: "build",
      modelID: "m",
      providerID: "p",
      mode: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        ...base,
        id: "prt_t",
        messageID: "msg_a",
        type: "tool",
        callID: "c1",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "/a.txt" },
          output: "x",
          title: "a.txt",
          metadata: {},
          time: { start: 2, end: 3 },
        },
      },
      { ...base, id: "prt_a", messageID: "msg_a", type: "text", text: "hello from the assistant" },
    ],
  },
]
// the fixture script is external because the app's CSP forbids inline scripts
await writeFile(
  path.join(dir, "fixture.js"),
  `const { mount } = await import("./dist/session-embed.js")
window.__mount = () => mount(document.getElementById("root"), ${JSON.stringify({ session, messages })})
window.__dispose = window.__mount()
window.__mounted = true
`,
)
await writeFile(
  path.join(dir, "index.html"),
  `<!doctype html><html><head><link rel="stylesheet" href="./dist/session-embed.css"></head><body><div id="root"></div><script type="module" src="./fixture.js"></script></body></html>`,
)

// the CSP the app serves with (font-src allows data: for the fonts inlined in the stylesheet)
const csp =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const rel = path.normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^([/\\]|\.\.(?=[/\\]|$))+/, "")
    const target = path.resolve(dir, rel)
    const file = Bun.file(target)
    if (!target.startsWith(dir + path.sep) || !(await file.exists())) return new Response("not found", { status: 404 })
    return new Response(file, { headers: { "content-security-policy": csp } })
  },
})

// fall back to a cached headless shell when the pinned chromium build is not installed
async function executablePath() {
  if (existsSync(chromium.executablePath())) return undefined
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), "Library/Caches/ms-playwright")
  for (const d of (await readdir(cache).catch(() => []))
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse()) {
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
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    ),
  )
  await page.goto(`http://localhost:${server.port}/index.html`)
  await page.waitForFunction(() => (window as any).__mounted === true)
  const assertRendered = async () => {
    await page.getByText("hello from the user").first().waitFor({ timeout: 15000 })
    await page.getByText("hello from the assistant").first().waitFor({ timeout: 15000 })
    const tool = await page.locator('[data-component="context-tool-group-trigger"]').count()
    if (tool === 0) throw new Error("no tool row rendered")
  }
  await assertRendered()
  await page.evaluate(() => (window as any).__dispose())
  const left = await page.locator("#root").innerHTML()
  if (left.trim() !== "") throw new Error(`container not empty after dispose: ${left.slice(0, 200)}`)
  await page.evaluate(() => {
    ;(window as any).__dispose = (window as any).__mount()
  })
  await assertRendered()
  if (errors.length) throw new Error(`console errors:\n${errors.join("\n")}`)
  console.log(
    "smoke ok: user text, assistant text and tool row rendered under the app CSP; dispose emptied the container; re-mount rendered; no console errors",
  )
} finally {
  await browser.close()
  server.stop()
}
