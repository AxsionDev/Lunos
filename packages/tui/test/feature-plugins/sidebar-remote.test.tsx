/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { remaining, View } from "../../src/feature-plugins/sidebar/remote"

// XCOD-338: a sidebar button for remote control. It runs `/remote` (the palette command, with its
// confirm and audit) and shows where the session can be opened and for how long.

function fakeApi(initial: { on: boolean; url?: string; expiresAt?: number } | "error") {
  let state = initial
  const triggered: string[] = []
  const reads: string[] = []
  const color = RGBA.fromHex("#888888")
  const api = {
    theme: { current: new Proxy({}, { get: () => color }) },
    command: { trigger: (value: string) => triggered.push(value) },
    client: {
      experimental: {
        session: {
          remote: async (input: { sessionID: string }) => {
            reads.push(input.sessionID)
            if (state === "error") throw new Error("no server")
            return { data: state }
          },
        },
      },
    },
  }
  return {
    api: api as unknown as TuiPluginApi,
    triggered,
    reads,
    set: (next: typeof initial) => (state = next),
  }
}

async function render(api: TuiPluginApi) {
  const app = await testRender(() => <View api={api} sessionID="ses_1" />, { width: 60, height: 10 })
  const frame = async () => {
    await Bun.sleep(30)
    await app.renderOnce()
    return app.captureCharFrame()
  }
  return { app, frame }
}

test("off: one line that runs /remote when clicked", async () => {
  const fake = fakeApi({ on: false })
  const { app, frame } = await render(fake.api)
  try {
    const text = await frame()
    expect(text).toContain("Remote off · turn on (/remote)")
    expect(fake.reads).toEqual(["ses_1"])
    const row = text.split("\n").findIndex((line) => line.includes("Remote off"))
    await app.mockMouse.click(2, row)
    // The palette command, so turning it on still asks first and is audited.
    expect(fake.triggered).toEqual(["session.remote"])
  } finally {
    app.renderer.destroy()
  }
})

test("on: the link and the time left; a click runs /remote to turn it off", async () => {
  const fake = fakeApi({ on: true, url: "https://app.lunos.tech/remote/lnk_1", expiresAt: Date.now() + 125 * 60_000 })
  const { app, frame } = await render(fake.api)
  try {
    const text = await frame()
    expect(text).toContain("Remote on · 2h 04m left · turn off")
    expect(text).toContain("https://app.lunos.tech/remote/lnk_1")
    const row = text.split("\n").findIndex((line) => line.includes("Remote on"))
    await app.mockMouse.click(4, row)
    expect(fake.triggered).toEqual(["session.remote"])
  } finally {
    app.renderer.destroy()
  }
})

test("nothing is shown when the server can't be asked", async () => {
  const fake = fakeApi("error")
  const { app, frame } = await render(fake.api)
  try {
    expect((await frame()).trim()).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("time left", () => {
  const now = 1_000_000
  expect(remaining(undefined, now)).toBeUndefined()
  expect(remaining(now + 30_000, now)).toBe("<1m left")
  expect(remaining(now + 12 * 60_000, now)).toBe("12m left")
  expect(remaining(now + 12 * 3_600_000, now)).toBe("12h 00m left")
})
