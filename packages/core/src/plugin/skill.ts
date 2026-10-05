/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeOpencodeContent from "./skill/customize-lunos.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            // XCOD-168: named for the product. XCOD-174 renamed the file too; git follows the rename on
            // upstream merges.
            name: "customize-lunos",
            description:
              "Use ONLY when the user is editing or creating Lunos's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/ (Lunos keeps those upstream file names). Also use when creating or fixing Lunos agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring Lunos itself.",
            location: AbsolutePath.make("/builtin/customize-lunos.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
    })
  }),
})
