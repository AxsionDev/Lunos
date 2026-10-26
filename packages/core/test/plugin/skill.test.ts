import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { SkillV2 } from "@opencode-ai/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-lunos skill, about Lunos, with the real file names", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-lunos",
          description: expect.stringContaining("Lunos's own configuration: opencode.json"),
        }),
      )
      // XCOD-168: the body names the product as Lunos and points at `lunos settings`, not upstream's schema.
      expect(SkillPlugin.CustomizeOpencodeContent).toContain("# Customizing Lunos")
      expect(SkillPlugin.CustomizeOpencodeContent).toContain("lunos settings set")
      expect(SkillPlugin.CustomizeOpencodeContent).not.toMatch(/restart opencode|Customizing opencode/)
    }),
  )
})
