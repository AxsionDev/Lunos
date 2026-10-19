import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigSync } from "@opencode-ai/core/config/sync"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Config } from "@opencode-ai/core/config"

// XCOD-185: the `sync` key is false or { project, exclude }, in both config schemas.
describe("sync config", () => {
  const decoders = {
    sync: Schema.decodeUnknownSync(ConfigSync.Info),
    v1: Schema.decodeUnknownSync(ConfigV1.Info),
    v2: Schema.decodeUnknownSync(Config.Info),
  }

  test("false and { project, exclude } decode", () => {
    for (const decode of Object.values(decoders)) {
      const wrap = decode === decoders.sync ? (v: unknown) => v : (v: unknown) => ({ sync: v })
      expect(() => decode(wrap(false))).not.toThrow()
      expect(() => decode(wrap({ project: "p1", exclude: ["secrets/**"] }))).not.toThrow()
      expect(() => decode(wrap({}))).not.toThrow()
    }
  })

  test("true and a non-string project fail", () => {
    for (const decode of Object.values(decoders)) {
      const wrap = decode === decoders.sync ? (v: unknown) => v : (v: unknown) => ({ sync: v })
      expect(() => decode(wrap(true))).toThrow()
      expect(() => decode(wrap({ project: 3 }))).toThrow()
    }
  })
})
