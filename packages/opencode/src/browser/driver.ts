export * as BrowserDriver from "./driver"

import type { Control } from "@/control"
import type { BrowserCdp } from "./cdp"

// XCOD-327: page actions on top of CDP. Text first: `snapshot` reads the page through the
// accessibility tree and gives every control a ref (`e123`, its backend DOM node id) that the other
// actions take, so a text-only model can drive the page. Screenshots are for when layout matters.
// This file only acts; deciding whether an action may happen is the browser tool's job.

const MAX_LINES = 400
const MAX_TEXT = 20_000
const RING = 200

const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "option",
  "listbox",
  "spinbutton",
  "treeitem",
])
const SKIP = new Set(["InlineTextBox", "LineBreak"])
const PASS_THROUGH = new Set([
  "none",
  "presentation",
  "generic",
  "group",
  "Section",
  "div",
  "paragraph",
  "LayoutTable",
  "LayoutTableRow",
  "LayoutTableCell",
])

type AXValue = { type: string; value?: unknown }
type AXNode = {
  nodeId: string
  ignored?: boolean
  role?: AXValue
  name?: AXValue
  value?: AXValue
  properties?: { name: string; value: AXValue }[]
  childIds?: string[]
  parentId?: string
  backendDOMNodeId?: number
}

export type Line = { depth: number; role: string; name: string; ref?: string; extra: string }

/** Turns the accessibility tree into an indented outline, with refs on the controls. */
export function outline(nodes: AXNode[]): Line[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]))
  const root = nodes.find((node) => !node.parentId) ?? nodes[0]
  if (!root) return []
  const lines: Line[] = []
  const visit = (node: AXNode, depth: number, parent: string) => {
    const role = String(node.role?.value ?? "")
    const name = String(node.name?.value ?? "")
      .replace(/\s+/g, " ")
      .trim()
    const children = (node.childIds ?? []).map((id) => byId.get(id)).filter((child): child is AXNode => !!child)
    if (SKIP.has(role)) return
    const shown =
      !(role === "StaticText" && name === parent) &&
      !node.ignored &&
      role !== "RootWebArea" &&
      role !== "WebArea" &&
      !(PASS_THROUGH.has(role) && !name) &&
      !!(name || INTERACTIVE.has(role))
    if (shown) {
      const props = Object.fromEntries((node.properties ?? []).map((prop) => [prop.name, prop.value.value]))
      const extra = [
        props["level"] !== undefined ? `level=${props["level"]}` : "",
        props["checked"] !== undefined && props["checked"] !== "false" ? `checked=${props["checked"]}` : "",
        props["disabled"] === true ? "disabled" : "",
        props["expanded"] !== undefined ? `expanded=${props["expanded"]}` : "",
        props["required"] === true ? "required" : "",
        node.value?.value !== undefined && node.value.value !== ""
          ? `value="${String(node.value.value).slice(0, 80)}"`
          : "",
      ]
        .filter(Boolean)
        .join(" ")
      lines.push({
        depth,
        role: role === "StaticText" ? "text" : role,
        name,
        ref: INTERACTIVE.has(role) && node.backendDOMNodeId ? `e${node.backendDOMNodeId}` : undefined,
        extra,
      })
    }
    // Text inside a named control repeats its name.
    if (shown && INTERACTIVE.has(role)) return
    for (const child of children) visit(child, shown ? depth + 1 : depth, shown ? name : parent)
  }
  visit(root, 0, "")
  // Merge runs of plain text under the same parent into one line.
  return lines.filter(
    (line, index) =>
      !(line.role === "text" && lines[index - 1]?.role === "text" && lines[index - 1]?.name === line.name),
  )
}

export function render(lines: Line[], limit = MAX_LINES) {
  const shown = lines.slice(0, limit).map((line) => {
    const name = line.name ? ` "${line.name.slice(0, 160)}"` : ""
    const ref = line.ref ? ` [ref=${line.ref}]` : ""
    const extra = line.extra ? ` ${line.extra}` : ""
    return `${"  ".repeat(Math.min(line.depth, 12))}- ${line.role}${name}${ref}${extra}`
  })
  if (lines.length > limit) shown.push(`… ${lines.length - limit} more lines. Use find to search the page.`)
  return shown.join("\n")
}

/** What the browser tool checks before acting on an element. */
const DESCRIBE = `function () {
  const el = this
  const tag = (el.tagName || "").toLowerCase()
  const form = el.form || (el.closest && el.closest("form"))
  const labels = el.labels ? Array.from(el.labels).map((l) => l.innerText).join(" ") : ""
  const aria = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
  const link = el.closest && el.closest("a")
  const frame = el.closest && el.closest("iframe")
  const captchaSrc = /recaptcha|hcaptcha|turnstile|captcha/i
  const captcha =
    (frame && captchaSrc.test(frame.src || "")) ||
    (tag === "iframe" && captchaSrc.test(el.src || "")) ||
    !!(el.closest && el.closest(".g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]"))
  return {
    tag,
    type: el.type || el.getAttribute?.("type") || undefined,
    role: el.getAttribute?.("role") || undefined,
    name: el.name || el.getAttribute?.("name") || undefined,
    id: el.id || undefined,
    autocomplete: el.autocomplete || el.getAttribute?.("autocomplete") || undefined,
    label: (labels + " " + aria).trim() || undefined,
    text: (el.innerText || el.value || "").trim().slice(0, 120) || undefined,
    href: link ? link.href : undefined,
    download: !!(link && link.hasAttribute("download")),
    inForm: !!form,
    formAction: form ? form.action : undefined,
    formMethod: form ? (form.method || "get") : undefined,
    captcha,
  }
}`

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  Space: { code: "Space", keyCode: 32, text: " " },
}
export const KEY_NAMES = Object.keys(KEYS)

/** The indicator and the stop key, in an isolated world the page's own scripts can't reach. */
export function overlay(stop: ReturnType<typeof Control.parseKey>) {
  return `(() => {
  if (window.__lunosOverlay) return
  window.__lunosOverlay = true
  const send = (type, origin) => { try { __lunosControl(JSON.stringify({ type, origin })) } catch {} }
  const key = ${JSON.stringify(stop)}
  addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== key.key || e.ctrlKey !== key.ctrl || e.altKey !== key.alt || e.shiftKey !== key.shift || e.metaKey !== key.meta) return
    e.preventDefault(); e.stopImmediatePropagation(); send("stop", "stop key")
  }, true)
  addEventListener("mousemove", (e) => { if (e.isTrusted) send("pause", "mouse") }, { capture: true, passive: true })
  const mount = () => {
    if (!document.documentElement || document.getElementById("__lunos_indicator")) return
    const host = document.createElement("div")
    host.id = "__lunos_indicator"
    host.setAttribute("aria-hidden", "true")
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;pointer-events:auto"
    const root = host.attachShadow({ mode: "closed" })
    root.innerHTML = '<div style="font:12px system-ui,sans-serif;background:#1d1b26;color:#fff;border-radius:16px;padding:6px 6px 6px 12px;display:flex;gap:8px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.35)">' +
      '<span>Lunos is controlling this browser</span><button style="font:inherit;border:0;border-radius:12px;padding:3px 10px;background:#e5484d;color:#fff;cursor:pointer">Stop</button></div>'
    root.querySelector("button").addEventListener("click", (e) => { e.stopPropagation(); send("stop", "indicator") })
    document.documentElement.appendChild(host)
  }
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", mount, { once: true })
  else mount()
})()`
}

export type Message = { kind: "stop" | "pause"; origin: string }
type Log = { at: number; text: string }
export type Download = { guid: string; url: string; file: string; state: string }

/** One controlled browser: the current tab, and what it logged. */
export class Driver {
  page: BrowserCdp.Page | undefined
  private ready = new WeakSet<BrowserCdp.Page>()
  private unsubscribe: (() => void) | undefined
  readonly console: Log[] = []
  readonly network: Log[] = []
  readonly downloads: Download[] = []
  private requests = new Map<string, string>()
  private acting = 0
  private actedAt = 0
  private loading: Promise<void> | undefined
  private finishLoad: (() => void) | undefined

  constructor(
    readonly browser: BrowserCdp.Browser,
    private options: {
      stopKey: ReturnType<typeof Control.parseKey>
      onMessage: (message: Message) => void
      downloadsDir: string
    },
  ) {
    browser.onEvent((method, params) => {
      if (method === "Browser.downloadWillBegin" || method === "Page.downloadWillBegin")
        this.downloads.push({
          guid: String(params.guid),
          url: String(params.url),
          file: String(params.suggestedFilename ?? ""),
          state: "starting",
        })
      if (method === "Browser.downloadProgress" || method === "Page.downloadProgress") {
        const item = this.downloads.find((download) => download.guid === params.guid)
        if (item && params.state !== "inProgress") item.state = String(params.state)
      }
      if (this.downloads.length > RING) this.downloads.shift()
    })
    void browser.downloads(false, options.downloadsDir).catch(() => {})
  }

  /** The current tab, set up for control (indicator, stop key, logs) the first time it's used. */
  async current() {
    const page = this.page ?? (await this.browser.page())
    return this.use(page)
  }

  async use(page: BrowserCdp.Page) {
    this.page = page
    if (this.ready.has(page)) return page
    this.ready.add(page)
    this.unsubscribe?.()
    this.unsubscribe = page.on((method, params) => this.event(method, params))
    await page.send("Page.enable")
    await page.send("Runtime.enable")
    await page.send("Network.enable").catch(() => {})
    await page
      .send("Runtime.addBinding", { name: "__lunosControl", executionContextName: "lunos" })
      .catch(() => page.send("Runtime.addBinding", { name: "__lunosControl" }))
    const source = overlay(this.options.stopKey)
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source, worldName: "lunos", runImmediately: true })
    // Older browsers don't run it on the page that's already open: run it there too.
    const tree = await page.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree")
    const world = await page
      .send<{
        executionContextId: number
      }>("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: "lunos" })
      .catch(() => undefined)
    if (world)
      await page.send("Runtime.evaluate", { expression: source, contextId: world.executionContextId }).catch(() => {})
    return page
  }

  private event(method: string, params: Record<string, unknown>) {
    if (method === "Runtime.bindingCalled" && params.name === "__lunosControl") {
      const payload = JSON.parse(String(params.payload)) as { type: string; origin: string }
      // Our own input moves the mouse too: only a move outside an action is the user's.
      if (payload.type === "pause" && (this.acting > 0 || Date.now() - this.actedAt < 750)) return
      if (payload.type === "stop" || payload.type === "pause")
        this.options.onMessage({ kind: payload.type, origin: payload.origin })
      return
    }
    if (method === "Page.frameStartedLoading" && !this.loading)
      this.loading = new Promise((resolve) => (this.finishLoad = resolve))
    if (method === "Page.loadEventFired" || method === "Page.frameStoppedLoading") {
      this.finishLoad?.()
      this.loading = undefined
      this.finishLoad = undefined
    }
    if (method === "Runtime.consoleAPICalled") {
      const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? []
      push(
        this.console,
        `[${params.type}] ${args.map((arg) => (arg.value !== undefined ? String(arg.value) : (arg.description ?? ""))).join(" ")}`,
      )
    }
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
      push(this.console, `[exception] ${details?.exception?.description ?? details?.text ?? ""}`)
    }
    if (method === "Network.requestWillBeSent") {
      const request = params.request as { method: string; url: string }
      if (request.url.startsWith("data:")) return
      this.requests.set(String(params.requestId), `${request.method} ${request.url.slice(0, 300)}`)
      if (this.requests.size > RING) this.requests.delete(this.requests.keys().next().value!)
    }
    if (method === "Network.responseReceived") {
      const response = params.response as { status: number }
      const line = this.requests.get(String(params.requestId))
      if (line) push(this.network, `${response.status} ${line} (${params.type})`)
    }
    if (method === "Network.loadingFailed") {
      const line = this.requests.get(String(params.requestId))
      if (line) push(this.network, `FAILED ${line}: ${params.errorText}`)
    }
  }

  /** Marks an action in progress, so the input it sends doesn't read as the user taking over. */
  async act<T>(fn: () => Promise<T>) {
    this.acting++
    try {
      return await fn()
    } finally {
      this.acting--
      this.actedAt = Date.now()
    }
  }

  /** The tab's URL from the browser itself, which the page can't fake. */
  async url() {
    const page = await this.current()
    const history = await page.send<{ currentIndex: number; entries: { url: string }[] }>("Page.getNavigationHistory")
    return history.entries[history.currentIndex]?.url ?? "about:blank"
  }

  async title() {
    const page = await this.current()
    const result = await page.send<{ result: { value?: string } }>("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })
    return result.result.value ?? ""
  }

  async navigate(url: string, signal?: AbortSignal) {
    const page = await this.current()
    this.loading = new Promise((resolve) => (this.finishLoad = resolve))
    const result = await page.send<{ errorText?: string }>("Page.navigate", { url })
    if (result.errorText) throw new Error(`Couldn't open ${url}: ${result.errorText}`)
    await this.settle(signal, 15_000)
  }

  /** Waits for a navigation the last action started, if any. */
  async settle(signal?: AbortSignal, ms = 8_000) {
    await Bun.sleep(150)
    if (!this.loading) return
    await Promise.race([this.loading, Bun.sleep(ms), aborted(signal)])
  }

  async snapshot() {
    const page = await this.current()
    await page.send("Accessibility.enable").catch(() => {})
    const tree = await page.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree")
    return outline(tree.nodes)
  }

  async text() {
    const page = await this.current()
    const result = await page.send<{ result: { value?: string } }>("Runtime.evaluate", {
      expression: "document.body ? document.body.innerText : ''",
      returnByValue: true,
    })
    const text = result.result.value ?? ""
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + `\n… ${text.length - MAX_TEXT} more characters` : text
  }

  /** Whether a CAPTCHA is on the page. */
  async captcha() {
    const page = await this.current()
    const result = await page.send<{ result: { value?: boolean } }>("Runtime.evaluate", {
      expression:
        "!!document.querySelector('iframe[src*=recaptcha], iframe[src*=hcaptcha], iframe[src*=turnstile], .g-recaptcha, .h-captcha, .cf-turnstile')",
      returnByValue: true,
    })
    return result.result.value === true
  }

  async describe(ref: string): Promise<Control.Element> {
    const page = await this.current()
    const objectId = await this.resolve(page, ref)
    const result = await page.send<{ result: { value: Control.Element } }>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: DESCRIBE,
      returnByValue: true,
    })
    return result.result.value
  }

  async click(ref: string) {
    const page = await this.current()
    const backendNodeId = node(ref)
    await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {})
    const quads = await page.send<{ quads: number[][] }>("DOM.getContentQuads", { backendNodeId })
    const quad = quads.quads[0]
    if (!quad) throw new Error(`${ref} isn't visible on the page, so it can't be clicked`)
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  }

  async type(ref: string, text: string, clear: boolean) {
    const page = await this.current()
    const backendNodeId = node(ref)
    await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {})
    await page.send("DOM.focus", { backendNodeId })
    if (clear) {
      const objectId = await this.resolve(page, ref)
      await page.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function () { if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })) } else if (this.isContentEditable) this.textContent = '' }",
      })
    }
    await page.send("Input.insertText", { text })
  }

  async select(ref: string, value: string) {
    const page = await this.current()
    const objectId = await this.resolve(page, ref)
    const result = await page.send<{ result: { value?: string | null } }>("Runtime.callFunctionOn", {
      objectId,
      arguments: [{ value }],
      returnByValue: true,
      functionDeclaration: `function (v) {
        if (!this.options) return null
        const option = Array.from(this.options).find((o) => o.value === v || o.label === v || o.text.trim() === v)
        if (!option) return null
        this.value = option.value
        this.dispatchEvent(new Event("input", { bubbles: true }))
        this.dispatchEvent(new Event("change", { bubbles: true }))
        return option.text
      }`,
    })
    if (result.result.value === null || result.result.value === undefined)
      throw new Error(`${ref} has no option "${value}"`)
    return result.result.value
  }

  async key(name: string) {
    const page = await this.current()
    const key = KEYS[name]
    if (!key) throw new Error(`Unknown key "${name}". Use one of: ${KEY_NAMES.join(", ")}`)
    const base = { key: name === "Space" ? " " : name, code: key.code, windowsVirtualKeyCode: key.keyCode }
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(key.text ? { text: key.text } : {}) })
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
  }

  /** The element that has focus, as a ref, for checking what Enter would do. */
  async focused() {
    const page = await this.current()
    const result = await page.send<{ result: { objectId?: string } }>("Runtime.evaluate", {
      expression: "document.activeElement",
    })
    if (!result.result.objectId) return undefined
    const described = await page.send<{ node: { backendNodeId: number } }>("DOM.describeNode", {
      objectId: result.result.objectId,
    })
    return `e${described.node.backendNodeId}`
  }

  async scroll(direction: "up" | "down", ref?: string) {
    const page = await this.current()
    if (ref) {
      await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node(ref) })
      return
    }
    const metrics = await page.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
      "Page.getLayoutMetrics",
    )
    const viewport = metrics.cssLayoutViewport
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: viewport.clientWidth / 2,
      y: viewport.clientHeight / 2,
      deltaX: 0,
      deltaY: (direction === "down" ? 1 : -1) * Math.round(viewport.clientHeight * 0.8),
    })
  }

  /** A JPEG of the viewport, with password fields blurred. */
  async screenshot() {
    const page = await this.current()
    const mask =
      "(() => { const s = document.createElement('style'); s.id = '__lunos_mask'; s.textContent = 'input[type=password], [autocomplete*=cc-] { filter: blur(8px) !important }'; document.documentElement.appendChild(s) })()"
    await page.send("Runtime.evaluate", { expression: mask }).catch(() => {})
    const shot = await page
      .send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 })
      .finally(() =>
        page
          .send("Runtime.evaluate", { expression: "document.getElementById('__lunos_mask')?.remove()" })
          .catch(() => {}),
      )
    return `data:image/jpeg;base64,${shot.data}`
  }

  dispose() {
    this.unsubscribe?.()
    this.browser.dispose()
  }

  private async resolve(page: BrowserCdp.Page, ref: string) {
    const resolved = await page.send<{ object: { objectId?: string } }>("DOM.resolveNode", { backendNodeId: node(ref) })
    if (!resolved.object.objectId) throw new Error(`${ref} is no longer on the page. Read the page again.`)
    return resolved.object.objectId
  }
}

function node(ref: string) {
  const id = Number(ref.replace(/^e/, ""))
  if (!Number.isInteger(id) || id <= 0) throw new Error(`"${ref}" isn't a ref. Refs look like e123, from read or find.`)
  return id
}

function push(list: Log[], text: string) {
  list.push({ at: Date.now(), text: text.slice(0, 500) })
  if (list.length > RING) list.shift()
}

function aborted(signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (!signal) return
    if (signal.aborted) return resolve()
    signal.addEventListener("abort", () => resolve(), { once: true })
  })
}
