# Claude Code and Codex CLI from Lunos

If you also use Claude Code or Codex CLI, Lunos can start their sessions, send them prompts and their own commands, stream their output, pass their approval requests to you, and record what each session cost. Lunos uses **your own install and your own login**. It never stores, copies or proxies your Anthropic or OpenAI credentials, and it doesn't offer these tools through Lunos Cloud.

> **Status:** Claude Code and Codex CLI both work from the command line and as a tool for Lunos agents. A dedicated TUI tab for these sessions is planned (XCOD-218).

## Setup

1. Install the tool and log in to it in a terminal, the way its vendor documents:
   - Claude Code: `npm install -g @anthropic-ai/claude-code`, then `claude auth login`.
   - Codex CLI: `npm install -g @openai/codex`, then `codex login`.
2. Check what Lunos sees:

   ```sh
   lunos external list
   ```

   This prints each tool's version and login state. A missing tool, or a version without the headless options Lunos needs, is shown with what to do about it.

If a tool isn't on your `PATH`, set its location with `external.claude.path` or `external.codex.path`.

## Sessions

```sh
lunos external run claude "Fix the failing test in src/parse.ts"
lunos external run claude "/review"                    # the tool's own commands and skills
lunos external resume claude <session-id> "Now add a test for it"
lunos external run codex "Add input validation to parse.ts" --model gpt-5.5
lunos external sessions                                # what Lunos started, with status and cost
lunos external stop <session-id>                       # end a running session
```

Commands and skills that Claude Code runs headless work as the prompt, for example `/review` or one of your own skills. Commands that only work in its interactive terminal, such as `/login`, don't. Claude Code then reports an error, and Lunos shows it.

`--model` picks the tool's model for one run; otherwise the tool's own default applies. If your Codex config names a model your account can't use, Codex reports that error and Lunos shows it. `--model` gets round it without editing the config.

After each session Lunos shows what the tool reports:

- **Claude Code** reports a cost (`total_cost_usd`). On a subscription plan this is an estimate, not a bill.
- **Codex CLI** reports tokens, not money, so Lunos shows the token count.

## Handing a task from a Lunos agent

To let Lunos agents hand a task to Claude Code or Codex CLI, turn on the `external_agent` tool:

```json
{ "external": { "delegate": true } }
```

It's off by default, and never offered in offline mode. When an agent uses it, you approve the delegation itself first. Then each edit or command the tool asks approval for comes to Lunos's own approval prompt as `external` → `<tool>:<Action> <target>`. For example: `claude:Write src/app.ts`, `claude:Bash npm test`, `codex:FileChange src/app.ts` or `codex:Bash npm test`. You can allow it once or always, like any other permission. "Always" covers one command for `Bash`, and the tool for file edits. Agents that can't edit (`plan`, `research`, `explore`) can't delegate either. The agent gets back the tool's answer, the files that changed (from `git status`), the cost or tokens the tool reported, and its session id, which you can continue with `lunos external resume`.

## Approvals

Both tools start in their safe settings:

- **Claude Code:** permission mode `default`.
- **Codex CLI:** sandbox `read-only` with approval policy `untrusted`, so every edit and command asks. Lunos drives Codex through `codex app-server`, the protocol that hands approvals to a client. OpenAI marks it experimental.

Each approval request a tool makes comes to Lunos:

- **on a terminal:** Lunos asks you, and passes your answer back;
- **not on a terminal** (CI, scripts): the request is refused, the same rule as `lunos run`. `--auto` approves every request instead. Use it with care.

**What doesn't come to Lunos:** anything a tool's own configuration already allows never asks, so Lunos never sees it.

- **Claude Code:** reads, and anything allowed by rules in `~/.claude/settings.json`, the project's `.claude/settings.json`, or hooks.
- **Codex CLI:** commands its own exec-policy rules mark as safe.

Review those rules if you rely on Lunos to see every edit.

Settings that skip approval or the sandbox are refused unless you ask for one explicitly for that run, for example `--permission-mode bypassPermissions --unsafe`. That covers Claude Code's `bypassPermissions`, and Codex's `danger-full-access` and `never`. They can't be set in config. For Codex, `--permission-mode` takes either a sandbox (`read-only`, `workspace-write`) or an approval policy (`untrusted`, `on-request`).

## Data residency and policy

These tools send your code to their vendors: Claude Code to Anthropic, Codex CLI to OpenAI. Under a residency policy that doesn't allow the vendor's region (for example `"residency": { "allow": ["eu"] }`), Lunos **refuses to start** them, with a message saying why. This applies even if you've pointed the tool at another endpoint in its own settings, because Lunos can't see that configuration.

An organisation can turn the feature off with `"external": { "enabled": false }` and lock it with `"$locked": ["external"]`.

Every session Lunos starts is written to the [audit log](audit-log.md) as `external.session`, and every refusal as `external.denied`. Both record the tool and its provider.

## What Lunos stores

- **Stored:** for each session, the session id, tool, working directory, start and end time, status, and the cost and turn count the tool reported. This lives under Lunos's data directory, on this machine only, so that `sessions`, `resume` and `stop` work.
- **Not stored:** your prompts, the tool's output and the transcript. The transcript is kept by the tool itself (Claude Code keeps it under `~/.claude`).
- **Never touched:** your credentials. The tool runs with your own environment and login.
