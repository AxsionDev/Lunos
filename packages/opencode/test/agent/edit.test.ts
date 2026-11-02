import { describe, expect, test } from "bun:test"
import { AgentEdit } from "@/agent/edit"
import { AgentFile } from "@/agent/file"
import { Permission } from "@/permission"

// XCOD-210: editing an agent changes its file through `change`, and `validate` refuses a save that
// names a model, tool or skill that doesn't exist here.

const known: AgentEdit.Known = {
  models: new Set(["mistral/mistral-large-latest", "test/test-model"]),
  tools: new Set(["bash", "read", "edit", "webfetch", "task", "skill"]),
  skills: new Set(["code-review"]),
  mcp: new Set(["github"]),
}

describe("AgentEdit.change", () => {
  test("sets and clears fields; a rule set here goes after the ones already there", () => {
    const doc = {
      description: "old",
      model: "test/test-model",
      steps: 5,
      permission: { "*": "allow", bash: "deny" },
      prompt: "p",
    }
    const next = AgentEdit.change(doc, {
      description: "new",
      model: null,
      steps: null,
      permission: { bash: "ask" },
      mcp: { github: "allow" },
      skills: { "code-review": "allow" },
    })
    expect(next).toStrictEqual({
      description: "new",
      prompt: "p",
      permission: {
        "*": "allow",
        bash: "ask",
        "github_*": "allow",
        skill: { "code-review": "allow" },
      },
    })
  })

  test("the changed rules win when evaluated, as last-wins matching requires", () => {
    const next = AgentEdit.change({ permission: { bash: "deny", "*": "allow" } }, { permission: { bash: "ask" } })
    const ruleset = Permission.fromConfig(next.permission as never)
    expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("ask")
  })
})

describe("AgentEdit.validate", () => {
  test("a valid agent has no problems", () => {
    expect(
      AgentEdit.validate(
        {
          model: "mistral/mistral-large-latest",
          permission: {
            bash: "ask",
            "github_*": "allow",
            "web*": "deny",
            skill: { "code-review": "allow", "*": "deny" },
          },
          prompt: "p",
        },
        known,
      ),
    ).toEqual([])
  })

  test("unknown models, tools, MCP servers and skills are each named", () => {
    expect(
      AgentEdit.validate(
        {
          model: "openai/gpt-nope",
          permission: { bsh: "allow", "gitlab_*": "allow", "zz*": "allow", skill: { "no-such-skill": "allow" } },
        },
        known,
      ),
    ).toEqual([
      'model "openai/gpt-nope" isn\'t available here (see `lunos models`)',
      'permission "bsh" doesn\'t match any tool or MCP server here',
      'permission "gitlab_*" doesn\'t match any tool or MCP server here',
      'permission "zz*" doesn\'t match any tool or MCP server here',
      'skill "no-such-skill" isn\'t installed here',
    ])
    expect(AgentEdit.validate({ model: "sonnet" }, known)).toEqual(['model "sonnet" isn\'t in provider/model form'])
    expect(AgentEdit.validate({ steps: -1 }, known)[0]).toContain("isn't a valid agent")
  })
})

describe("AgentFile", () => {
  test("render and parse round-trip, with the prompt as the body", () => {
    const doc = { description: "d", mode: "subagent", permission: { bash: "ask" }, prompt: "Do it.\n\nCarefully." }
    expect(AgentFile.parse(AgentFile.render(doc))).toEqual(doc)
  })
})
