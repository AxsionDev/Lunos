const $ = (id) => document.getElementById(id)

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "status" })
  $("status").textContent = state.controlling ? "controlling this browser" : state.status
  $("stop").disabled = !state.controlling
}

$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "stop" })
  await refresh()
})

$("connect").addEventListener("click", async () => {
  const token = $("token").value.trim()
  const port = $("port").value.trim()
  await chrome.storage.local.set({ ...(token ? { token } : {}), port: port || "" })
  $("token").value = ""
  await chrome.runtime.sendMessage({ type: "connect" })
  setTimeout(refresh, 500)
})

chrome.storage.local.get(["port"]).then((stored) => ($("port").value = stored.port || ""))
void refresh()
