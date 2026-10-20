import { describe, expect, test } from "bun:test"
import * as Tips from "../../src/util/tips"
import { resolve } from "../../src/config"
import { TuiKeybind } from "../../src/config/keybind"

const SIGNED_IN = Tips.context({ config: {}, signedIn: true, platform: "darwin", flags: {} })

/** A key lookup from tui.json, as the TUI does it: the first binding of the keybind's command. */
function keys(keybinds: Record<string, string> = {}) {
  const config = resolve({ keybinds } as never, { terminalSuspend: true })
  return (name: string) => {
    const command = TuiKeybind.CommandMap[name as keyof typeof TuiKeybind.CommandMap] ?? name
    const key = config.keybinds.get(command)[0]?.key
    if (!key) return
    return (typeof key === "string" ? key.split(",")[0]! : key.name).replace("<leader>", "ctrl+x ")
  }
}

function eligibleIds(context: Tips.Context, key = keys()) {
  return Tips.TIPS.filter((tip) => Tips.eligible(tip, context) && Tips.render(tip.text, key)).map((tip) => tip.id)
}

describe("XCOD-278 deck", () => {
  const ids = Tips.TIPS.map((tip) => tip.id)

  test("no tip repeats until the whole eligible deck is seen, and a new round doesn't start with the last", () => {
    const random = Tips.seeded(278)
    const eligible = new Set(eligibleIds(SIGNED_IN))
    let deck = Tips.EMPTY_DECK
    for (const round of [1, 2, 3]) {
      const shown: string[] = []
      for (let index = 0; index < eligible.size; index++) {
        const result = Tips.draw(deck, ids, { eligible, random })
        expect(result.id).toBeDefined()
        if (index === 0 && round > 1) expect(result.id).not.toBe(deck.last)
        shown.push(result.id!)
        deck = result.deck
      }
      expect(new Set(shown).size).toBe(eligible.size)
      expect(shown.every((id) => eligible.has(id))).toBe(true)
    }
    expect(new Set(deck.seen)).toEqual(eligible)
  })

  test("ten starts in a row show ten different tips, the first ones from Getting started", () => {
    const random = Tips.seeded(10)
    const eligible = new Set(eligibleIds(SIGNED_IN))
    const preferred = new Set(Tips.TIPS.filter((tip) => tip.category === Tips.FIRST_STEPS).map((tip) => tip.id))
    let deck = Tips.EMPTY_DECK
    const shown: string[] = []
    for (let start = 0; start < 10; start++) {
      // What kv keeps survives the restart; the deck is all that carries over.
      const result = Tips.draw(Tips.deck(JSON.parse(JSON.stringify(deck))), ids, { eligible, random, preferred })
      shown.push(result.id!)
      deck = result.deck
    }
    expect(new Set(shown).size).toBe(10)
    expect(shown.every((id) => preferred.has(id))).toBe(true)
  })

  test("the same tip never shows twice in a row, even with one eligible tip left in a round", () => {
    const random = Tips.seeded(1)
    let deck: Tips.Deck = { ...Tips.EMPTY_DECK, pending: ["b"], drawn: ["a"], last: "a" }
    const result = Tips.draw(deck, ["a", "b"], { eligible: new Set(["a"]), random })
    // "b" isn't eligible: a new round starts, and "a" (just shown) is the only choice, so it shows.
    expect(result.id).toBe("a")
    deck = { ...Tips.EMPTY_DECK, last: "a" }
    for (let index = 0; index < 50; index++) {
      const next = Tips.draw(deck, ["a", "b", "c"], { eligible: new Set(["a", "b", "c"]), random })
      expect(next.id).not.toBe(deck.last)
      deck = next.deck
    }
  })

  test("removed tips drop out of a stored deck, new ones join it, and a broken kv value starts afresh", () => {
    const deck: Tips.Deck = { pending: ["gone", "b"], drawn: ["a", "old"], seen: ["a", "old"], last: "a", starts: 3 }
    const result = Tips.draw(deck, ["a", "b", "c"], { eligible: new Set(["a", "b", "c"]), random: Tips.seeded(2) })
    expect(["b", "c"]).toContain(result.id!)
    expect([...result.deck.pending, ...result.deck.drawn].sort()).toEqual(["a", "b", "c"])
    expect(result.deck.seen).not.toContain("old")
    expect(Tips.deck("nonsense")).toEqual(Tips.EMPTY_DECK)
    expect(Tips.deck({ pending: [1, "x"], starts: "2" })).toEqual({ ...Tips.EMPTY_DECK, pending: ["x"] })
  })
})

describe("XCOD-278 context", () => {
  const texts = (context: Tips.Context) => {
    const ids = new Set(eligibleIds(context))
    return Tips.TIPS.filter((tip) => ids.has(tip.id)).map((tip) => Tips.plain(tip.text))
  }

  test("memory off: no memory statistics tips, but the one about turning it on", () => {
    const off = texts(SIGNED_IN)
    expect(off.some((text) => text.startsWith("Memory statistics"))).toBe(false)
    expect(off.some((text) => text.startsWith("Run lunos memory check"))).toBe(false)
    expect(off.some((text) => text.startsWith("Turn on memory"))).toBe(true)
    const on = texts(
      Tips.context({ config: { memory: { enabled: true } }, signedIn: true, platform: "darwin", flags: {} }),
    )
    expect(on.some((text) => text.startsWith("Memory statistics"))).toBe(true)
    expect(on.some((text) => text.startsWith("Turn on memory"))).toBe(false)
  })

  test("a feature the organisation turns off never shows", () => {
    const locked = texts(
      Tips.context({
        config: { $locked: ["memory.enabled"], external: { enabled: false } },
        signedIn: true,
        platform: "darwin",
        flags: {},
      }),
    )
    expect(locked.some((text) => text.startsWith("Turn on memory"))).toBe(false)
    expect(locked.some((text) => text.includes("/claude") || text.includes("lunos external"))).toBe(false)
  })

  test("signed out, account tips stay hidden; flagged tips wait for their flag", () => {
    const out = texts(Tips.context({ config: {}, signedIn: false, platform: "darwin", flags: {} }))
    expect(out.some((text) => text.includes("/account"))).toBe(false)
    expect(out.some((text) => text.includes("triggers"))).toBe(false)
    const flagged = Tips.TIPS.filter((tip) => tip.requires?.includes("flag:cloud-triggers"))
    const on = Tips.context({ config: {}, signedIn: true, platform: "darwin", flags: { "cloud-triggers": true } })
    expect(flagged.length).toBeGreaterThan(0)
    expect(flagged.every((tip) => Tips.eligible(tip, on))).toBe(true)
  })

  test("at least 200 tips are eligible for a signed-in user with default settings", () => {
    expect(eligibleIds(SIGNED_IN).length).toBeGreaterThanOrEqual(200)
  })
})

describe("XCOD-278 keys", () => {
  const palette = Tips.TIPS.find((tip) => tip.text.includes("{key:command_list}"))!

  test("a keybind changed in tui.json shows the new key, and one set to none hides its tips", () => {
    expect(Tips.plain(Tips.render(palette.text, keys())!)).toStartWith("Press ctrl+p ")
    expect(Tips.plain(Tips.render(palette.text, keys({ command_list: "ctrl+k" }))!)).toStartWith("Press ctrl+k ")
    expect(Tips.render(palette.text, keys({ command_list: "none" }))).toBeUndefined()
    expect(eligibleIds(SIGNED_IN, keys({ command_list: "none" }))).not.toContain(palette.id)
  })

  test("a key renders highlighted, like a command", () => {
    expect(Tips.parts(Tips.render("Press {key:command_list} now", keys())!)).toEqual([
      { text: "Press ", highlight: false },
      { text: "ctrl+p", highlight: true },
      { text: " now", highlight: false },
    ])
  })
})

describe("XCOD-278 content", () => {
  test("no stale opencode references remain", () => {
    for (const tip of Tips.TIPS) {
      expect(tip.text).not.toContain("opencode.json")
      expect(tip.text).not.toContain("anomalyco")
      expect(tip.text).not.toContain("OpenCode Zen")
      expect(tip.text).not.toContain("~/.config/opencode")
      // The upstream GitHub comment commands; `.opencode/` directories are still read, so they stay.
      expect(tip.text).not.toMatch(/(^|[\s}])\/(opencode|oc)\b/)
    }
  })

  test("tips follow the writing rules", () => {
    const ids = new Set<string>()
    for (const tip of Tips.TIPS) {
      expect(ids.has(tip.id)).toBe(false)
      ids.add(tip.id)
      expect(tip.id).toMatch(/^[a-z0-9-]+$/)
      const text = Tips.render(tip.text, (name) => keys()(name) ?? "none")!
      const plain = Tips.plain(text)
      // One sentence, at most 110 characters, no ticket ids or certification words.
      expect(`${tip.id} ${plain.length}`).toBe(`${tip.id} ${Math.min(plain.length, 110)}`)
      expect(plain).not.toMatch(/[.!?]\s+[A-Z]/)
      expect(plain).not.toMatch(/\b[A-Z]+-\d+\b/)
      expect(plain).not.toMatch(/parity|compliant|certified/i)
      expect(plain).toMatch(/^\S/)
      expect(plain).not.toEndWith(".")
      for (const condition of tip.requires ?? []) expect(Tips.knownCondition(condition)).toBe(true)
    }
    expect(Tips.TIPS.length).toBeGreaterThanOrEqual(200)
  })
})
