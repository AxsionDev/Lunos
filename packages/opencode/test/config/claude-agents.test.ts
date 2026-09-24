import { describe, expect, test } from "bun:test"
import { fromClaudeCode, loadClaude } from "../../src/config/agent"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { SkillScope } from "../../src/skill/scope"

describe("Claude Code agent files (XCOD-83)", () => {
  test("a tools allow-list string becomes deny-all plus the listed tools", () => {
    expect(fromClaudeCode({ tools: "Read, Grep, Glob" }).tools).toEqual({
      "*": false,
      read: true,
      grep: true,
      glob: true,
    })
  })

  test("a YAML list works the same way", () => {
    expect(fromClaudeCode({ tools: ["Read", "Bash"] }).tools).toEqual({ "*": false, read: true, bash: true })
  })

  test("a Lunos tools record is left alone", () => {
    expect(fromClaudeCode({ tools: { edit: false } }).tools).toEqual({ edit: false })
  })

  test("a model alias is dropped so the agent inherits; provider/model is kept", () => {
    expect(fromClaudeCode({ model: "sonnet" })).not.toHaveProperty("model")
    expect(fromClaudeCode({ model: "inherit" })).not.toHaveProperty("model")
    expect(fromClaudeCode({ model: "mistral/mistral-large-latest" }).model).toBe("mistral/mistral-large-latest")
  })
})

describe("SkillScope (XCOD-83)", () => {
  test("parses Claude Code's allowed-tools forms", () => {
    expect(SkillScope.parseAllowedTools("Read, Grep, Glob")).toEqual(["read", "grep", "glob"])
    expect(SkillScope.parseAllowedTools(["Read", "read"])).toEqual(["read"])
    expect(SkillScope.parseAllowedTools(undefined)).toBeUndefined()
  })

  test("rules deny everything except the allowed tools and skill, and expire with the turn", () => {
    SkillScope.reset()
    SkillScope.activate("s", "turn-1", { name: "ro", allowed: ["read", "edit"] })
    const rules = SkillScope.rules("s", "turn-1")
    expect(rules[0]).toEqual({ permission: "*", pattern: "*", action: "deny" })
    expect(rules.map((rule) => rule.permission)).toEqual(expect.arrayContaining(["read", "edit", "skill"]))
    expect(SkillScope.rules("s", "turn-2")).toEqual([])
    expect(SkillScope.active("s")).toEqual([])
  })

  test("two restricting skills intersect; a skill without allowed-tools doesn't restrict", () => {
    SkillScope.reset()
    SkillScope.activate("s", "t", { name: "a", allowed: ["read", "grep"] })
    SkillScope.activate("s", "t", { name: "b", allowed: ["read"] })
    SkillScope.activate("s", "t", { name: "c" })
    const allowed = SkillScope.rules("s", "t")
      .filter((rule) => rule.action === "allow")
      .map((rule) => rule.permission)
    expect(allowed.sort()).toEqual(["read", "skill"])
  })
})

describe("loadClaude (XCOD-83)", () => {
  test("loads real agents, skips non-agents, and skips an unusable file instead of failing", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "agents")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "reviewer.md"),
      "---\nname: reviewer\ndescription: Reviews\ntools: Read, Grep\nmodel: sonnet\ncolor: cyan\n---\nReview.\n",
    )
    await fs.writeFile(path.join(dir, "README.md"), "# Not an agent\n")
    await fs.writeFile(path.join(dir, "broken.md"), "---\nname: broken\ndescription: x\nsteps: -3\n---\nx\n")
    const warnings: string[] = []
    const agents = await loadClaude(tmp.path, (message) => warnings.push(message))
    expect(Object.keys(agents)).toEqual(["reviewer"])
    expect(agents.reviewer.color).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("broken.md")
  })
})
