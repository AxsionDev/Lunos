/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { ResourceItem } from "@opencode-ai/sdk/v2"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { breakdown, summary, View } from "../../src/feature-plugins/sidebar/context"

// XCOD-300: the sidebar's Context section lists the project's resources with mode, tokens and when
// each was indexed, and a click leaves one out of this session (and puts it back).

const item = (input: Partial<ResourceItem> & Pick<ResourceItem, "name" | "mode">): ResourceItem => ({
  kind: "path",
  scope: "shared",
  target: `/repo/${input.name}`,
  readOnly: false,
  trusted: true,
  excluded: false,
  state: "indexed 2 h ago · 143 chunks",
  tokens: 2100,
  ...input,
})

function fakeApi(list: ResourceItem[]) {
  const excluded = new Set<string>()
  const calls: { sessionID?: string; name: string; excluded: boolean }[] = []
  const color = RGBA.fromHex("#888888")
  const api = {
    theme: { current: new Proxy({}, { get: () => color }) },
    state: {
      session: { messages: () => [], get: () => ({ cost: 0 }) },
      provider: [],
    },
    ui: { toast: () => {} },
    client: {
      resource: {
        list: async () => ({ data: list.map((entry) => ({ ...entry, excluded: excluded.has(entry.name) })) }),
        exclude: async (input: { sessionID?: string; name: string; excluded: boolean }) => {
          calls.push(input)
          if (input.excluded) excluded.add(input.name)
          else excluded.delete(input.name)
          return { data: input.excluded }
        },
      },
    },
  }
  return { api: api as unknown as TuiPluginApi, calls }
}

test("lists resources with mode, tokens and indexed time, and toggles exclusion per session", async () => {
  const { api, calls } = fakeApi([
    item({ name: "deploy", mode: "always", tokens: 1200 }),
    item({ name: "payments", mode: "search" }),
    item({ name: "aws", mode: "search", problem: "a shared resource must be inside the project" }),
  ])
  const app = await testRender(() => <View api={api} session_id="ses_1" />, { width: 120, height: 45 })
  try {
    const frame = async () => {
      await Bun.sleep(30)
      await app.renderOnce()
      return app.captureCharFrame()
    }
    let text = await frame()
    expect(text).toContain("Resources: 1 always (1.2k tokens) · 1 searchable")
    expect(text).toContain("deploy always · 1.2k tok · 2 h ago · 143 chunks")
    expect(text).toContain("payments search · 2.1k tok")
    expect(text).toContain("aws a shared resource must be inside the project")

    const row = text.split("\n").findIndex((line) => line.includes("deploy always"))
    await app.mockMouse.click(2, row)
    text = await frame()
    expect(calls).toEqual([{ sessionID: "ses_1", name: "deploy", excluded: true }])
    expect(text).toContain("deploy excluded for this session")
    expect(text).toContain("Resources: 1 searchable")

    await app.mockMouse.click(2, row)
    text = await frame()
    expect(calls.at(-1)).toEqual({ sessionID: "ses_1", name: "deploy", excluded: false })
    expect(text).toContain("deploy always")
  } finally {
    app.renderer.destroy()
  }
})

test("/context lists every part of the turn with its tokens, then the resources", () => {
  const rows = breakdown(
    {
      time: 0,
      system: 2100,
      instructions: 300,
      always: 1200,
      memory: 150,
      attachments: 0,
      searched: 800,
      mentioned: 0,
      resources: [{ name: "deploy", tokens: 1200 }],
      dropped: [{ name: "big", tokens: 9000, reason: "over the 8000-token budget for always resources" }],
    },
    [item({ name: "deploy", mode: "always" })],
  )
  const text = rows.map((row) => `${row.title}: ${row.description}`).join("\n")
  for (const line of [
    "System prompt: 2,100 tokens",
    "Instructions: 300 tokens",
    "Always resources: 1,200 tokens · deploy 1.2k",
    "big left out: over the 8000-token budget",
    "Memory recall: 150 tokens",
    "Attachments: 0 tokens",
    "Searched resources: 800 tokens",
    "Total: 4,550 tokens",
    "● deploy: always · path · shared · 2.1k tokens · indexed 2 h ago · 143 chunks",
  ])
    expect(text).toContain(line)
  expect(summary([])).toBe("none in use")
})
