# External sessions: what Lunos adds

A Claude Code or Codex session started from Lunos (`/claude`, `/codex`) works with your own Claude Code or Codex install and login. On top of the tool itself, Lunos can offer it your Lunos MCP servers, skills and memory, through one MCP server called the **Lunos bridge**. It does that only after you agree, once per tool and project.

Claude Code is a product of Anthropic; Codex is a product of OpenAI. Lunos is not affiliated with either.

## Where your data goes

The tool's model runs at its vendor. Whatever the tool reads through the Lunos bridge, such as an MCP tool's result, a skill's instructions or a remembered fact, becomes part of its conversation. **It is sent to Anthropic (Claude Code) or OpenAI (Codex) with your prompts**, under that vendor's terms, not Lunos's. That's why Lunos asks first:

> Share Lunos tools, skills and memory with Claude Code? Their results are sent to Anthropic with your prompts.

- **Share:** the bridge is offered to that tool in this project from now on.
- **Not now:** the tool runs as it does without Lunos, and you're asked again in the next session.
- **Never for this tool:** the tool runs as it does without Lunos, and you're not asked again in this project.

Your answer is kept on this machine, in Lunos's state directory, per tool and per project. It is never kept in config, so a repository can't answer for you. You can change it in `/settings` → Models & agents → External sessions, or with `lunos external share <claude|codex> <share|never|ask>`.

Until you choose Share, no bridge is started, nothing is written for the tool, and the session works exactly as it did before. The same applies if `external.enabled` is off or the residency policy refuses the tool: then the session doesn't start at all.

## What works in each tool

| From Lunos                                              | Claude Code                                                 | Codex CLI                                             |
| ------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Your MCP servers (`lunos__<server>__<tool>`)            | Through the bridge, after you agree                         | Through the bridge, after you agree                   |
| Skills (`lunos_skill_list`, `lunos_skill_load`)         | Through the bridge, after you agree                         | Through the bridge, after you agree                   |
| Memory (`lunos_memory_search`, `lunos_memory_remember`) | Through the bridge, while memory is on                      | Through the bridge, while memory is on                |
| Your custom commands and MCP prompts                    | In the `/` list, expanded by Lunos                          | In the `/` list, expanded by Lunos                    |
| `/models`, `/compact`, `/cost`                          | The tool's models, compaction and reported cost             | The tool's models and compaction; cost "not reported" |
| How the bridge is handed over                           | A generated `--mcp-config` file, when its `--help` lists it | An `mcp_servers` override on the thread               |
| Plugin hooks on the tool's own tool calls               | Before the calls it asks about, after every call            | Before the calls it asks about, after every call      |

The tool's own plugins and MCP servers keep working as before. Lunos never changes `~/.claude`, `~/.claude.json` or `~/.codex`: the bridge is handed to the tool on its command line (Claude Code) or in the session request (Codex), for that turn only.

If the tool can't be handed the bridge (a Claude Code whose `--help` doesn't list `--mcp-config`, or a Codex that refuses the override), the session runs as it does without Lunos and the status line says why. It's never an error.

## Every call still goes through Lunos

The tool sees the bridge as one MCP server. Each call it makes is run by the Lunos session that started it, the same way a Lunos agent's call is:

- **Approval:** each call asks in Lunos with the tool it really runs (for example `echo_say` for the `echo` server's `say`). Your permission rules apply. A call is allowed without asking only where a rule names that tool, or you chose "always" for it. A catch-all `"*": "allow"` doesn't count, because the result leaves for the tool's vendor.
- **Policy:** a server, skill or memory tool that a `deny` rule turns off isn't offered. Under a residency policy, a remote MCP server is offered only when its region is declared in `residency.endpoints` as `mcp:<name>` and the policy allows it. A local server runs on this machine and is always allowed.
- **Hooks:** Lunos plugins' `tool.execute.before` and `tool.execute.after` hooks run on every call.
- **Audit:** every call is a `tool.run` entry in the [audit log](audit-log.md), like a native call. Each turn with the bridge is an `external.bridge` entry, and each consent answer is an `external.consent` entry.
- **Memory:** search and remember follow the session's memory on/off state and scopes. A fact is refused after the tool used a web tool, any MCP server's tool, or read a file outside the project in that turn, the same rule a Lunos session follows. Each fact asks you before it's stored.

Results come back labelled, for example `[Result from Lunos's MCP server "echo"]`, so the tool can tell them from its own.

A server installed from `/marketplace` during the session is offered from the tool's next turn, without a restart. During a turn, the bridge tells the tool when the list changes.

## Choosing what's shared

Each of these is on by default once you agree. Set one to `false` to leave it out. An organisation can lock any of them in managed config, for example `"$locked": ["external.share.memory"]` with `"external": { "share": { "memory": false } }`. A locked key shows as fixed in `/settings` and can't be changed.

| Key                       | What it covers                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| `external.share.mcp`      | Your MCP servers through the bridge                                       |
| `external.share.skills`   | Your skills through the bridge                                            |
| `external.share.memory`   | Lunos memory through the bridge                                           |
| `external.share.commands` | Your custom commands and MCP prompts in the `/` list (`false` hides them) |
| `external.share.hooks`    | Lunos plugin hooks on the tool's own tool calls (no consent needed)       |

## Lunos hooks on the tool's own calls

Your Lunos plugins' `tool.execute.before` and `tool.execute.after` hooks, and the `hooks` in your config, also run on the calls Claude Code and Codex make with their own tools. They see the call as they would in a Lunos session: Claude Code's `Bash` is `bash` and `Edit` is `edit`, Codex's command is `bash` and its file change `apply_patch`, and arguments take Lunos's names (`filePath`, not `file_path`). A call with no Lunos counterpart, such as another MCP server's tool, keeps the tool's name. `input.external` says which tool made it.

- **Before a call:** Lunos runs the hooks before the call runs. A hook that throws refuses the call, without asking you, and the tool is told why (`Refused by a Lunos plugin hook: …`). It carries on with that, as a Lunos agent does. The refusal is written to the [audit log](audit-log.md) as a `permission.decision` with `denied by plugin hook`. A hook that denies `rm -rf` in `bash` refuses it in both tools.
  - **Claude Code:** the hooks run in the check Lunos registers with Claude Code (its `PreToolUse` hook), after your Lunos `deny` rules and before Claude Code's own permission mode decides. So they also see calls Claude Code would allow without asking, in `acceptEdits` or `auto`, or through rules in your own Claude Code settings. Each call runs them once, even when Claude Code then asks for approval.
  - **Codex:** the hooks run when Codex asks for approval. Codex has no hook a host can register, so a call Codex allows by itself isn't seen beforehand.
- **After a call:** once the tool reports a call's result, the hooks run with its output. A call that was refused doesn't run them. A failing hook is logged and never fails the turn.
- **Session hooks:** `session.created`, `session.idle`, `session.error` and `session.deleted` fire for an external session as for any Lunos session.

Hooks run in Lunos, on this machine, and send nothing to Anthropic or OpenAI. That's why they don't wait for the sharing question: they run even if you chose Never. Set `external.share.hooks` to `false` to turn them off for external sessions.

What they can't do yet:

- **Codex: only calls it asks about.** A call Codex allows by itself, for example because it knows a command is safe or its approval policy is `never`, never reaches Lunos before it runs, so the before hooks don't see it. The after hooks still do.
- **Claude Code without the check.** If Claude Code answers that it won't apply the check (`hooks_applied: false` on `initialize`), Lunos shows a warning and logs it. Then only calls Claude Code asks about run the before hooks, as for Codex. Claude Code 2.1.304 applies it. A release that answers `false` hasn't been recorded.
- **Block or allow only.** A hook that rewrites `args` is logged as a warning and not applied: the tool runs its own arguments. Claude Code takes changed arguments from its hook (`updatedInput`) only together with an allow, which would skip its own approval, or an ask, which would force one. Codex has no way to take them.
- **No compaction hook.** `session.compacted` doesn't fire when the tool compacts its own session.

## The status line

The session's header in the sidebar, and the line under the prompt (where a Lunos session shows its directory), show what the bridge offered on the last turn: `Lunos bridge: 2 servers, 3 skills, memory on`. If the tool didn't connect to it, the line ends with `⚠ not connected`, in the warning colour. When there's no bridge, it says why, for example `Lunos bridge: off (not shared in this session)`.

`lunos external list` prints the same line for each tool, for the current project:

```text
Claude Code  2.1.292, logged in
             Lunos bridge: 1 server, 1 skill, memory off
Codex CLI    0.160.1, logged in
             Lunos bridge: off (not shared yet: asked in the first session)
```

## Not verified against the real tools yet

Codex may ask to approve an MCP server's tool call, the Lunos bridge's included. Lunos answers that request in the two shapes the app server is known to use: an `mcpServer/elicitation/request` marked as a tool call's approval, or an approval question through `item/tool/requestUserInput`. A call to the Lunos bridge is approved at once, since the bridge asks you itself. A call to another server goes through your hooks and asks in Lunos. Neither shape is in the recorded fixtures for Codex 0.160.1.

The Claude Code flag (`--mcp-config`) and the Codex field (`config` on `thread/start` and `thread/resume`, with the `mcp_servers.lunos` key) aren't in the recorded protocol fixtures. They were tested against stand-ins only. If a release takes them differently, the bridge shows as off or not connected, and the session works as it does without Lunos.
