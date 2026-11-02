// XCOD-327: the Lunos extension. It connects to the Lunos on this machine (ws://127.0.0.1 only,
// with the pairing code from `lunos browser pair`) and relays the DevTools Protocol to the tab Lunos
// works in, through chrome.debugger. While it's attached, Chrome shows its own "Lunos started
// debugging this browser" bar; Cancel there, or Stop in this extension's popup, ends control at once.
// Lunos decides what may happen (sites, confirmations, refusals); this only carries the messages.

const DEFAULT_PORT = 47615
let socket
let status = "not paired"
let downloadsArmed = false
const attached = new Set()

const send = (message) => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

async function settings() {
  const stored = await chrome.storage.local.get(["token", "port"])
  return { token: stored.token || "", port: Number(stored.port) || DEFAULT_PORT }
}

async function connect() {
  const { token, port } = await settings()
  if (!token) {
    status = "not paired"
    return
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  status = "connecting"
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`)
  socket = ws
  ws.onopen = () => {
    status = "connected"
    send({ type: "hello", version: chrome.runtime.getManifest().version })
  }
  ws.onmessage = (event) => void handle(JSON.parse(event.data))
  ws.onclose = () => {
    if (socket === ws) socket = undefined
    status = "waiting for Lunos"
    void detachAll()
  }
}

async function attach(tabId) {
  if (attached.has(tabId)) return
  await chrome.debugger.attach({ tabId }, "1.3")
  attached.add(tabId)
}

async function detachAll() {
  for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {})
  attached.clear()
}

const tabInfo = (tab, activeId) => ({
  id: String(tab.id),
  url: tab.url || "",
  title: tab.title || "",
  active: tab.id === activeId,
})

async function handle(message) {
  const reply = (result) => send({ id: message.id, result: result ?? {} })
  const fail = (error) => send({ id: message.id, error: String(error && error.message ? error.message : error) })
  try {
    if (message.type === "tabs") {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      const tabs = await chrome.tabs.query({})
      return reply(tabs.filter((tab) => tab.id !== undefined).map((tab) => tabInfo(tab, active && active.id)))
    }
    if (message.type === "open") {
      const tab = await chrome.tabs.create({ url: message.url, active: true })
      return reply(tabInfo(tab, tab.id))
    }
    if (message.type === "activate") {
      await chrome.tabs.update(Number(message.tabId), { active: true })
      return reply({})
    }
    if (message.type === "close") {
      await chrome.tabs.remove(Number(message.tabId))
      return reply({})
    }
    if (message.type === "downloads") {
      downloadsArmed = message.allow === true
      return reply({})
    }
    if (message.type === "cdp") {
      const tabId = Number(message.tabId)
      await attach(tabId)
      return reply(await chrome.debugger.sendCommand({ tabId }, message.method, message.params || {}))
    }
    fail(`unknown request ${message.type}`)
  } catch (error) {
    fail(error)
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!attached.has(source.tabId)) return
  send({ type: "event", tabId: String(source.tabId), method, params })
})

chrome.debugger.onDetach.addListener((source, reason) => {
  attached.delete(source.tabId)
  // Cancel on Chrome's debugging bar is the user taking control back.
  if (reason === "canceled_by_user") send({ type: "stop", origin: "debugger" })
})

// Downloads ask in Lunos first: one the user didn't confirm there is canceled here.
chrome.downloads.onCreated.addListener((item) => {
  const guid = String(item.id)
  send({
    type: "event",
    tabId: "",
    method: "Browser.downloadWillBegin",
    params: { guid, url: item.url, suggestedFilename: item.filename },
  })
  if (downloadsArmed) {
    downloadsArmed = false
    return
  }
  chrome.downloads.cancel(item.id)
  send({ type: "event", tabId: "", method: "Browser.downloadProgress", params: { guid, state: "canceled" } })
})

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || delta.state.current === "in_progress") return
  send({
    type: "event",
    tabId: "",
    method: "Browser.downloadProgress",
    params: { guid: String(delta.id), state: delta.state.current },
  })
})

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message.type === "status") respond({ status, controlling: attached.size > 0 })
  if (message.type === "stop") {
    send({ type: "stop", origin: "extension" })
    void detachAll().then(() => respond({ ok: true }))
    return true
  }
  if (message.type === "connect") {
    socket?.close()
    void connect().then(() => respond({ status }))
    return true
  }
})

// Reconnect while Lunos isn't running, and keep the service worker awake while connected.
setInterval(() => {
  if (!socket) void connect()
  else send({ type: "ping" })
}, 3000)
void connect()
