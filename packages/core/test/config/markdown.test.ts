import { afterEach, describe, expect, test } from "bun:test"
import { ConfigMarkdown } from "../../src/config/markdown"

// XCOD-208: front matter is data. Only YAML and JSON are accepted; any other language is refused
// before it reaches gray-matter.

const probe = globalThis as { __xcod208?: string }
afterEach(() => {
  delete probe.__xcod208
})

const block = (language: string) =>
  `---${language}\n{ name: (globalThis.__xcod208 = "ran", "x"), description: "d" }\n---\nprompt\n`

describe("ConfigMarkdown front matter (XCOD-208)", () => {
  for (const language of ["js", "javascript", "JS", " js"]) {
    test(`a ---${language} block is refused`, () => {
      expect(() => ConfigMarkdown.parse(block(language))).toThrow(/front matter/i)
      expect(probe.__xcod208).toBeUndefined()
      expect(ConfigMarkdown.parseOption(block(language))).toBeUndefined()
      expect(probe.__xcod208).toBeUndefined()
    })
  }

  test("the sanitize retry refuses it too", () => {
    // Invalid YAML (unquoted colon) forces the retry through sanitize().
    const doc = `---js\nname: a: b\n{ x: (globalThis.__xcod208 = "ran") }\n---\nprompt\n`
    expect(() => ConfigMarkdown.parse(doc)).toThrow()
    expect(probe.__xcod208).toBeUndefined()
  })

  test("other front-matter languages are refused too", () => {
    expect(() => ConfigMarkdown.parse("---coffee\nname: 'x'\n---\n")).toThrow(/front matter/i)
    expect(() => ConfigMarkdown.parse("---toml\nname = 'x'\n---\n")).toThrow(/front matter/i)
  })

  test("YAML and JSON front matter still parse", () => {
    expect(ConfigMarkdown.parse("---\nname: x\ndescription: d\n---\nprompt\n").data).toEqual({
      name: "x",
      description: "d",
    })
    expect(ConfigMarkdown.parse("---yaml\nname: x\n---\n").data).toEqual({ name: "x" })
    expect(ConfigMarkdown.parse('---json\n{ "name": "x" }\n---\n').data).toEqual({ name: "x" })
    expect(ConfigMarkdown.parse("no front matter").content).toBe("no front matter")
  })

  test("the unquoted-colon retry still works", () => {
    expect(ConfigMarkdown.parse("---\ndescription: Use when: x\n---\nbody\n").data).toEqual({
      description: "Use when: x",
    })
  })
})
