import { describe, expect, test } from "bun:test"
import path from "path"
import { ConfigVariable } from "../../src/config/variable"
import { ConfigParse } from "../../src/config/parse"
import { tmpdir } from "../fixture/fixture"

// XCOD-151: a referenced secret holding `"`, `\` or a newline broke the config, and the parse error
// printed the whole substituted text, secret included.
const SECRET = 'a"b\\c\nd'

const load = async (text: string, env: Record<string, string>, dir = "/tmp") => {
  const expanded = await ConfigVariable.substitute({ text, type: "virtual", source: "test.json", dir, env })
  return ConfigParse.jsoncSubstituted(text, expanded, "test.json")
}

const error = async (fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch (e) {
    return JSON.stringify(e) + String((e as Error).message) + JSON.stringify((e as { data?: unknown }).data)
  }
  throw new Error("expected an error")
}

describe("config references", () => {
  test("an {env:} value holding a quote, a backslash and a newline loads as exactly that value", async () => {
    const data = (await load('{ "username": "{env:LUNOS_TEST_PW}" }', { LUNOS_TEST_PW: SECRET })) as {
      username: string
    }
    expect(data.username).toBe(SECRET)
  })

  test("so does a {file:} value, and both work inside a longer string", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "secret.txt"), SECRET)
    const data = (await load(
      '{ "username": "{file:secret.txt}", "a": "Bearer {env:LUNOS_TEST_PW}!" }',
      { LUNOS_TEST_PW: SECRET },
      tmp.path,
    )) as { username: string; a: string }
    expect(data.username).toBe(SECRET)
    expect(data.a).toBe(`Bearer ${SECRET}!`)
  })

  test("outside a string, a reference is inserted as is: a number stays a number", async () => {
    expect(await load('{ "n": {env:LUNOS_TEST_N} }', { LUNOS_TEST_N: "42" })).toEqual({ n: 42 })
  })

  test("a malformed config shows the reference, never the value", async () => {
    const message = await error(() =>
      load('{ "username": "{env:LUNOS_TEST_PW}", "broken": }', { LUNOS_TEST_PW: "s3cret-value" }),
    )
    expect(message).toContain("{env:LUNOS_TEST_PW}")
    expect(message).not.toContain("s3cret-value")
  })

  test("when only the substitution breaks it, the error names the reference, never the value", async () => {
    const message = await error(() => load('{ "n": {env:LUNOS_TEST_PW} }', { LUNOS_TEST_PW: "not json s3cret" }))
    expect(message).toContain("{env:LUNOS_TEST_PW}")
    expect(message).not.toContain("s3cret")
  })

  test("as plain text (a remote config's URL or header), the value is inserted unchanged", async () => {
    const text = await ConfigVariable.substitute({
      text: "Bearer {env:LUNOS_TEST_PW}",
      type: "virtual",
      source: "remote",
      dir: "/tmp",
      env: { LUNOS_TEST_PW: SECRET },
      into: "plain",
    })
    expect(text).toBe(`Bearer ${SECRET}`)
  })

  test("a quote inside a comment doesn't make the next value look like it's in a string", () => {
    const text = '{\n  // he said "hi\n  "n": {env:X}\n}'
    expect(ConfigVariable.insideString(text, text.indexOf("{env:X}"))).toBe(false)
    const block = '{ /* " */ "s": "{env:X}" }'
    expect(ConfigVariable.insideString(block, block.indexOf("{env:X}"))).toBe(true)
  })
})
