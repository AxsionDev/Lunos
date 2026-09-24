# Subagent parity audit: Lunos agents vs Claude Code subagents (XCOD-83)

**Date:** 2026-09-24. Every claim below was checked against `origin/dev` by running `lunos` (`agent list`, `debug agent <name>`) or reading the code path cited; none is assumed.

## Summary

| Area                                          | Claude Code                                               | Lunos before XCOD-83                                                                                                                                                                            | Lunos now                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery of `.claude/agents/*.md`            | Project and `~/.claude/agents`                            | **Not read.** Only `{agent,agents}/**/*.md` under `.opencode/` and the global config dir (`config/agent.ts`, `config/paths.ts`). `.claude/skills` _is_ read, so the two were inconsistent       | **Read** from the project (walking up to the worktree) and `~/.claude/agents`. Lunos config wins on a name clash. `OPENCODE_DISABLE_CLAUDE_CODE` turns it off |
| `tools:` syntax                               | Allow-list: `tools: Read, Grep, Glob` or a YAML list      | `{ tool: boolean }` record only. **A Claude-format string made the whole config invalid**: `Expected object \| undefined, got "Read, Grep, Glob"`. One copied agent file stopped Lunos starting | Allow-list translated to `{ "*": false, read: true, … }`. `debug agent` shows exactly those tools enabled                                                     |
| `model:`                                      | Aliases (`sonnet`, `opus`, `haiku`, `inherit`) or full id | `provider/model` only; an alias fails to resolve                                                                                                                                                | An alias is dropped, so the agent inherits the main model. `provider/model` is unchanged                                                                      |
| Tool scoping per agent                        | `tools:` allow-list                                       | `tools` record → permission rules, plus `permission:` (`core/src/v1/config/agent.ts` `normalize`)                                                                                               | Unchanged. The allow-list now maps onto the same rules                                                                                                        |
| Skills restricting tools (`allowed-tools`)    | Supported                                                 | Not supported (audit gap G3). XCOD-71 used a lock file and a guard hook                                                                                                                         | Supported, per turn, through the permission system. See `skills.mdx` "Restrict tools"                                                                         |
| Hooks know the active agent / skill           | Agent context available to hooks                          | Only `LUNOS_HOOK_EVENT`, `LUNOS_TOOL`, `LUNOS_FILE`, `LUNOS_SESSION_ID`                                                                                                                         | Adds `LUNOS_AGENT` (tool events) and `LUNOS_SKILL` (skills active this turn)                                                                                  |
| Per-agent `color`, `description`, prompt body | Supported                                                 | Supported                                                                                                                                                                                       | Unchanged                                                                                                                                                     |

## Loading rules for Claude Code agent files

These files are written for another tool, so Lunos loads them the way Claude Code does, and never lets one break startup:

- Only files whose frontmatter has both `name` and `description` are agents. READMEs and prompt fragments in the same directory are skipped.
- `tools`, `model` and `color` are translated. Claude's colour names (`cyan`) are dropped; Lunos takes hex codes or theme colours.
- A file Lunos still can't use is **skipped with a warning**. It doesn't invalidate the config. Checked against this repository's own `.claude/agents`: 33 real Claude Code agents load, none skipped.

## Deliberate differences (not closed)

- **Model aliases aren't mapped to Lunos models.** `sonnet` has no single meaning across Lunos's providers, and guessing one could route a subagent to a provider the residency policy denies. Dropping the alias and inheriting is the predictable choice. Per-type model selection is XCOD-82.
- **Claude Code tool names that have no Lunos equivalent** (for example `NotebookEdit`) are carried into the allow-list as-is and simply match nothing.
- **Lunos-only agent fields** (`mode`, `hidden`, `steps`, `permission`, `variant`) have no Claude Code counterpart and are unaffected.
- **`allowed-tools` lives on the v1 skill path as well as v2.** Live sessions load skills through the v1 `skill` tool (`packages/opencode/src/tool/skill.ts`), so enforcement is wired there. v2 `SkillV2.Info` parses the same field, for the v1→v2 cutover.

## Code

- Claude agent translation: `packages/opencode/src/config/agent.ts` `fromClaudeCode`
- `.claude/agents` discovery: `packages/opencode/src/config/config.ts`, after the config-directory loop
- Skill scope and rules: `packages/opencode/src/skill/scope.ts`
- Enforcement: `session/llm/request.ts` `resolveTools` (what the model is offered) and `session/tools.ts` `ctx.ask` ruleset (what may run)
- Hook environment: `packages/opencode/src/plugin/hooks.ts`
- Real-run tests: `test/cli/run/skill-allowed-tools.test.ts`. A/B: with the read-only skill loaded, the write is blocked; without it, the same write applies. Hook-env lines are asserted exactly.
