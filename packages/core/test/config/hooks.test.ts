import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"

// XCOD-68 shipped with unit tests that exercised the hooks plugin in isolation and
// never checked that a `hooks` block actually survives config decoding. Two defects
// got through as a result, both caught only by running the product (XCOD-71):
//
//   1. `hooks` was added to the v2 Config.Info only, but the live runtime decodes
//      through ConfigV1.Info, which strips unknown keys — so the plugin never
//      received anything.
//   2. The schema was `Schema.Record(Event, …)`. A record keyed by a literal union
//      is exhaustive in Effect Schema, so declaring one event failed with
//      "Missing key" for every other event.
//
// These tests pin both. They decode real config shapes rather than asserting on the
// schema's structure, because the structure was not what was wrong.

const decodeV1 = Schema.decodeUnknownSync(ConfigV1.Info)
const decodeV2 = Schema.decodeUnknownSync(Config.Info)

const entry = { command: ["echo", "hi"] }

describe("hooks config", () => {
  test("a single event decodes without requiring the others", () => {
    // The exhaustive-record bug: this threw "Missing key hooks.session.deleted".
    const config = decodeV1({ hooks: { "tool.execute.after": [entry] } })
    expect(config.hooks?.["tool.execute.after"]).toHaveLength(1)
    expect(config.hooks?.["session.deleted"]).toBeUndefined()
  })

  test("survives the v1 schema the live runtime actually uses", () => {
    // The stripped-key bug: hooks reached neither the resolved config nor the plugin.
    const config = decodeV1({ hooks: { "tool.execute.before": [entry] } })
    expect(config.hooks).toBeDefined()
  })

  test("survives the v2 schema too", () => {
    const config = decodeV2({ hooks: { "tool.execute.before": [entry] } })
    expect(config.hooks).toBeDefined()
  })

  test("carries matcher, timeout and environment through", () => {
    const config = decodeV1({
      hooks: {
        "tool.execute.before": [
          {
            command: ["./guard.sh"],
            matcher: { tool: "apply_patch", file: "**/*.ts" },
            environment: { MODE: "strict" },
            timeout: 5000,
            disabled: false,
          },
        ],
      },
    })
    const [item] = config.hooks?.["tool.execute.before"] ?? []
    expect(item?.matcher?.tool).toBe("apply_patch")
    expect(item?.matcher?.file).toBe("**/*.ts")
    expect(item?.environment?.MODE).toBe("strict")
    expect(item?.timeout).toBe(5000)
  })

  test("every documented event is accepted", () => {
    // Guards against the docs and the schema drifting apart.
    for (const event of [
      "tool.execute.before",
      "tool.execute.after",
      "command.execute.before",
      "session.created",
      "session.idle",
      "session.compacted",
      "session.deleted",
      "session.error",
    ]) {
      expect(() => decodeV1({ hooks: { [event]: [entry] } })).not.toThrow()
    }
  })

  test("KNOWN LIMITATION: an unknown event name is silently dropped", () => {
    // XCOD-68's commit message and PR claimed a closed key set meant "a typo fails at
    // config-decode time instead of silently never firing". That is false, and this
    // test pins the real behaviour so the claim is not repeated.
    //
    // Config decodes with `onExcessProperty: "ignore"` (config.ts), repo-wide, so a
    // misspelled event is stripped rather than rejected. The hook simply never fires
    // and the user gets no feedback. Making `hooks` alone strict would be inconsistent
    // with every other config section, so this is documented rather than "fixed".
    const config = decodeV1({ hooks: { "tool.execute.pre": [entry] } })
    expect(config.hooks).toEqual({})
  })

  test("config without hooks still decodes", () => {
    expect(decodeV1({}).hooks).toBeUndefined()
  })
})
