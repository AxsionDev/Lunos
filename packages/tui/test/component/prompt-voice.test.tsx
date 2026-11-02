/** @jsxImportSource @opentui/solid */
// XCOD-336: voice input in the TUI prompt, driven by keys in a headless terminal against a fake
// server. An organisation policy (`voice.enabled: false`) removes the key; otherwise the first press
// sets up: it says whisper.cpp is missing, or asks before downloading the model and downloads
// nothing when the answer is no. Recording and transcription are covered with a stand-in recorder
// and transcriber in packages/core/test/voice.
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, symlink } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

let lastFrame: (() => string) | undefined
async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout)
      throw new Error(`timed out waiting for condition${lastFrame ? `; screen:\n${lastFrame()}` : ""}`)
    await Bun.sleep(10)
  }
}

const AGENT = { name: "build", mode: "primary", permission: [], options: {} }

const env = { PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
// For the end-to-end test: a real whisper-cli, a real model, and speech as raw 16 kHz s16le PCM.
const real = {
  whisper: Bun.which("whisper-cli", { PATH: env.PATH ?? "" }),
  model: process.env.LUNOS_VOICE_TEST_MODEL,
  pcm: process.env.LUNOS_VOICE_TEST_PCM,
}
beforeEach(() => {
  // No whisper.cpp from this machine's PATH, and models looked for in a test data directory.
  process.env.PATH = ""
})
afterEach(() => {
  process.env.PATH = env.PATH
  if (env.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = env.XDG_DATA_HOME
})

async function mount(input: { config: Record<string, unknown> }) {
  const session = {
    id: "ses_v",
    slug: "ses_v",
    projectID: "proj_test",
    directory,
    title: "voice",
    version: "1",
    time: { created: 1, updated: 1 },
  }
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  process.env.XDG_DATA_HOME = path.join(tmp.path, "data")
  const requests: string[] = []
  const events = createEventSource()
  const base = createFetch(undefined, events)
  const fetch = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const req = request instanceof Request ? request : new Request(String(request), init)
    const url = new URL(req.url)
    requests.push(url.href)
    if (url.pathname === "/config") return json(input.config)
    if (url.pathname === "/session" && req.method === "GET") return json([session])
    if (url.pathname === "/agent") return json([AGENT])
    if (url.pathname === "/session/ses_v" && req.method === "GET") return json(session)
    if (/^\/session\/[^/]+\/(message|todo|diff)$/.test(url.pathname)) return json([])
    if (url.pathname === "/permission" || url.pathname === "/question") return json([])
    return base.fetch(req)
  }) as typeof globalThis.fetch

  const [
    { ArgsProvider },
    { KVProvider },
    { ToastProvider, Toast },
    { RouteProvider, useRoute },
    { TuiConfigProvider },
    { SDKProvider },
    { PermissionProvider },
    { ProjectProvider },
    { SyncProvider, useSync },
    { DataProvider },
    { ThemeProvider },
    { LocalProvider },
    { PromptStashProvider },
    { DialogProvider },
    { FrecencyProvider },
    { PromptHistoryProvider },
    { PromptRefProvider, usePromptRef },
    { EditorContextProvider },
    { LocationProvider },
    { ExitProvider },
    { ClipboardProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { Prompt },
  ] = await Promise.all([
    import("../../src/context/args"),
    import("../../src/context/kv"),
    import("../../src/ui/toast"),
    import("../../src/context/route"),
    import("../../src/config"),
    import("../../src/context/sdk"),
    import("../../src/context/permission"),
    import("../../src/context/project"),
    import("../../src/context/sync"),
    import("../../src/context/data"),
    import("../../src/context/theme"),
    import("../../src/context/local"),
    import("../../src/component/prompt/stash"),
    import("../../src/ui/dialog"),
    import("../../src/component/prompt/frecency"),
    import("../../src/component/prompt/history"),
    import("../../src/context/prompt"),
    import("../../src/context/editor"),
    import("../../src/context/location"),
    import("../../src/context/exit"),
    import("../../src/context/clipboard"),
    import("../../src/keymap"),
    import("../../src/component/prompt"),
  ])

  function View() {
    const sync = useSync()
    const route = useRoute()
    const promptRef = usePromptRef()
    const [ready, setReady] = createSignal(false)
    onMount(() => {
      route.navigate({ type: "session", sessionID: "ses_v" })
      void wait(() => sync.status !== "loading" && !!sync.session.get("ses_v")).then(() => setReady(true))
    })
    return (
      <box>
        <Show when={ready()}>
          <Toast />
          <Prompt sessionID="ses_v" ref={(ref) => promptRef.set(ref)} placeholders={{ normal: ["Ask anything"] }} />
        </Show>
      </box>
    )
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <ExitProvider exit={() => {}}>
          <ClipboardProvider>
            <OpencodeKeymapProvider keymap={keymap}>
              <ArgsProvider>
                <KVProvider>
                  <ToastProvider>
                    <RouteProvider>
                      <TuiConfigProvider config={config}>
                        <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                          <PermissionProvider>
                            <ProjectProvider>
                              <SyncProvider>
                                <DataProvider>
                                  <ThemeProvider mode="dark">
                                    <LocalProvider>
                                      <PromptStashProvider>
                                        <DialogProvider>
                                          <FrecencyProvider>
                                            <PromptHistoryProvider>
                                              <PromptRefProvider>
                                                <EditorContextProvider>
                                                  <LocationProvider>
                                                    <View />
                                                  </LocationProvider>
                                                </EditorContextProvider>
                                              </PromptRefProvider>
                                            </PromptHistoryProvider>
                                          </FrecencyProvider>
                                        </DialogProvider>
                                      </PromptStashProvider>
                                    </LocalProvider>
                                  </ThemeProvider>
                                </DataProvider>
                              </SyncProvider>
                            </ProjectProvider>
                          </PermissionProvider>
                        </SDKProvider>
                      </TuiConfigProvider>
                    </RouteProvider>
                  </ToastProvider>
                </KVProvider>
              </ArgsProvider>
            </OpencodeKeymapProvider>
          </ClipboardProvider>
        </ExitProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 120, height: 45 })
  const frame = () => app.captureCharFrame()
  lastFrame = frame
  await wait(() => frame().includes("Ask anything"))
  await Bun.sleep(100)
  return {
    frame,
    requests,
    data: path.join(tmp.path, "data", "opencode"),
    async voice() {
      app.mockInput.pressKey(" ", { ctrl: true })
      await Bun.sleep(150)
    },
    tmp: tmp.path,
    async escape() {
      app.mockInput.pressEscape()
      await Bun.sleep(120)
    },
    async key(name: string) {
      app.mockInput.pressKey(name)
      await Bun.sleep(120)
    },
    async cleanup() {
      await Bun.sleep(50)
      app.renderer.destroy()
      void tmp[Symbol.asyncDispose]()
    },
  }
}

describe("TUI voice input", () => {
  test("an organisation policy that turns voice off removes the key", async () => {
    const ui = await mount({ config: { voice: { enabled: false } } })
    try {
      await ui.voice()
      expect(ui.frame()).not.toContain("whisper.cpp")
      expect(ui.frame()).not.toContain("speech model")
      expect(ui.frame()).not.toContain("rec")
    } finally {
      await ui.cleanup()
    }
  })

  test("without whisper.cpp, the key says how to install it", async () => {
    const ui = await mount({ config: {} })
    try {
      await ui.voice()
      await wait(() => ui.frame().includes("Voice input needs whisper.cpp"))
    } finally {
      await ui.cleanup()
    }
  })

  test("the model download waits for the user's yes: nothing is fetched while asking", async () => {
    const ui = await mount({ config: {} })
    const original = globalThis.fetch
    const outbound: string[] = []
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      outbound.push(String(request instanceof Request ? request.url : request))
      throw new Error("network used")
    }) as unknown as typeof fetch
    try {
      const bin = path.join(ui.data, "voice", "bin")
      await mkdir(bin, { recursive: true })
      await Bun.write(path.join(bin, "whisper-cli"), "#!/bin/sh\nexit 0\n")
      await chmod(path.join(bin, "whisper-cli"), 0o755)
      await ui.voice()
      await wait(() => ui.frame().includes("Download the speech model?"))
      expect(ui.frame()).toContain("huggingface.co")
      expect(ui.frame()).toContain("SHA-256")
      await Bun.sleep(300)
      expect(ui.frame()).not.toContain("Downloading the speech model")
      expect(outbound).toEqual([])
    } finally {
      globalThis.fetch = original
      await ui.cleanup()
    }
  }, 20_000)

  // Hold-to-talk through the real key path, the real whisper.cpp and model; the microphone is a
  // stand-in ffmpeg that plays recorded speech. Set LUNOS_VOICE_TEST_MODEL (ggml-base.bin) and
  // LUNOS_VOICE_TEST_PCM to run it.
  test.skipIf(!real.whisper || !real.model || !real.pcm || process.platform === "win32")(
    "press, speak, press: the transcript lands in the prompt; Esc drops it",
    async () => {
      const ui = await mount({ config: {} })
      try {
        const bin = path.join(ui.tmp, "bin")
        await mkdir(bin, { recursive: true })
        await Bun.write(path.join(bin, "ffmpeg"), `#!/bin/sh\ncat '${real.pcm}'\nexec sleep 60\n`)
        await chmod(path.join(bin, "ffmpeg"), 0o755)
        await symlink(real.whisper!, path.join(bin, "whisper-cli"))
        await mkdir(path.join(ui.data, "voice", "models"), { recursive: true })
        await symlink(real.model!, path.join(ui.data, "voice", "models", "ggml-base.bin"))
        process.env.PATH = `${bin}:/usr/bin:/bin`

        // Esc while recording: nothing is transcribed.
        await ui.voice()
        await wait(() => ui.frame().includes("● rec"), 8000)
        await Bun.sleep(900)
        await ui.escape()
        await wait(() => !ui.frame().includes("● rec"))
        await Bun.sleep(300)
        expect(ui.frame()).not.toContain("Please refactor")

        // A tap toggles: record, then press again to stop.
        await ui.voice()
        await wait(() => ui.frame().includes("● rec"))
        await wait(() => /0:0[1-9]/.test(ui.frame()), 3000)
        await Bun.sleep(400)
        const stopped = Date.now()
        await ui.voice()
        await wait(() => !ui.frame().includes("● rec"), 10_000)
        console.log(`voice e2e: recording stopped after ${((Date.now() - stopped) / 1000).toFixed(2)} s`)
        await wait(() => ui.frame().includes("Please refactor the session list"), 10_000)
        const seconds = (Date.now() - stopped) / 1000
        console.log(`voice e2e: transcript in the prompt ${seconds.toFixed(2)} s after the stop press`)
        expect(seconds).toBeLessThan(3)
        expect(ui.frame()).not.toContain("● rec")
        // No audio file anywhere under the test's directories.
        const files = await readdir(ui.tmp, { recursive: true })
        expect(files.filter((file) => /\.(wav|pcm|raw)$/.test(String(file)))).toEqual([])
      } finally {
        await ui.cleanup()
      }
    },
    30_000,
  )
})
