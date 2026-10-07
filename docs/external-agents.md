# Claude Code and Codex CLI from Lunos

If you also use Claude Code or Codex CLI, Lunos can start their sessions, send them prompts and their own commands, stream their output, pass their approval requests to you, and record what each session cost. Lunos uses **your own install and your own login**. It never stores, copies or proxies your Anthropic or OpenAI credentials, and it doesn't offer these tools through Lunos Cloud.

> **Status:** Claude Code is supported from the command line. Codex CLI, the TUI tab and delegation from a Lunos agent are in progress (XCOD-204).

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
lunos external sessions                                # what Lunos started, with status and cost
lunos external stop <session-id>                       # end a running session
```

Commands and skills that Claude Code runs headless work as the prompt, for example `/review` or one of your own skills. Commands that only work in its interactive terminal, such as `/login`, don't. Claude Code then reports an error, and Lunos shows it.

The cost shown after each session is the figure the tool reports (Claude Code's `total_cost_usd`). On a subscription plan this is an estimate, not a bill.

## Approvals

Claude Code starts in its safe mode (`default`), where every edit and command needs approval. Each approval request comes to Lunos:

- **on a terminal:** Lunos asks you, and passes your answer back;
- **not on a terminal** (CI, scripts): the request is refused, the same rule as `lunos run`. `--auto` approves every request instead. Use it with care.

Modes that skip approval altogether (`bypassPermissions`) are refused unless you ask for one explicitly for that run: `--permission-mode bypassPermissions --unsafe`. They can't be set in config.

## Data residency and policy

These tools send your code to their vendors: Claude Code to Anthropic, Codex CLI to OpenAI. Under a residency policy that doesn't allow the vendor's region (for example `"residency": { "allow": ["eu"] }`), Lunos **refuses to start** them, with a message saying why. This applies even if you've pointed the tool at another endpoint in its own settings, because Lunos can't see that configuration.

An organisation can turn the feature off with `"external": { "enabled": false }` and lock it with `"$locked": ["external"]`.

Every session Lunos starts is written to the [audit log](audit-log.md) as `external.session`, and every refusal as `external.denied`. Both record the tool and its provider.

## What Lunos stores

- **Stored:** for each session, the session id, tool, working directory, start and end time, status, and the cost and turn count the tool reported. This lives under Lunos's data directory, on this machine only, so that `sessions`, `resume` and `stop` work.
- **Not stored:** your prompts, the tool's output and the transcript. The transcript is kept by the tool itself (Claude Code keeps it under `~/.claude`).
- **Never touched:** your credentials. The tool runs with your own environment and login.
