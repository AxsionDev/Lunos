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

Codex CLI's own commands belong to its interactive terminal, so Lunos runs the two that Codex can do headless itself:

| Command                                               | What it does                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `/review`                                             | Codex reviews your uncommitted changes and returns its findings. |
| `/review base <branch>`, `/review commit <sha>`       | Reviews the changes against a branch, or one commit.             |
| `/review <instructions>`                              | A review that follows your instructions.                         |
| `lunos external resume codex <session-id> "/compact"` | Compacts that session's context. It needs an existing session.   |

Any other Codex command, such as `/init`, is refused before Codex starts, with the list above. Ask for it in words instead.

`--model` picks the tool's model for one run; otherwise the tool's own default applies. If your Codex config names a model your account can't use, Codex reports that error and Lunos shows it. `--model` gets round it without editing the config.

After each session Lunos shows what the tool reports:

- **Claude Code** reports a cost (`total_cost_usd`). On a subscription plan this is an estimate, not a bill.
- **Codex CLI** reports tokens, not money, so Lunos shows the token count.

## In the TUI

`/external claude` (or `/external codex`) opens a Claude Code (or Codex CLI) session in its own session view, next to your Lunos sessions. It's in the command palette too, as "Start Claude Code or Codex session". The session is listed as `Claude Code · <session id>`, so `/sessions` finds it again after a restart.

- What you type goes to the tool as typed, its own `/commands` included. The prompt suggests the commands the tool reported.
- Each approval the tool asks for appears in that view with the tool's own choices and wording (see [Approvals in a Claude Code or Codex session](#approvals-in-a-claude-code-or-codex-session)). It's still a Lunos approval (`external` → `claude:Write src/app.ts`): audited, and subject to your Lunos permission rules.
- Each reply shows the cost the tool reported for that turn, and the session's total so far. For Codex, it shows tokens.
- Press `esc` twice to stop the tool's turn, as in any session. A pending approval is refused.
- `/external resume claude <session-id>` continues a session started elsewhere, for example with `lunos external run`.

It's gated like `lunos external run`: under a residency policy that doesn't allow the vendor's region, it isn't started, the reason is shown, and the refusal is written to the audit log.

### `/claude` and `/codex`

The quick way in from the prompt:

- `/claude <task>` (or `/codex <task>`) starts a new session of that tool with the task, in its own view, and switches to it. The task goes as typed, so `/codex /review` runs Codex's review.
- `/claude` or `/codex` on its own opens a picker: a new session, or one of that tool's recent sessions in this project to continue.
- Inside a Claude Code or Codex view, `/claude` and `/codex` start a new session; anything else still goes to the tool.

They're listed only while external sessions are on (`external.enabled` isn't `false`). They show greyed out, with the reason, when the tool isn't installed or signed in ("see `lunos external list`"), or as "blocked by policy" under a residency policy that refuses the vendor. Choosing a greyed command says how to fix it and starts nothing; a policy refusal is written to the audit log (`external.denied`). Checking whether the commands are available writes nothing.

If you have your own command, skill or agent command named `claude` or `codex`, yours runs, and Lunos says once that its own is `/external claude` / `/external codex`.

### Knowing where your prompt goes

A Claude Code or Codex session looks different from a Lunos one, so you don't send a prompt to Anthropic or OpenAI by mistake:

- **Label and badge:** `▸ Claude Code` (or `▸ Codex`) sits where the agent and model are in a Lunos session, and `Lunos · Claude Code` (or `Lunos · Codex`) is at the bottom right, with the tool's model once it reports one. These are text, so they show with `NO_COLOR` and on a monochrome terminal.
- **Accent:** the prompt border, cursor, spinner and the tool's reply markers use the tool's colour, a warm terracotta for Claude Code and a green-tinted graphite for Codex. Text, code and diffs keep your theme. A theme can set its own as `externalClaude` / `externalCodex`; the built-in ones reach 4.5:1 on every built-in theme's background. `"external_accent": false` in `tui.json` keeps your theme's colours (the label and badge stay).
- **Session list and sidebar:** these sessions have an accent dot and the tool's name.
- **Desktop and web:** the prompt has the accent border and the same badge.

Claude Code is a product of Anthropic; Codex is a product of OpenAI. Lunos is not affiliated with either, and uses the products' plain names next to its own.

### Keys and the status line, as in the tool

In a Claude Code session the keys follow the tool's, as far as the installed release reports them:

- **`shift+tab`** cycles Claude Code's permission mode through the modes your Claude Code's `--help` lists, in the tool's order: its default (`default`, or `manual` in newer releases), then `acceptEdits`, then `plan`. A mode that skips or auto-decides approvals (`bypassPermissions`, `dontAsk`, `auto`) is never in the cycle. A turn that's running switches at once, and the next turns start in the chosen mode. The key is Lunos's `mode_cycle_reverse` keybind, so rebinding that rebinds this; outside a Claude Code session it cycles Lunos agents as before.
- **The status line** (bottom right) reads `Lunos · Claude Code · <model> · <mode>`, with the mode left out while it's the tool's default.
- **Edits and todos:** Claude Code's `Edit` and `Write` calls show as a diff of the file, and its `TodoWrite` as a checklist, in Lunos's own diff and todo views and your theme.

Codex has no permission mode to cycle: its sandbox and approval policy are set per thread (see [Choosing the settings for every run](#choosing-the-settings-for-every-run)), so `shift+tab` does nothing there.

Not there yet: Claude Code's `!` (shell) and `#` (memory note) prefixes, because Claude Code in headless mode doesn't report them. In a Claude Code or Codex session, `!` doesn't switch to Lunos's shell mode. Like `#`, it's sent to the tool as typed, with the rest of the line.

### Your Lunos commands in a Claude Code or Codex session

The prompt's `/` list shows the tool's own commands first, with the description and arguments the tool gives them, then your Lunos custom commands and MCP prompts ("Lunos command"). A Lunos command is expanded by Lunos (its template, arguments and `@file` references) and the text it makes goes to the tool. When both have a command of the same name, the tool's keeps the bare name and Lunos's is `/<name>:lunos`, so `/review` in Codex is Codex's and `/review:lunos` is yours.

Lunos commands that switch a Lunos agent, mode or model provider (`/agents`, `/modes`, `/providers`, `/variants`) are shown greyed out with "Not available in a Claude Code session" and never sent to the tool. Lunos's own screens (`/settings`, `/marketplace`, `/memory`, `/help`, …) work as usual.

### The tool's model, `/compact` and `/cost`

In the terminal app, some Lunos commands act on the tool's session instead:

- **`/models`** lists the tool's models under "Claude Code models" or "Codex models", never Lunos's. Lunos asks the tool itself without sending a prompt, so no model is called: Claude Code lists them when Lunos starts it, and Codex through its app server's model list. If Claude Code doesn't list them, its aliases (Opus, Sonnet, Haiku) are offered. The model you choose is saved on the session and used from your next message on, also after a Lunos restart or a resume, and the prompt shows it (`Lunos · Claude Code · sonnet`). Choose Default to go back to the tool's own default.
- **`/compact`** has the tool compact its own session: Claude Code's `/compact`, or Codex's compaction. No Lunos model sees the conversation.
- **`/cost`** shows the cost Claude Code reported for the session. Codex reports tokens, not money, so its cost shows as "not reported", with the tokens used so far.

### Your MCP servers, skills and memory

After you agree, once per tool and project, Lunos can offer a Claude Code or Codex session your Lunos MCP servers, skills and memory through the Lunos bridge. Every call asks in Lunos unless your permission rules allow that tool by name, and is audited. Their results are sent to Anthropic or OpenAI with your prompts. See [External sessions: what Lunos adds](external-what-lunos-adds.md).

## Handing a task from a Lunos agent

To let Lunos agents hand a task to Claude Code or Codex CLI, turn on the `external_agent` tool:

```json
{ "external": { "delegate": true } }
```

It's off by default, and never offered in offline mode. When an agent uses it, you approve the delegation itself first. Then each edit or command the tool asks approval for comes to Lunos's own approval prompt as `external` → `<tool>:<Action> <target>`. For example: `claude:Write src/app.ts`, `claude:Bash npm test`, `codex:FileChange src/app.ts` or `codex:Bash npm test`. You can allow it once or always, like any other permission. "Always" covers one command for `Bash`, and the tool for file edits. Agents that can't edit (`plan`, `research`, `explore`) can't delegate either. The agent gets back the tool's answer, the files that changed (from `git status`), the cost or tokens the tool reported, and its session id, which you can continue with `lunos external resume`.

## Approvals

### Approvals in a Claude Code or Codex session

An approval in a Claude Code or Codex session offers the tool's own choices, built from what the tool sent with the request:

- **Claude Code:**
  - **Yes:** allow this call.
  - **Yes, and don't ask again for …:** shown only when Claude Code suggests something to stop asking for, and named from it. For example, `Bash(npm test:*)`, or edits in this session (accept edits mode). Claude Code applies it to this session only. Lunos never lets it write the rule into `~/.claude/settings.json` or the project's settings files. Lunos also stores it as an "Allow always" approval. Like any "Allow always", that applies to this project until Lunos restarts, so matching calls in your other Claude Code sessions here aren't asked either. A rule suggestion is stored as the same rule (`Bash(npm test:*)` → `claude:Bash npm test*`). For the accept-edits choice, the session's mode switches to accept edits, so its next turns start in it, and Lunos stores the call's own tool (`claude:Write *` for a Write).
  - **No, and tell Claude what to do differently:** asks what to do instead. With text, Claude Code gets it and carries on. With none, the call is refused and the turn stops. `esc` refuses and stops.
- **Codex:** the decisions its app server defines for the request. **Yes**; **Yes, for this session** (for file changes: "don't ask again for these files"); **No, carry on without it**; **No, and stop**. Codex's own options that change its exec-policy or network rules aren't offered, because they're saved into Codex's configuration.

**Lunos's rules still win.** Lunos registers a check with Claude Code when it starts. Claude Code 2.1.304 reports that it applies it. With that check, every call Claude Code makes is checked against your Lunos `permission` rules before Claude Code's own permission mode decides. A Lunos `deny` rule (for example `"permission": { "external": { "claude:Bash rm *": "deny" } }`) refuses the call even in `acceptEdits` or `auto`, where Claude Code wouldn't ask. Claude Code is told "Blocked by Lunos policy" with the rule's name, and the refusal is written to the audit log. Codex has no such hook. There, a Lunos deny rule applies to what Codex asks about, which under the default approval policy (`untrusted`) is every edit and command.

### The settings each tool starts in

Both tools start in their safe settings:

- **Claude Code:** permission mode `default`.
- **Codex CLI:** sandbox `read-only` with approval policy `untrusted`, so every edit and command asks. Lunos drives Codex through `codex app-server`, the protocol that hands approvals to a client. OpenAI marks it experimental.

Each approval request a tool makes comes to Lunos:

- **on a terminal:** Lunos asks you, and passes your answer back;
- **not on a terminal** (CI, scripts): the request is refused, the same rule as `lunos run`. `--auto` approves every request instead. Use it with care.

**What doesn't come to Lunos:** anything a tool's own configuration already allows never asks, so Lunos never sees it.

- **Claude Code:** reads, and anything allowed by rules in `~/.claude/settings.json`, the project's `.claude/settings.json`, or hooks.
- **Codex CLI:** commands its own exec-policy rules mark as safe.

Review those rules if you rely on Lunos to see every edit. In Claude Code (2.1.304 reports applying the check), your Lunos `deny` rules are still checked on those calls before its own rules and mode, but Lunos plugin hooks and approvals aren't (see [Approvals in a Claude Code or Codex session](#approvals-in-a-claude-code-or-codex-session)); nothing else about those calls comes to Lunos.

Settings that skip approval or the sandbox are refused unless you ask for one explicitly for that run, for example `--permission-mode bypassPermissions --unsafe`. That covers Claude Code's `bypassPermissions`, and Codex's `danger-full-access` and `never`. They can't be saved to config, and one already in a config file is ignored (the safe default is used) and flagged in `/settings`. For Codex, `--permission-mode` takes either a sandbox (`read-only`, `workspace-write`) or an approval policy (`untrusted`, `on-request`).

### Choosing the settings for every run

`/settings` → Models & agents lists each one as a choice, with what it does. Manual approval (the safe default above) is selected when nothing is set; choosing it writes nothing, or removes the key if one is set. The unsafe values are listed greyed out with how to pass them for one run.

| Key                               | Values                                                                                       | Default     |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ----------- |
| `external.claude.permission_mode` | `default`, `acceptEdits`, `plan`, `auto`, `dontAsk` (what your Claude Code's `--help` lists) | `default`   |
| `external.codex.sandbox`          | `read-only`, `workspace-write`                                                               | `read-only` |
| `external.codex.approval_policy`  | `untrusted`, `on-request`                                                                    | `untrusted` |

An empty value means the default. `auto` lets Claude Code's own classifier approve routine actions, so those don't come to Lunos.

`external.codex.permission_mode` (one field for either a sandbox or an approval policy) still works while the new keys are unset. Saving either new key moves it: its value goes to whichever of the two it names.

### The tools' own configuration

`/settings` → Models & agents → External sessions → **Claude Code's own configuration** (or **Codex CLI's own configuration**) shows the tool's own settings as the installed tool reports them. Each value shows where it comes from: the scope (user, project, local, plugin, managed) and the file, when the tool says. A value the tool doesn't attribute is marked **source unknown**. Lunos doesn't guess.

| Tool        | What's shown                                                                                            | Where Lunos gets it                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Model, permission mode, output style, CLAUDE.md files, MCP servers, hooks, agents, settings files       | Claude Code's answers to its host protocol: its settings layers, CLAUDE.md files, MCP servers with their scope, and hooks with their source |
| Codex CLI   | Model, reasoning effort, approval policy, sandbox, AGENTS.md files, MCP servers, profiles, config files | `codex app-server`: `config/read` with the layer each value comes from, and the AGENTS.md files a new thread here would load                |

Claude Code names a settings layer (user, project, local), not a file. Lunos shows the file Claude Code documents for that layer, and only when the file exists. It doesn't say where an agent comes from either. Lunos looks for the agent's file in `.claude/agents` and `~/.claude/agents`, and otherwise marks it source unknown. Codex lists its `[profiles.*]` tables and the profile in use, but not its other profile files (`<name>.config.toml`), so those aren't shown. A release that doesn't answer one of these requests has that part hidden.

The permission mode and sandbox shown are the tool's own defaults. Lunos's sessions still start in `external.claude.permission_mode`, `external.codex.sandbox` and `external.codex.approval_policy`, and the view says so next to them.

**Changes go through the tool's own commands only.** MCP servers can be added and removed with `claude mcp add -s <scope>` / `claude mcp remove`, or `codex mcp add` / `codex mcp remove`. Lunos shows the exact command and the file the tool will change, for example `claude mcp add -s user docs -- npx -y docs-mcp` changing `~/.claude.json`. It runs only after you confirm, and then shows the tool's own output. The change is written to the audit log as `external.config`. To add a server that needs environment variables or headers, use a terminal, so they're never shown in Lunos. Where the tool has no command (model, permission mode, hooks, profiles), **Open in your editor** opens the file the tool names, if it exists. Lunos never writes `~/.claude`, `~/.codex` or the project's tool files itself.

Reading is gated like starting a session: under `external.enabled: false`, or a residency policy that refuses the vendor, nothing is started and the reason is shown. Nothing is read until you open the view. Secrets aren't shown: no settings `env`, no MCP server arguments, environment or headers, and URLs without their query.

Reading starts the tool without a prompt, so no model is called:

- **Claude Code** runs with your hooks off (`--settings {"disableAllHooks":true}`) and without saving a session (`--no-session-persistence`). Claude Code itself still updates `~/.claude.json` and connects to your MCP servers when it starts, as it does on any start.
- **Codex** runs `codex app-server` with an ephemeral thread and no turn. Codex itself still refreshes its caches in its home folder when it starts.

## Data residency and policy

These tools send your code to their vendors: Claude Code to Anthropic, Codex CLI to OpenAI. Under a residency policy that doesn't allow the vendor's region (for example `"residency": { "allow": ["eu"] }`), Lunos **refuses to start** them, with a message saying why. This applies even if you've pointed the tool at another endpoint in its own settings, because Lunos can't see that configuration.

An organisation can turn the feature off with `"external": { "enabled": false }` and lock it with `"$locked": ["external"]`.

Every session Lunos starts is written to the [audit log](audit-log.md) as `external.session`, and every refusal as `external.denied`. Both record the tool and its provider.

## Verified against

The releases whose recorded traffic the adapters' contract tests replay. A release not listed here works as far as the tests against fake tools show, but hasn't been checked against the real tool. How to record a release: [external-fixtures.md](external-fixtures.md).

| Tool | Release | Recorded | Models | Bridge | Hooks and approvals | Compact |
| ---- | ------- | -------- | ------ | ------ | ------------------- | ------- |

## What Lunos stores

- **Stored:** for each session, the session id, tool, working directory, start and end time, status, and the cost and turn count the tool reported. This lives under Lunos's data directory, on this machine only, so that `sessions`, `resume` and `stop` work.
- **Not stored** (`lunos external run` and the `external_agent` tool): your prompts, the tool's output and the transcript. The transcript is kept by the tool itself (Claude Code keeps it under `~/.claude`).
- **A session in the TUI** is a Lunos session, so its prompts and the tool's replies are stored like any other session's, in Lunos's local database, and can be deleted like one.
- **Never touched:** your credentials. The tool runs with your own environment and login.
