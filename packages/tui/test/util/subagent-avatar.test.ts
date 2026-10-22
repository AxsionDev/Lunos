import { describe, expect, test } from "bun:test"
import {
  ANIMALS,
  assignAvatars,
  avatar,
  blink,
  BODY_COLORS,
  elapsed,
  glyph,
  halfCell,
  halfRows,
  hash,
  NOUNS,
  ordered,
  plainName,
  SPRITE_HEIGHT,
  SPRITE_WIDTH,
  STATE_LABEL,
  STATE_ORDER,
  subagentsOf,
  TITLES,
  tokens,
  type ChildInfo,
} from "../../src/util/subagent-avatar"
import { FIRST_RUN_NOTICE } from "../../src/feature-plugins/sidebar/subagents"

const ids = (count: number, prefix = "ses_child_") => Array.from({ length: count }, (_, i) => `${prefix}${i}`)

// XCOD-287: a pixel-art animal and a funny name per subagent, the same every render.
describe("subagent avatars", () => {
  test("the same id always gets the same animal, name and colour", () => {
    const id = "ses_0123456789abcdefABCDEF"
    expect(avatar(id)).toEqual(avatar(id))
    expect(assignAvatars([id]).get(id)).toEqual(avatar(id))
    // Pinned, so a change to the hash (which would rename everyone's subagents) shows up.
    expect(hash("ses_example")).toBe(1242152591)
  })

  test("names are a title and a playful noun", () => {
    for (const id of ids(200)) {
      const [first, ...rest] = avatar(id).name.split(" ")
      expect(TITLES).toContain(first!)
      expect(NOUNS).toContain(rest.join(" "))
    }
  })

  test("ids spread over every animal", () => {
    const seen = new Set(ids(2000).map((id) => avatar(id).animal.name))
    expect(seen.size).toBe(ANIMALS.length)
  })

  test("subagents side by side never share a name, nor an animal while unused ones remain", () => {
    const all = assignAvatars(ids(ANIMALS.length + 10))
    const looks = [...all.values()]
    expect(new Set(looks.map((look) => look.name)).size).toBe(looks.length)
    const first = looks.slice(0, ANIMALS.length)
    expect(new Set(first.map((look) => look.animal.name)).size).toBe(ANIMALS.length)
  })

  test("a new subagent never changes an earlier one's name or animal", () => {
    const all = assignAvatars(ids(40))
    const fewer = assignAvatars(ids(10))
    for (const id of ids(10)) expect(all.get(id)).toEqual(fewer.get(id)!)
  })

  test("enough curated words, none repeated", () => {
    expect(ANIMALS.length).toBeGreaterThanOrEqual(40)
    expect(TITLES.length).toBeGreaterThanOrEqual(150)
    expect(NOUNS.length).toBeGreaterThanOrEqual(150)
    expect(new Set(TITLES).size).toBe(TITLES.length)
    expect(new Set(NOUNS).size).toBe(NOUNS.length)
  })

  test("no name is offensive, a brand or a real person", () => {
    // Words that would be unkind about bodies, minds or groups, or not family-friendly.
    const blocked = [
      "fat",
      "chunky",
      "skinny",
      "ugly",
      "stupid",
      "dumb",
      "idiot",
      "moron",
      "crazy",
      "psycho",
      "insane",
      "lame",
      "retard",
      "sexy",
      "hot",
      "naughty",
      "dirty",
      "spicy",
      "tart",
      "crumpet",
      "drunk",
      "stoned",
      "high",
      "booze",
      "kill",
      "dead",
      "gun",
      "nazi",
      "slave",
      "gypsy",
      "madame",
      "booger",
      "butt",
      // Brands, trademarks and well-known characters.
      "gizmo",
      "snapdragon",
      "yahtzee",
      "bumblebee",
      "ziggy",
      "domino",
      "pogo",
      "jitterbug",
    ]
    for (const word of [...TITLES, ...NOUNS, ...ANIMALS.map((animal) => animal.name)]) {
      const lower = word.toLowerCase()
      for (const bad of blocked) expect(lower.split(/[^a-z]+/)).not.toContain(bad)
      expect(word).toMatch(/^[A-Z][a-z]*(?:[- ][A-Za-z][a-z]*)*$/)
    }
  })

  test("every sprite is 8x8, uses only known pixels, has eyes, and is its own drawing", () => {
    for (const animal of ANIMALS) {
      expect(animal.sprite.length).toBe(SPRITE_HEIGHT)
      for (const row of animal.sprite) {
        expect(row.length).toBe(SPRITE_WIDTH)
        expect(row).toMatch(/^[.BLDEM]+$/)
      }
      // The blink frame needs an eye to close.
      expect(animal.sprite.join("")).toContain("E")
    }
    expect(new Set(ANIMALS.map((animal) => animal.sprite.join("\n"))).size).toBe(ANIMALS.length)
    expect(new Set(ANIMALS.map((animal) => animal.name)).size).toBe(ANIMALS.length)
  })

  test("the blink frame closes the eyes and keeps the size", () => {
    const sprite = ANIMALS[0]!.sprite
    const closed = blink(sprite)
    expect(closed.join("")).not.toContain("E")
    expect(closed.map((row) => row.length)).toEqual(sprite.map((row) => row.length))
  })

  test("the mark never takes the body's colour", () => {
    for (const id of ids(200)) {
      const look = avatar(id)
      expect(BODY_COLORS).toContain(look.body)
      expect(look.mark).not.toBe(look.body)
    }
  })

  test("plain names and the one-character fallback", () => {
    expect(plainName(0)).toBe("Subagent 1")
    expect(glyph(ANIMALS.find((animal) => animal.name === "Owl")!)).toBe("O")
  })

  test("a sprite becomes half-block rows, two pixels per cell", () => {
    const rows = halfRows(ANIMALS[0]!.sprite)
    expect(rows.length).toBe(SPRITE_HEIGHT / 2)
    for (const row of rows) expect(row.length).toBe(SPRITE_WIDTH)
    expect(halfCell({ top: ".", bottom: "." })).toEqual({ char: " " })
    expect(halfCell({ top: "B", bottom: "." })).toEqual({ char: "▀", fg: "B" })
    expect(halfCell({ top: ".", bottom: "E" })).toEqual({ char: "▄", fg: "E" })
    expect(halfCell({ top: "B", bottom: "E" })).toEqual({ char: "▀", fg: "B", bg: "E" })
  })

  test("the first-run notice says how to turn it off", () => {
    expect(FIRST_RUN_NOTICE).toBe("Lunos now splits work across subagents by default. Turn off in Settings.")
  })
})

describe("subagentsOf", () => {
  const task = (
    status: string,
    metadata: Record<string, unknown> | undefined,
    input: Record<string, unknown> = {},
    time?: { start?: number; end?: number },
  ) => ({ type: "tool", tool: "task", state: { status, input, metadata, time } })
  const none = (): ChildInfo => ({})

  test("lists the session's task calls in launch order, skipping ones with no child session yet", () => {
    const list = subagentsOf(
      [
        { type: "text" },
        task(
          "completed",
          { sessionId: "ses_a", model: { providerID: "mistral", modelID: "devstral" } },
          { subagent_type: "explore", description: "Find the router" },
          { start: 1000, end: 4000 },
        ),
        { type: "tool", tool: "read", state: { status: "completed", metadata: { sessionId: "ses_x" } } },
        task("pending", undefined),
        task("running", { sessionId: "ses_b" }),
        task("error", { sessionId: "ses_c" }, { subagent_type: "general" }),
      ],
      none,
    )
    expect(list.map((item) => [item.id, item.agent, item.state])).toEqual([
      ["ses_a", "explore", "done"],
      ["ses_b", "general", "running"],
      ["ses_c", "general", "failed"],
    ])
    expect(list[0]).toMatchObject({
      description: "Find the router",
      model: "mistral/devstral",
      started: 1000,
      ended: 4000,
    })
  })

  test("a background subagent is live while its session works or waits for a slot, though its call finished", () => {
    const parts = [task("completed", { sessionId: "ses_bg", background: true })]
    expect(subagentsOf(parts, () => ({ status: "busy" }))[0]).toMatchObject({ state: "running", background: true })
    expect(subagentsOf(parts, () => ({ queued: true }))[0]!.state).toBe("queued")
    expect(subagentsOf(parts, () => ({ status: "busy", waiting: true }))[0]!.state).toBe("waiting")
    // XCOD-299: its call never errors, so a failed last turn is what says it failed, and why.
    expect(subagentsOf(parts, () => ({ status: "idle", error: "rate limited" }))[0]).toMatchObject({
      state: "failed",
      error: "rate limited",
    })
    expect(subagentsOf(parts, () => ({ status: "busy", error: "earlier turn" }))[0]!.state).toBe("running")
    expect(subagentsOf(parts, () => ({ status: "idle" }))[0]!.state).toBe("done")
    // A foreground one is done when its call is, whatever its session says.
    expect(subagentsOf([task("completed", { sessionId: "ses_fg" })], () => ({ status: "busy" }))[0]!.state).toBe("done")
  })

  test("a resumed subagent keeps its place and shows its newest state", () => {
    const list = subagentsOf(
      [
        task("completed", { sessionId: "ses_a" }),
        task("completed", { sessionId: "ses_b" }),
        task("running", { sessionId: "ses_a" }),
      ],
      none,
    )
    expect(list.map((item) => [item.id, item.state])).toEqual([
      ["ses_a", "running"],
      ["ses_b", "done"],
    ])
  })

  test("the group lists waiting first, then running, queued, done and failed", () => {
    const entry = (id: string, state: (typeof STATE_ORDER)[number]) => ({
      id,
      state,
      agent: "general",
      description: "",
      background: true,
    })
    const list = ordered([
      entry("a", "done"),
      entry("b", "running"),
      entry("c", "failed"),
      entry("d", "waiting"),
      entry("e", "queued"),
      entry("f", "running"),
    ])
    expect(list.map((item) => item.id)).toEqual(["d", "b", "f", "e", "a", "c"])
    for (const state of STATE_ORDER) expect(STATE_LABEL[state].length).toBeGreaterThan(0)
  })

  test("elapsed time and token counts read short", () => {
    expect(elapsed(42_000)).toBe("42s")
    expect(elapsed(185_000)).toBe("3m 05s")
    expect(elapsed(3_720_000)).toBe("1h 02m")
    expect(tokens(940)).toBe("940")
    expect(tokens(12_345)).toBe("12.3k")
    expect(tokens(2_000_000)).toBe("2M")
  })
})
