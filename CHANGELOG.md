# Changelog

All notable changes to Lunos are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**About this file.** Lunos is a fork of [opencode](https://github.com/sst/opencode). This changelog
records _Lunos's own_ changes — the fork's branding, infrastructure, and EU-sovereignty work — not
the full upstream history, which lives in opencode's repository. Where an upstream release is
merged in, it is noted as a single entry rather than expanded.

Per-release binary notes are generated automatically by the release pipeline and attached to each
GitHub Release. This file is the curated, human-written view. Longer-form notes explaining the
reasoning behind a change are published separately as **Lunos Notes**.

How to write an entry (no ticket ids in the text, the user benefit first): see "Writing CHANGELOG.md
entries" in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## [Unreleased]

## [1.18.52] - 2026-10-20

### Added

- **See what memory uses at the top of `/memory`, and change it from there.** The Overview tab now
  opens with a Storage panel: on this computer (with the path, size on disk, and the model and its
  region), a database in Docker (with the container's name, image and whether it's running), a team
  database (host, jurisdiction and TLS; credentials are never shown, only the variable names they
  come from) or a managed cloud database (provider, region and whether your residency policy allows
  it). It shows the template that set it up and its live status. **Change storage…** opens the
  templates and storage cards and asks whether to move your facts or start empty. **Move my facts**
  counts them on both sides, and **Start empty** says where the old ones stay. **Test connection**
  updates "checked", **Start container** restarts a stopped Docker database, and **Open in
  Settings** goes to Settings › Memory. When your organisation sets the storage, the panel says so.
  `lunos memory status` prints the same block, and `lunos memory storage set --template <name>` or
  `--backend <type>`, with `--move` or `--empty`, changes it from a script. <!-- XCOD-277 -->

- **`lunos sandbox doctor` checks whether a sandbox can start on this machine.** It lists each check
  (Docker or Podman installed and running, Linux containers, the git repository, the workspace mode,
  the image, and a throwaway test container) with pass or fail and, for a failure, what to do.
- **When Lunos fails, it says where the full details are.** Every run writes a log, and a failure
  (Lunos not starting, a failed `/restart`, a sandbox that won't start, a crash, an unexpected error)
  now ends with `Full log: <path>`, a clickable link in terminals that support it, and
  `Report it: lunos bug-report <id>`. The log has the full error with its causes, and each command
  Lunos ran with its exit code and output, so nothing has to be run again with extra flags. API keys,
  tokens and passwords are removed, and your prompts are never written to it.
- **`lunos logs` and `lunos bug-report`.** `lunos logs` lists recent runs; `lunos logs <id>` shows
  one, `--open` opens it, and `--dir` prints where logs are kept. `lunos bug-report [id]` packs a
  run's log with the version, the relevant config (secrets removed) and the sandbox checks into a zip you can check and
  attach to an issue yourself. Nothing is uploaded. In the TUI, `/logs` lists them, and an error
  about something running in the background (such as an MCP server that didn't start) has
  **Open log**.
- **Log retention settings.** Lunos keeps the last 10 runs plus failed runs from the last 14 days,
  within 50 MB. Change this with `log.retention_days` and `log.max_mb`; an organisation can lock it.
- **A different tip every time.** The home screen shows a new tip on each start, and a turn that
  runs for more than 3 seconds shows one line under the working indicator. Tips come from a deck
  shuffled for you, so none repeats until you've seen them all, and the same tip never shows twice
  in a row. There are now over 230 tips about Lunos itself: the Agent Monitor, the marketplace,
  memory, Claude Code and Codex sessions, language servers, sandboxes, your account and more. Tips
  only appear when they apply to you (memory tips once memory is on, nothing about a feature your
  organisation has turned off), and a tip shows your own key when you've changed a keybind. `/tips`
  lists every tip by category, searchable, with the ones you've seen marked; `tips_next` (unbound
  by default) shows another; "Hide tips" stays, and `"tips": false` in `tui.json` turns them off.
  Which tips you've seen is kept on your computer only. <!-- XCOD-278 -->

### Changed

- **`lunos` shows its home screen about a second sooner.** The screen and the prompt no longer wait
  for the local server, plugins or MCP servers: on a Mac a warm start now draws in about half a
  second instead of one and a half. You can type straight away; a prompt you send before Lunos is
  ready waits under the prompt ("Starting… your prompt is sent once ready") and goes out as soon as
  it can. The "Loading plugins…" box is gone: what's still loading shows as one quiet line at the
  bottom ("plugins loading · MCP connecting… (3)"), and MCP servers that didn't connect are named
  there for a few seconds. In a terminal that doesn't report its colours, start-up no longer waits a
  full second for it. To see where the time goes, run `lunos debug startup`, or start with
  `LUNOS_STARTUP_TRACE=1`. <!-- XCOD-276 --> <!-- highlight -->

### Fixed

- **Turning on the sandbox can no longer lock you out of Lunos.** Before it's saved in `/settings`,
  Lunos checks that a sandbox can start here and refuses the change with the reason and the fix
  (for example "Docker Desktop isn't running — start it and try again"). If a restart after a
  sandbox change still can't start, the change is undone and Lunos starts as before. When the
  sandbox can't start, Lunos offers to start without it this time (unless your organisation
  requires the sandbox), and `lunos --no-sandbox` skips it for one start. <!-- highlight -->
- **A sandbox that can't start now says why instead of "Unexpected error".** You see which step
  failed, the Docker command it ran (secrets hidden), its exit code and output, and a fix for the
  common cases: Docker not installed or not running, Windows-containers mode, WSL 2 missing, an
  image that can't be pulled, no network, or a port in use.
- **Sandbox on Windows:** Docker is found as `docker.exe`, and in Docker Desktop's install folder
  when it isn't on PATH yet; the repository is copied from drive-letter paths such as `D:\work`;
  mounted folders use paths Docker Desktop and Podman accept; and the command printed after a
  failed restart runs in PowerShell.

## [1.18.51] - 2026-10-20

### Added

- **Manage your organisation's people with `lunos org`, and see your role in `/account`.** Owners
  and admins list members and pending invitations, invite by e-mail (invitations last 7 days), revoke
  invitations and remove people; owners also make or remove owners and transfer ownership. Anyone
  can list their organisations, see whom to ask, leave, and accept or decline the invitations
  waiting for them. Lunos Cloud checks every action against your role, and when yours can't do it
  you're told whom to ask, such as "Only an organisation owner can do this. Ask:
  owner@acme.example". `--json` prints results and refusals for scripts, and `--yes` skips the
  confirmation. `/account` now shows your role in each organisation ("Owner · Acme GmbH"), your
  plan, and your invitations with Accept and Decline. **Delete my account** now deletes the account
  itself 30 days later, after you type `delete` to confirm, and signs you out; the only owner of an
  organisation is told to transfer ownership first. When the Terms or the Privacy notice change,
  Lunos Cloud records which version you accepted, and the next start asks you to accept the new one.
  See "Organisations and roles" in the docs. <!-- XCOD-274 -->
- **Sign in with a free Lunos account, from inside the TUI.** The official build now opens on a
  Welcome screen the first time: tick the Terms and Privacy notice, choose Create a free account or
  Sign in, and confirm the code shown in large letters (with a QR code) in your browser. New
  accounts confirm their e-mail address, and the screen moves on by itself. No card is ever asked
  for, and every local feature stays free. Each failure (an expired code, a denial, being offline,
  the sign-in service unreachable, an unconfirmed address) says what happened and offers Try again.
  `/login`, `/logout` and `/account` (plan, organisations, devices, sign out everywhere, delete the
  account) work at any time, and `/settings` has an Account entry. Self-hosted, offline and CI use
  need no account: managed `"auth": { "required": false }`, an organisation's own `cloud.issuer`,
  `LUNOS_OFFLINE=1`, `lunos run`, non-interactive terminals, `CI=true` and builds from source skip
  it and contact no Lunos service. In CI, cloud features take a token from `LUNOS_TOKEN`.
  <!-- XCOD-273 --> <!-- highlight -->
- **Watch and steer all your agents from one screen.** Press ← on an empty prompt (or type
  `/monitor`) to open the Agent Monitor: every session on this computer on the right, grouped into
  waiting for you, running, completed and failed, with what each waiting one asks. Approve or deny
  from the list, or stop a session. The prompt in the centre starts a new session and keeps you in
  the monitor, or sends to the sessions you tag, as in `@2 run the tests`. A busy session gets the
  prompt when its turn ends, and a session another Lunos runs gets it through that Lunos. A prompt
  never approves a tool call. <!-- XCOD-262 --> <!-- highlight -->
- **The same Agent Monitor in the desktop app and the web UI.** The Sessions window now lists
  every session by status on the right (waiting for you with what each asks, running, completed,
  failed, each counted and numbered), with Approve and Deny on the row. The prompt in the centre
  starts a new session in the project you pick, or sends to the sessions you tag with `@2` or `@`
  and part of a name, shown as chips; sending to several asks first. "By group" still shows your
  groups. <!-- XCOD-262 -->
- **Prompts you queued for a busy session survive its Lunos closing.** If the Lunos running a
  session quits or crashes with prompts still queued for it, the session shows "2 queued (owner
  closed)" in the Agent Monitor and the Sessions window. Nothing sends them until you take the
  session over: the confirmation says how many there are, and offers to send them first, in order,
  or discard them. A prompt is never sent twice. The Sessions window also remembers whether you
  last arranged the list by status or by group. <!-- XCOD-262 -->
- **Send a closed Lunos's queued prompts without writing a new one.** A session showing "2 queued
  (owner closed)" now has **Take over** on its row in the Sessions window, and `t` in the Agent
  Monitor's list. It sends just those prompts, in order, or discards them. <!-- XCOD-268 -->
- **Typing in a session a closed Lunos left prompts queued for asks first.** In the session itself
  (terminal, desktop app and web UI), your first prompt asks "Take over this session here?", as the
  Agent Monitor does: send the queued prompts first and then yours, discard them, or cancel and keep
  what you typed. Sessions with nothing queued are sent to as before. <!-- XCOD-267 -->
- **Deleting a session also deletes the prompts queued for it.** Prompts that were queued for a
  session and never sent no longer stay on disk after you delete it, whichever way you delete it.
  The confirmation says how many go with it. Archiving keeps them. <!-- XCOD-269 -->
- **Deleting a single session is now audited.** Deletes from the app, the terminal UI, the API or
  `lunos session delete` are written to the audit log as `session.delete`, with how many queued
  prompts went with them.
  <!-- XCOD-269 -->
- **Claude Code and Codex sessions can use your Lunos MCP servers, skills and memory.** Only if
  you agree: the first time per tool and project, Lunos asks Share, Not now, or Never for this tool.
  Their results are sent to Anthropic or OpenAI with your prompts, so nothing is offered until you
  choose Share. Each call asks in Lunos unless your permission rules allow that tool by name, and
  follows your residency policy and plugin hooks. Every call is written to the audit log. The
  session's header and prompt show what's offered ("Lunos bridge: 2 servers, 3 skills, memory on")
  and warn when the tool didn't connect; `lunos external list` shows the same line. Change your
  answer in `/settings` → External sessions or with `lunos external share`. `external.share.*`
  chooses what's shared, and an organisation can lock it. Your `~/.claude` and `~/.codex` settings
  are never changed.
  <!-- XCOD-254 -->
- **Memory setup explains where your memory is stored, and lets you keep it in PostgreSQL.** The
  "Where should memory be stored?" step shows each option as a card, with a "What this means" panel
  that uses your real memory folder, model and region. The panel says what is stored where, what
  leaves your computer, who it's shared with and what it needs. Press `c` to compare the options
  side by side, or `?` for two questions that recommend one. Your team can now share memory in a
  PostgreSQL database it already runs, as well as Neo4j. "Test connection" writes, reads and
  deletes a probe and tells you which step failed and what to do. A region your residency policy
  doesn't allow is refused right there. Memgraph is shown as coming soon.
  <!-- XCOD-264 -->
- **Memory templates set memory up in one step.** Choose "Just me, on this computer", "Just me,
  fully local" (when you run a local model), "Neo4j in Docker" or "PostgreSQL in Docker" on this
  computer, a team database you host, or a managed cloud database. The Docker templates show every
  file before writing it, never replace an existing file without asking, and keep the generated
  password only in a private `.env` file, never in your config. They bind the database to this
  computer only, and start it only after you confirm the command. Organisations can add their own
  templates and hide built-in ones in managed config. In the CLI: `lunos memory templates`, and
  `lunos memory setup --template <name>`, with `--yes` and `--start`. <!-- XCOD-264 -->
- **Changing where memory is stored asks what happens to your facts.** "Move my facts" copies every
  fact, with where it came from, to the new storage. "Start empty" leaves the old facts where they
  are. <!-- XCOD-264 -->
- **Choose Claude Code's or Codex's model from Lunos.** In a Claude Code or Codex session in the
  terminal app, `/models` lists the tool's own models, and the one you pick is used from your next
  message on, after a resume too; the prompt shows it. `/compact` has the tool compact its own
  session, and `/cost` shows the cost Claude Code reported (Codex reports tokens, so its cost shows
  as "not reported", and its turns no longer show $0.0000). <!-- XCOD-254 -->
- **Your Lunos hooks also guard Claude Code and Codex.** Your plugins' before- and after-tool hooks,
  and the `hooks` in your config, run on the calls Claude Code and Codex make with their own tools.
  They see the calls as they would in Lunos: `bash`, `edit`, with Lunos's argument names. A hook
  that refuses `rm -rf` refuses it in both tools, before you're asked. Hooks run on your computer
  and send nothing to Anthropic or OpenAI, so they work even if you don't share anything. Turn
  them off with `external.share.hooks: false`. Before hooks see the calls the tool asks you about,
  not the ones it allows by itself. <!-- XCOD-254 -->
- A recorder for Claude Code's and Codex's real traffic, run with a dedicated test key in a
  throwaway HOME and redacted before anything is written, plus contract tests that replay the
  recordings against the adapters. They are skipped until the recordings are added.
  <!-- internal --> <!-- XCOD-270 -->
- **Stop every session at once, and clear finished ones out of `/sessions`.** "stop all" stops every
  running or waiting session in the current view (state filter and search), including Claude Code
  and Codex sessions and those running in another Lunos window, after one confirmation that counts
  them; pending approvals are rejected with "Stopped from /sessions" so no tool is left waiting.
  "clear list" archives the finished, idle and failed ones: they're hidden from `/sessions`, the
  session list and quick switch, but nothing is deleted, and "undo" or "show archived" → "unarchive"
  brings them back. "stop all & clear" does both, and "delete archived" removes archived sessions
  for good after you type their count. Both ship without a key (bind `dialog.sessions.stop_all` and
  `dialog.sessions.clear` in `tui.json`); they're always in the view's footer, reachable with Tab.
  From scripts: `lunos session stop --all [--project]`, `lunos session archive --finished
[--older-than 7d]` and `lunos session unarchive <id|--all>`, each with `--yes`. Bulk actions are
  written to the audit log as `session.stop`, `session.archive` and `session.delete`. <!-- XCOD-265 -->
- **The same Stop all and Clear list in the desktop Sessions window and on the web.** The Sessions
  window has Stop all, Clear list and Stop all & clear buttons, with the same counts and the same
  confirmation as `/sessions`; when the sessions in view span several projects, Stop all can be kept
  to one of them. Rows that couldn't be stopped say why. Undo brings back what Clear hid, Show
  archived lists archived sessions with Unarchive on each, and Delete archived asks you to type the
  count first. <!-- XCOD-265 -->

### Changed

- **Your plan is back in the sign-in line, and Lunos Cloud's refusals say what to do.** Signing in
  shows "Signed in as you@example.com · Plan: Free" again. The plan comes from your account, and
  signing in still makes no billing call. `/account` shows Free, Pro, Team or Enterprise, and whose
  plan covers you, and shows Admin as a role alongside Owner and Member. When Lunos Cloud refuses
  something, `lunos org` and `/account` explain it by its code, not its wording. An Admin trying an
  Owner-only action is told that only an owner can, and whom to ask. The only owner of an
  organisation is told which organisations, by name, to hand over first. **`lunos org --json`
  refusals now carry `owner_required` or `admin_required` instead of `forbidden`: scripts matching
  `forbidden` should switch to `code`; `legacyCode` is kept for one release.** The Terms and
  the Privacy notice, with their versions and links, now come from Lunos Cloud instead of being built
  into the app, and the last ones are kept so an offline start still works. **Resend e-mail** on the
  Welcome screen sends the confirmation again and, if you ask too soon, says when to try again.
  <!-- XCOD-275 -->
- **Memory names where it's stored in plain words.** Setup, settings, `lunos memory status`,
  `/memory` and the status line say "On this computer" or "Team database: PostgreSQL". Each of them
  also repeats what leaves your computer. Your config file is unchanged. <!-- XCOD-264 -->
- Merged upstream opencode up to 1.19.3 (`/status` shows `based on opencode 1.19.3`). Lunos keeps
  its own session sharing, update check and install script; upstream's removal of session sharing
  and its OpenCode 1 update pinning are not included. <!-- internal -->
- **Sharing no longer sends sessions to a service that has shut down.** Upstream opencode closed its
  share service (opncd.ai), which Lunos used when nothing else was set. `/share` now uploads only
  to `enterprise.url`; to share with your organisation's Lunos console, set `"share": "cloud"` and
  run `lunos login`. Without either, nothing is uploaded and Lunos says so, in the terminal, the CLI
  and the desktop app; with `"share": "auto"` you see it once per project. `lunos import` refuses
  opncd.ai links with a clear message, and the GitHub action logs it and carries on. Share links
  from your own console or `enterprise.url` import as before. <!-- XCOD-266 -->

### Fixed

- **Claude Code's own commands appear in `/claude` autocomplete again with Claude Code 2.1.292.**
  That release lists them in its answer to Lunos's opening request instead of in its first session
  message, so Lunos found none. Older Claude Code releases still work. <!-- XCOD-270 -->

- **The memory setup check says what went wrong.** A failed check no longer stops at "Memory
  remember failed:" with nothing after it. It names the step that failed (for example extraction or
  the embedding model), why, and what to do: choose another `memory.model` when the model returns
  invalid output, is rate limited or isn't allowed by your residency policy; check the network
  when the embedding model can't be downloaded; free or fix the memory folder on a disk or
  permission error; close the other Lunos when the database is locked. The wizard adds **Details**
  (stage, error type, cause, model and log file) and **Copy diagnostics**, a block for a bug report
  without your facts, keys or tokens. `lunos memory check --json` returns the same fields, the
  engine's output is kept in the memory folder's `logs/`, and `lunos memory status` shows where.
  <!-- XCOD-263 -->
- In a run from source, the memory setup check runs in the opened project, not in the Lunos
  checkout, so its test fact no longer lands in the checkout's memory. <!-- internal --> <!-- XCOD-263 -->
- **Settings and memory setup can save `{env:…}` references** such as `{env:NEO4J_PASSWORD}`.
  Before, saving one failed, so a team database couldn't be set up from the wizard.
  <!-- XCOD-264 -->
- Every published release notifies lunos.tech with the tagged CHANGELOG.md, and a daily check fails
  when lunos.tech/changelog falls behind the latest release. <!-- XCOD-261 --> <!-- internal -->

## [1.18.50] - 2026-10-19

### Added

- **You always see when a prompt goes to Claude Code or Codex.** Their sessions show `▸ Claude Code`
  (or `▸ Codex`) by the prompt and `Lunos · Claude Code` bottom right, and the prompt border, cursor
  and spinner take the tool's accent colour, in the terminal, desktop and web apps. `/sessions` and
  the sidebar mark these sessions with the tool's name. `"external_accent": false` in `tui.json`
  keeps your theme's colours. <!-- XCOD-260 -->

- **Your Lunos commands work in Claude Code and Codex sessions.** The `/` list shows the tool's
  own commands and your Lunos custom commands and MCP prompts, labelled; a Lunos command is
  expanded by Lunos and the text goes to the tool. On a name clash the Lunos one is `/<name>:lunos`.
  Lunos commands that switch a Lunos agent, mode or model are greyed out there instead of being sent
  to the tool as text. <!-- XCOD-254 -->
- **See whether LSP works, and why a language server didn't start.** `/lsp` (and `/settings` →
  Tools → lsp) lists every language server as running, starting, failed with its reason (for example
  "command not found: gopls" or "exited with code 3 before it finished starting"), not started, or
  off, with where it came from and its PID. Enter on one restarts, stops, turns it off or shows its
  log. The sidebar shows a failed server's reason, and `lunos lsp status [--file <path>] [--json]`
  prints the same list. A server that quits while starting now fails at once instead of after the
  start-up timeout. <!-- XCOD-257 --> <!-- highlight -->

- **Press Esc twice to clear the prompt** and start again, in the terminal, desktop and web apps.
  The first Esc shows "esc again to clear"; a second within a second clears it. The undo key brings
  it back right after, and ↑ finds it in history. While the agent is working, Esc still stops it and
  what you've typed stays. Turn it off with `"double_escape_clear": false` in `tui.json`. <!-- XCOD-255 -->

### Changed

- **`/settings` opens on a list of sections instead of one long list.** Each section (Models &
  agents, Permissions, Memory, Tools…) shows what's set and badges for changed, locked and
  restart-needed settings; Enter opens it in its own window, with sub-tabs where it has distinct
  parts (Memory: Overview · Settings · Advanced). Typing on the home still searches every setting
  and Enter lands on it in its section. `/settings memory` or `/settings tools lsp` opens a section
  or sub-tab directly. <!-- XCOD-259 --> <!-- highlight -->
- **`/marketplace` has a real tab bar** (All · Plugins · Skills · Hooks · MCP · Installed) with a
  count on each tab that follows your search. `tab` / `shift+tab` or a click switches tabs, and it
  reopens on the one you used last. Each kind shows what matters for it: a hook's event and the
  command it runs, an MCP server's transport, host, region and whether your residency policy allows
  it. After installing you're back on the same tab and row, and `ctrl+g` picks where plugins go. <!-- XCOD-258 -->
- **Claude Code's permission mode and Codex's sandbox and approval policy are chosen from a list**
  in `/settings` → Models & agents, each with what it does. Manual approval is selected when
  nothing is set, and an empty value now means the default instead of an error. Claude Code's list
  matches what your installed version accepts.
  - **Codex:** `external.codex.sandbox` and `external.codex.approval_policy` replace the single
    `permission_mode`, which still works and is moved the first time either new key is saved.
  - **Unsafe values** (`bypassPermissions`, `danger-full-access`, `never`) are listed greyed out
    and can't be saved to config. One already in a config file is ignored, the safe default is
    used, and `/settings` says so; previously the session failed to start. <!-- XCOD-256 -->
- **What's new and `lunos changelog` show only what you'd notice.** Each change is one line, the
  release's highlights come first, and internal changes are left out; `lunos changelog --full` shows
  everything. <!-- XCOD-253 -->

## [1.18.49] - 2026-10-17

### Added

- **Memory analytics in `/memory`.** It now opens on an Overview and an Activity tab beside the
  fact browser.
  - **Overview:** what's in memory per scope and state, its size against the recall budget, where
    facts came from, and ledger health.
  - **Activity:** growth per week, recalls per day and by origin, hit and token-cap rates, the most
    recalled facts, and facts never recalled. Every count drills down to exactly those facts, which
    can be forgotten together after typing their number.
  - **Privacy:** it's computed locally from the ledger and the audit log (ids and counts, never a
    query or a fact's text). Nothing about memory leaves the machine.
  - **CLI:** `lunos memory stats [--json]` prints the same numbers. <!-- XCOD-252 -->
- **`memory.recall` audit entries for a turn record `truncated` and `chars`:** whether the token cap
  left facts out, and how many characters were injected. <!-- internal -->

- **Set up memory in a few steps.** `/settings` → Memory now starts with **Set up memory…**, which
  walks through turning memory on, where it's kept, the model, the first-start download, retention
  and encryption, then checks that a test fact can be remembered and recalled. Each step
  has a recommended answer, nothing is saved before the summary, and organisation-locked keys are
  shown as fixed. A team Neo4j database whose region the residency policy doesn't allow is refused at
  the step it's entered. Every other memory option is under a collapsed **Advanced**, next to a
  status line. `lunos memory setup` (`--yes` for scripts) does the same on the command line, and
  `lunos memory check` runs the check alone. <!-- XCOD-249 --> <!-- highlight -->

- **`/marketplace` in the TUI.** It opens the marketplace's Discover view straight from the prompt. `/marketplace mcp` (or `plugins`, `skills`, `hooks`) opens that tab,
  `/marketplace playwright` searches every kind at once, and `/marketplace installed` lists what's
  already installed, marking entries the marketplace now serves in a newer version or definition.
  Entries show whether they're installed or verified. `/discover` is an alias. `/plugins` now opens
  the Plugins manager, which points to `/marketplace`. With `LUNOS_OFFLINE=1` the view shows the
  cached catalogue and its date, or says there's no cache yet instead of an empty list. <!-- XCOD-251 -->

- **`/claude` and `/codex` in the TUI.** `/claude <task>` hands a task to your own Claude Code in a
  new session view, and `/codex <task>` to Codex CLI; their approvals come to Lunos's prompt as
  before. On their own they open a picker to start a new session or continue a recent one
  in this project. They're listed only while external sessions are on, and show greyed out with the
  reason when the tool isn't installed or signed in, or is blocked by policy (choosing one then
  explains, and a policy refusal is audited as `external.denied`). A command of your own with the
  same name wins. <!-- XCOD-250 --> <!-- highlight -->

- **"What's new" after an update.** The first start of a new version opens a short panel with what
  changed since the version you had, skipped versions included: behaviour changes and security
  entries first, then what's new and a count of fixes, one line each.
  `/whatsnew` reopens it, and `"whats_new": false` in `tui.json` turns the panel off. `lunos update`
  prints the same summary after a successful install, and `lunos changelog` (`--since <version>`,
  `--full`, `--json`) shows any range. The notes are built into Lunos, so none of this uses the
  network. <!-- XCOD-248 -->

### Changed

- **Updates show their progress.** `lunos update`, the TUI's `/update` and the desktop app show what
  an update is doing while it runs.
  - **`lunos update`:** a spinner with the step (checking, downloading and installing, verifying) and
    the elapsed time. After a minute on one step it says the package manager is still working.
  - **TUI:** `/update` shows the same line in the bottom-right corner, and the prompt stays usable.
  - **Desktop:** the update settings show a progress bar, with the download percentage when the
    updater reports it, and announce each step to screen readers.
  - **Reduced motion:** with `NO_COLOR`, `TERM=dumb` or `reduced_motion` the line is static.
  - **Pipes and CI:** `lunos update` prints plain lines with no escape codes.
  - **Cancelling:** Ctrl+C cancels only while checking. The package manager now runs in its own
    process group and always finishes, so a Ctrl+C or a closed TUI can't leave a half-installed Lunos.
  - **Verifying:** after installing, Lunos checks which version the package manager reports, and
    fails if it's a different one.
  - **Exit code:** a failed `lunos update` now exits with code 1. <!-- XCOD-247 -->

## [1.18.48] - 2026-10-16

### Changed

- **LSP is on by default.** Language servers start as soon as you open a matching file, so the
  agent gets diagnostics after its edits without setting `lsp` first. A server already on your
  machine (in the project's `node_modules/.bin` or on your `PATH`) is used first; otherwise it's
  downloaded the first time a matching file is opened, as before. Set `"lsp": false` to turn LSP
  off, or disable single servers. `OPENCODE_DISABLE_LSP_DOWNLOAD=true` now also stops the
  TypeScript and Biome servers from being installed from npm, so with it only servers you already
  have are used. <!-- XCOD-246 --> <!-- highlight -->

## [1.18.47] - 2026-10-16

### Added

- **Session sync to Lunos Cloud.** Once you sign in with `lunos login`, Lunos copies each
  finished turn of your sessions to your space at app.lunos.tech, in the background; it is on by
  default when signed in and never runs signed out. `.env*`, keys, `auth.json` and anything in
  `sync.exclude` are never uploaded, and a credential scanner redacts common token shapes in the
  rest. Turn it off with `lunos sync off`, `"sync": false` for a directory, or for a whole
  organisation in managed config. With an organisation's own identity provider, nothing syncs
  unless `cloud.endpoint` is set. **If you signed in before this release**, run `lunos sync on`
  (or `lunos login`) to start. See [Session sync](docs/cloud-sync.md). <!-- XCOD-185 -->

- **`lunos cloud git-token set <host>` / `rm <host>`.** Store, replace or remove the git token
  Lunos Cloud clones and pushes with, without curl. The token is read from stdin or a hidden
  prompt, never from an argument, and is never printed back. <!-- XCOD-243 -->

- **The Sessions window sees and controls every Lunos on this machine.** Sessions run by another
  Lunos (a second terminal, the desktop app, `lunos serve`) show their live state within seconds:
  running, or waiting with the number of approvals. You can stop them and answer their approvals
  from any window; the Lunos that runs the session checks and audits the answer as usual. A session
  whose Lunos crashed or was killed shows as "Not responding" within 6 seconds instead of looking
  like it's still running. Claude Code and Codex sessions Lunos started can be stopped from the
  window too, and are named after their tool and folder.
  - **New local listener.** While a Lunos has a running or waiting session, it listens on a random
    port on `127.0.0.1` only, for stop and approval answers from your other Lunos windows. The
    port and a random token are in a file only you can read (`live/` in Lunos's data directory);
    requests from web pages are refused. Nothing is sent off this machine. <!-- XCOD-234 -->
- **Hosted Lunos Team works without MDM.** After `lunos login` with Lunos's own sign-in, Lunos
  looks up your hosted organisation on cloud.lunos.tech and turns on its policy, private
  marketplace, team memory and sharing, with no managed config to push. Only Lunos's built-in
  console is ever used. Managed `cloud.policy` still wins, and an organisation turns this off with
  `"cloud": { "auto_team": false }` in managed config. `/settings` → Status shows where team
  features come from. A hosted organisation's policy can only restrict your Lunos (permissions,
  residency, models, sync, sharing, sandbox, external agents); it can't add plugins, MCP servers,
  commands or agents, or change where your sign-in goes. <!-- XCOD-242 -->

- **See on your Lunos console which Lunos versions run where, and which policy they enforce.** Each
  start bound to your organisation's console tells it the version, OS, architecture, surface, a
  random install id and the policy digest, nothing else; developers can turn it off with
  `"cloud": { "client_start": false }` unless the organisation locks it. When the console can't be
  reached, the TUI and `lunos run` now say which copy of the policy applies and when it was
  fetched, and `LUNOS_OFFLINE=1` uses the last fetched policy without contacting the console. <!-- XCOD-241 -->

- **Update machines without internet access from a mirror you control.** `lunos update` already
  reads the npm registry from your npm configuration, so a private registry (Nexus, Artifactory,
  Verdaccio) is all it needs; for archive and offline-bundle installs,
  `script/release-mirror.ts` copies chosen releases into a directory you serve, keeping only files
  that match the release's signed `SHA256SUMS`. `docs/lts.md` proposes a long-term support line
  with backported security fixes; it is planned, not yet available. <!-- XCOD-193 -->
- **Work as a team on your organisation's Lunos console.** With the Team plan or a self-hosted
  console: your organisation's private marketplace is listed first and installs with the usual
  commands; `lunos memory share <id>` offers one fact at a time to team memory, which an admin
  approves and members recall through an `org` memory source; `lunos share <session>` (or
  `--artifact <file>`, `--link <hours>`) shares with your organisation, or with a signed link that
  expires. Your own memory never leaves your machine. Sharing stays off by default: `"share":
"cloud"` allows only these uploads, never another share service, and each one is checked against
  the residency policy and audited. <!-- XCOD-191 -->
- **Share with your organisation from the TUI, and take shares back.** With `"share": "cloud"`,
  `/share` uploads the session you're in to your organisation's Lunos console (whole or redacted,
  optionally with a link) and shows its URL, link and expiry. `lunos share list` shows your shares
  with their link expiry and `lunos share revoke <id>` revokes one and its links. Before every
  upload Lunos checks the region the console declares against your residency policy and refuses
  (and audits) one it doesn't allow; `--link` alone means 30 days; `lunos memory share` previews
  exactly what it would send. <!-- XCOD-191 -->
- **Edit the Recommended models in /settings.** Recommended opens a list of its models with why
  each is recommended (Lunos's curated list, marked "Lunos default", until you change it). Add a
  model from the picker with an optional reason, edit or remove one, or reset to Lunos's defaults;
  the model picker's Recommended filter shows the change at once. The model must be available here,
  an organisation lock refuses every change, and comments in the file are kept. A model listed
  without a reason now still counts as recommended. <!-- XCOD-229 -->
- **Choose the default agent from a list.** In /settings, Default agent lists your main agents with
  what they do, offers "New agent…" (set one up and make it the default) and "Clear (use Lunos's
  default)"; the next new session starts with it. A default that names a subagent, hidden or
  turned-off agent is flagged, and `lunos settings set default_agent <name>` refuses one that isn't
  a main agent and lists the valid names. <!-- XCOD-230 -->
- **Pick a subagent's or agent's reasoning variant from a list.** In /settings, Variant shows Inherit
  and the variants of the model it applies to (the same names as the session's variant switcher),
  or says the model has none; Clear removes it. A saved variant that model doesn't have is marked
  "not available for <model>" and requests fall back to the model's default.
  `lunos settings set subagent.variant <name>` (and `agent.<name>.variant`) refuses an unknown
  variant and lists the valid ones. <!-- XCOD-232 -->
- **A Subagent screen in /settings.** Enter on Subagent lists its settings with proper controls:
  run in background, the model picker (with "Inherit from main agent" and "Small model"), variant,
  "Let the main agent choose a model per task" and the allowed-models list. Every other setting made
  of simple fields (Compaction, Sandbox, Memory, Audit, Server…) gets the same screen instead of
  opening the config file, and a nested field's badge now names the file it comes from. <!-- XCOD-231 -->
- **Claude Code and Codex in their own session in the TUI.** `/external claude` (or the command
  palette) opens a session labelled "Claude Code" with its session id. You send it prompts and its
  own `/commands`, answer its approvals in Lunos's approval prompt, and see the cost it reports for
  each turn and in total. Find it in `/sessions` after a restart, or continue one by id with
  `/external resume claude <id>`. Press esc twice to stop it. Codex CLI works the same way. Under an
  EU-only residency policy it isn't started; the reason is shown and the refusal is audited
  (`external.denied`). <!-- XCOD-218 --> <!-- highlight -->
- **See and organise all your sessions in one place.** The desktop app's `Window → Sessions`
  (Cmd+Option+S / Ctrl+Alt+S) opens a separate window, and the web UI has a `/sessions` page,
  listing every session on this machine across projects: state (running, waiting for approval,
  idle, finished, failed), project, agent, model, last activity and cost, updating live. Put
  sessions in your own groups (create, rename, colour, collapse, delete; deleting a group never
  touches its sessions), move them by drag-and-drop or "Move to group", search and filter, and
  open, rename, stop or answer a waiting session from the list. Subagents sit under their parent;
  scheduled runs and external sessions are labelled. In the TUI, `/sessions` opens the same view,
  keyboard-only: Enter opens a session (or collapses a group), with keys to move it to a group,
  rename, stop, create or delete groups and filter by state; this project's session switcher stays
  on `ctrl+x l`, `/resume` and `/continue`. Groups are stored on this machine only and changes made
  in any of them show up in the others straight away. <!-- XCOD-205 --> <!-- highlight -->
- **A locked model is the one actually used.** When your organisation locks `model` in managed
  config, every other model shows as **locked by your organisation** in the TUI, desktop and web
  pickers and can't be chosen; `lunos run --model` with another model is refused with the policy
  message and audited as `policy.override_refused`. `agent.<name>.model` and `subagent.model` locks
  pin subagents the same way. <!-- XCOD-219 -->
- **Your organisation's policy follows you from its Lunos console.** Set `cloud.policy` in managed
  config to the console's policy URL, and every start while signed in (`lunos login`) fetches it
  within 3 seconds and enforces its `$locked` keys exactly like `managed.json`, refusals audited as
  `policy.override_refused`. Offline or signed out, the last fetched copy applies; an edited copy
  can't loosen it while the console is reachable. Each start is audited as `client.start` with the
  version, OS, architecture and the digest and source of the policy in effect. The hidden
  `lunos console` command group, which signed in to upstream's hosted console, is gone. <!-- XCOD-238 -->

### Changed

- **Mistral counts as EU only at its EU endpoint.** Mistral's default endpoint, `api.mistral.ai`,
  is global, with no committed inference location, so an EU-only data-residency policy now
  refuses it; before, Lunos counted it as EU. To use Mistral under an EU-only policy, set
  `"provider": { "mistral": { "options": { "baseURL": "https://api.eu.mistral.ai/v1" } } }`
  (Mistral charges 1.1× list price there). Without a residency policy nothing changes. <!-- XCOD-194 -->
- **/settings keys work the same on every screen.** Esc closes the whole settings window from any
  depth without saving what you were typing; ← goes back one level to the row you came from (in a
  text field, from the start of the field). Every screen shows `← back · esc close`. <!-- XCOD-233 -->
- **Every release has its changelog entry.** A release now stops before anything is built or a
  draft release is created when this file has no section for the version being released, and a
  pull request that changes Lunos's code without a line here gets a warning (label `no-changelog`
  to skip it). v1.18.46 shipped without one; its section is now below. <!-- XCOD-227 --> <!-- internal -->
- Merged upstream opencode up to 1.19.0 (`/status` shows `based on opencode 1.19.0`). Lunos keeps
  its own update check and `/update`; upstream's new update dialog and `upgrade --major` (a switch
  to OpenCode 2) are not included. <!-- internal -->

### Fixed

- **Desktop Sessions window.** Opening a session from it now opens it in the main window; costs
  under a cent show instead of $0.00; its warning text meets contrast in the light theme. <!-- XCOD-235 -->

- **Cloud runs report how they really ended.** `lunos run --cloud --cloud-secret NAME "message"`
  works with the flag before the message (repeat it, or write `A,B`); the message was taken as a
  secret name. A cloud or `--attach` run whose session ends in an error, such as a residency
  refusal on the worker, now exits non-zero and says `failed`. `--model` on a cloud run stops with
  a clear message when the worker can't run that model, instead of quietly using another one. Ctrl+C
  prints the results line without a stack trace. <!-- XCOD-236 -->
- **Cloud runs say why billing stopped them.** When Lunos Cloud refuses a run (no plan, a failed
  payment, Team seats full, the spending cap), you see its own reason, no longer always "spending
  cap reached". When it stops a run part-way (cap reached, subscription suspended), `lunos run
--cloud` prints the reason and exits non-zero; the worker is still ended and its results pushed. <!-- XCOD-237 -->
- **macOS binaries carry a valid signature.** The `lunos-darwin-*` binaries on npm and in the
  release archives failed `codesign --verify` because the release built them on Linux. They are
  now re-signed ad-hoc on a Mac before they are packed, checksummed and published. They are still
  not signed with an Apple Developer ID or notarised. <!-- XCOD-207 -->

## [1.18.46] - 2026-10-09

### Added

- **Claude Code and Codex CLI from Lunos.** If you also use either tool, `lunos external run`,
  `resume`, `sessions` and `stop` start and continue their sessions, with your own install and
  login: Lunos never stores, copies or proxies your Anthropic or OpenAI credentials. Each approval
  the tool asks for comes to you, and each session's reported cost (Claude Code) or tokens (Codex)
  is shown. Codex's `/review` and `/compact` work; its other commands are refused with the list of
  what does. With `"external": { "delegate": true }` a Lunos agent can hand a task to either tool
  through the `external_agent` tool, approved through Lunos's own permission prompts. A residency
  policy that doesn't allow the vendor's region refuses to start them, every session is in the
  audit log, and an organisation can turn the feature off. See
  [Claude Code and Codex CLI from Lunos](docs/external-agents.md). <!-- XCOD-204 --> <!-- highlight -->
- **Models your residency policy blocks are tagged "blocked by policy"** in the TUI, desktop and
  web model pickers, with their providers listed last, and can't be chosen: picking one shows the policy's reason.
  `lunos models` marks them too, and saving a blocked model as `model`, `small_model`,
  `subagent.model` or a `subagent.dynamic` entry is refused. <!-- XCOD-212 -->
- **Recommended and size filters in the model picker.** All, Recommended, Large and Small (`ctrl+l`
  cycles them in the TUI; buttons in desktop and web), remembered across restarts, and
  `lunos models --recommended` / `--size`. Recommended is a curated list of EU-hosted and local
  models, each with a one-line reason; it is not a benchmark. An organisation can replace it with
  the lockable `recommended` key. See [Choosing a model](docs/models.md). <!-- XCOD-213 -->
- **`/settings` → Agents.** In the TUI (`/agents` opens it too), desktop and web: every agent
  grouped as main, subagent or helper, and for each one its model, on/off, steps, temperature and
  the rest, with Reset, New agent and a migration for deprecated keys. Each change is checked like
  any other setting, including organisation locks. `lunos settings unset` removes a value. See
  [Agents](docs/agents.md). <!-- XCOD-215 -->
- **Pick a subagent's model from the model picker.** In `/settings`, "Subagent model" opens the
  same picker as the main agent's model, with "Inherit from main agent" and "Small model" first.
  "Subagent dynamic allow" lists its models: add one from the picker or by ID, and enter removes
  one. A model setting saved from `/settings` or `lunos settings set` must name a model available
  here; otherwise nothing is written and the closest matches are suggested. <!-- XCOD-214 -->
- **Edit agents.** `lunos agent edit <name>` changes an agent's prompt, model, permissions, the
  skills it may load, the MCP servers it may use, and its step limit, from flags or in `$EDITOR`.
  In the TUI, `/agents` lists every agent and opens one in `$EDITOR` (`/agents` used to be an alias
  of `/modes`). Each save is checked against the models, tools, skills and MCP servers available
  here, and nothing is written if anything is wrong. See
  [Editing and sharing agents](docs/sharing-agents.md). <!-- XCOD-210 XCOD-203 -->
- **Run agents unattended, now or on a schedule.** `lunos agent run <name> --prompt …` runs an
  agent with hard limits on time, spend and steps (subagents included), in the Docker sandbox by
  default. A run that reaches a limit stops there and counts as a success: what the agent did so
  far comes back as the sandbox's results branch. Nobody approves anything: every permission prompt is refused and reported, and the agent
  is told why. `--schedule "<cron>"` installs a launchd, systemd or Task Scheduler job;
  `lunos agent schedule list|remove` manages them. Each run writes a report and an `agent.run`
  audit event, and `--notify` can POST the outcome to a webhook. See
  [Running agents unattended](docs/unattended-agents.md). <!-- XCOD-211 XCOD-203 --> <!-- highlight -->

- **Share an agent as one file.** `lunos agent export <name>` writes the agent, the MCP servers it
  uses and the skills it names into a `.lunos-agent` bundle, with MCP environment variables and
  headers by name only, never by value. `lunos agent import <file|url>` shows what the agent may
  do, what it adds and where its model runs before writing anything. Imported agents ask before
  bash, edits and subagents unless you pass `--trust`, and Claude Code subagent files import with
  a report of the fields that didn't carry over. An organisation can turn imports off with a
  locked `agent_import: false`. See [Editing and sharing agents](docs/sharing-agents.md). <!-- XCOD-209 XCOD-203 -->
- **An EU-only policy can forward the audit log off the machine.** `audit.forward.region` (`eu`,
  `us` or `other`) declares where your forwarding destination processes data, and it is checked
  against `residency.allow`. Before, any destination other than loopback counted as `unknown`, so
  forwarding under `"allow": ["eu"]` meant also allowing model providers in unknown regions. With
  no region declared, forwarding is refused as before. See [Audit log](docs/audit-log.md). <!-- XCOD-201 -->
- **An organisation can lock permissions.** `permission`, or one tool's `permission.<tool>`, can now
  go in `$locked`. The managed rule then wins over any later `"*": "allow"`, an agent's own
  permissions, `OPENCODE_PERMISSION` and project config; a config that sets a locked permission
  differently is refused and the refusal is audited. A lock never loosens a deny: a locked "allow"
  doesn't lift an agent's or the project's "deny". Where the locked rule is "ask", your "always
  allow" answers and `--auto` still work; a locked "deny" wins over both. "Always allow" lasts for
  that project until Lunos restarts, as before. <!-- XCOD-202 -->
- **Groundwork for Lunos Cloud, which isn't live yet.** There is no Lunos-hosted service, and
  nothing in Lunos needs an account. `lunos login`, `whoami` and `logout` sign in with the OAuth
  device flow to an OpenID Connect provider you name with `cloud.issuer`, such as your
  organisation's Keycloak, Zitadel or Authentik; a Keycloak setup is in `deploy/identity/keycloak/`.
  `lunos run --cloud` is the client side of cloud workers; `cloud.endpoint` has no default, so until
  a control plane exists `--cloud` says so and stops. See [Signing in](docs/cloud-login.md) and
  [Cloud workers](docs/cloud-workers.md). <!-- XCOD-185 XCOD-186 --> <!-- internal -->

### Changed

- **An unknown model is a warning, not an error.** A model named in config (`model`, an agent's
  or subagent's model) or with `--model` that isn't available here no longer fails the prompt: the
  closest model of the same provider is used, or else your default one, and a warning says which
  (a toast in the TUI, a line on stderr for `lunos run`). An unavailable `small_model` is logged. <!-- XCOD-214 -->
- **Stricter front-matter parsing.** Agent, mode and command files must use YAML (or JSON) front
  matter; a file using any other front-matter language is now refused with an error naming the
  file, and skipped. <!-- XCOD-208 -->
- Merged upstream opencode up to 1.18.34 (`/status` shows `based on opencode 1.18.34`). <!-- internal -->

### Security

- **No keyless fallback to upstream opencode's hosted free tier.** Up to v1.18.44, with no provider
  key set, a first `lunos run` could send your prompt to opencode.ai, a non-EU third party, which
  then refused it. The `opencode` provider now loads only when you've given it a key. <!-- XCOD-221 -->

### Fixed

- **With no provider set up, Lunos says what to do.** `lunos run` printed
  `Unexpected server error`; it now says to run `lunos auth login` or set a provider API key. <!-- XCOD-221 -->
- **Ctrl+C stops a sandboxed run at once.** The agent inside the sandbox used to keep working, and
  spending, for about 10 seconds after an interrupt, until the container was killed. It now stops
  within a second, and the run exits with 130. <!-- XCOD-211 -->
- **`/settings` no longer runs away when scrolled with the mouse wheel or trackpad.** Scrolling
  there could make the list jump up and down without stopping. The wheel now does nothing in
  `/settings`; use the arrow keys, page keys or the filter. Other lists are unchanged. <!-- XCOD-206 -->

## [1.18.44] - 2026-10-05

### Fixed

- **A failed update says why.** When `lunos update` or the TUI's update dialog fails, it now names
  the package manager's error code (e.g. `EBUSY`, `EACCES`, `ERR_PNPM_…`) and the path of npm's
  debug log, instead of only the exit code. Nothing else from the package manager's output is
  shown, since it can contain registry tokens. <!-- XCOD-171 --> <!-- highlight -->
- **Licence notices cover Bun's LGPL libraries in full.** `THIRD_PARTY_NOTICES` and
  `lunos licenses` now include the LGPL-2.0 and LGPL-2.1 texts, the exact WebKit and tinycc commits
  that Bun 1.3.14 statically links, and how to relink with a modified copy. The desktop app's
  notices now include Bun's licence and this section too, since it ships the `lunos` binary. <!-- XCOD-177 --> <!-- internal -->

## [1.18.43] - 2026-10-04

### Added

- **`/restart`** stops Lunos and starts it again, back in the same session with your unsent prompt
  kept; `/restart --fresh` starts a new session. It stops MCP servers, LSP servers, the memory
  sidecar and the local server first, and relaunches with the same arguments, directory and
  environment. After `/update` it runs the newly installed version (the banner shows old → new), and
  the "Update Complete" alert now says `Run /restart to use X.Y.Z.` instead of closing Lunos. If the
  agent is mid-turn or background jobs are running it asks first (wait, stop and restart, or
  cancel). In `lunos attach` only the client restarts. A relaunch that fails to start prints the
  error and the command to run by hand, and is never retried. Also in the palette as **Restart
  Lunos**, with an unbound `app_restart` keybind. <!-- XCOD-129 -->
- **`lunos memory export` writes a full, versioned bundle** (`lunos-memory/1`): facts with provenance,
  the entity graph tied to the facts it came from, hand-written notes, and a manifest with a SHA-256
  per file, documented by a JSON Schema in the bundle's `SCHEMA.md`. `--zip`, `--encrypt`
  (OpenSSL-compatible), `--scope`, `--since` and `--include-index`; also `ctrl+s` in the TUI memory
  browser. `--format markdown` keeps the old one-file-per-fact export. <!-- XCOD-132 -->
- **`lunos memory import`** brings memory in from a Lunos bundle (folder, `.zip` or `.zip.enc`),
  Markdown, or `AGENTS.md` / `CLAUDE.md` / Claude Code auto-memory notes. Imported memory is treated
  as untrusted. Bundles are checksum-verified, every fact passes the write guard, and duplicates and
  conflicts are found. A preview of new / duplicate / conflict / rejected rows comes first, and
  nothing is written without `--yes` or approval in the TUI (`ctrl+o` in the memory browser).
  Imported facts keep their original provenance as `origin` and are labelled "imported" when
  recalled. The audit log records each import without its text. <!-- XCOD-133 -->
- **External memory sources** (`memory.sources`): recall from a Neo4j knowledge graph or an MCP
  memory server with a search tool (verified with the reference `@modelcontextprotocol/server-memory`)
  alongside Lunos's own memory. Sources are read-only and untrusted: each needs a `jurisdiction` the residency policy
  allows before it is first contacted; results are screened like imports, cut to the source's
  `max_tokens`, shown in a labelled `<memory-source>` section, and never stored locally. A slow or
  failing source is skipped after `timeout_ms` (2 s) with a notice. `/memory sources` lists them and
  turns one off for the session. A source's fact is kept only through `memory_remember` with the
  source as provenance. New audit events `memory.source_query` and `memory.source_denied`. <!-- XCOD-135 -->

- **Sandboxed runs**. `lunos run --sandbox` and `lunos --sandbox` run
  the Lunos server, and everything it starts, in a container; only the client stays on your
  machine. Docker or Podman (`sandbox.runtime`). The repository plus your uncommitted changes is
  copied into a volume; your working tree is never mounted. The container runs as a non-root user
  with every capability dropped, a read-only root filesystem, no host mounts and no Docker socket.
  - **Results** (`sandbox.results`): a branch `lunos/sandbox/<id>` (default), a patch in
    `.opencode/sandbox/<id>/changes.patch`, or none; the transcript and summary always come back.
    `sandbox.on_finish` destroys or keeps the container, only after the hand-back succeeded.
  - **Your global and organisation config apply inside the sandbox**, and provider keys reach it at
    run time through a private tmpfs, never in the image or the container's environment.
  - **`sandbox.required`** (organisation policy) refuses tools that would run outside a sandbox,
    and **`sandbox.network`** limits what the sandbox can reach: `policy` (default) allows only the
    model endpoints your residency policy permits, remote MCP servers, the npm registry and
    `sandbox.allow`, through an egress proxy outside the container; `none` allows nothing; `open`
    allows everything.
  - **`sandbox.workspace: "mount"`** works on your tree directly, with reduced isolation and a
    warning; `.git` and Lunos's config stay read-only. **`sandbox.mounts`** adds read-only
    directories.
  - **The project's devcontainer** supplies the toolchain when its `image` is set; building its
    Dockerfile needs `"sandbox": { "devcontainer": "build" }` in your global or managed config.
  - **`/sandbox`** and **`/sandbox end`** move a TUI session into a sandbox and back (behind
    `OPENCODE_EXPERIMENTAL_WORKSPACES`). The session header shows the sandbox and its image digest,
    `/settings` lists every `sandbox.*` key, and the Status tab lists the project's sandboxes.
  - A repository's own config can't choose the settings that weaken isolation (`allow`, `mounts`,
    `workspace: "mount"`, `devcontainer: "build"`, `network: "open"`). <!-- XCOD-144 XCOD-157 XCOD-158 --> <!-- highlight -->
- **Memory lifecycle**: a fact can be marked outdated (`lunos memory outdate`, `ctrl+u` in
  the memory browser, or `memory_remember` with `replaces`); it stays in the ledger but is no longer
  recalled, and `search --history` still finds it. A contradicting fact asks whether to replace or
  keep both. Facts can expire (`memory.retention.days`, or `expires` per fact), the ledger is
  integrity-checked, can be encrypted at rest, and every memory operation is in the audit log. <!-- XCOD-136 -->
- **Memory in an external Neo4j database**, so a team shares one ledger: one node per
  fact with its provenance and a checksum, full-text recall, and project and user scopes kept apart.
  `memory.backend.jurisdiction` is checked against your residency policy before Lunos connects, and
  `lunos memory migrate` moves embedded memory across. <!-- XCOD-134 -->
- **Third-party licence notices**. Every npm package, release archive and offline bundle
  carries `LICENSE` and `THIRD_PARTY_NOTICES`, generated at build time from what ships, including
  the Bun runtime's licence. `lunos licenses [--output <file>]` prints them, offline. The desktop
  app has **Help → Third-Party Licences**, and the VS Code extension includes both files. The build
  fails on a copyleft or undeclared licence that isn't on a reviewed allowlist. <!-- XCOD-177 --> <!-- internal -->
- **Lunos JSON Schemas**. `https://lunos.tech/config.json`, `tui.json`, `theme.json` and
  `desktop-theme.json`, generated from the source and covering Lunos's own keys (`sandbox`,
  `residency`, `memory`, `audit`, `hooks`). The `$schema` Lunos writes now points there. <!-- XCOD-174 -->
- **The GitHub agent works with your own token**. `lunos github install` writes
  `.github/workflows/lunos.yml`, which runs `AxsionDev/Lunos/github` with the repository's
  `GITHUB_TOKEN` (or a fine-grained personal access token); there is no GitHub App to install and
  no token-exchange service. Triggered by `/lunos` or `/oc`. Setup and permissions:
  [docs.lunos.tech/docs/github](https://docs.lunos.tech/docs/github/). <!-- XCOD-174 -->
- **Unknown tools name the nearest real ones**: when a model calls a tool that doesn't
  exist, the error lists the closest names. `"permission": { "<server>_*": "deny" }` keeps an MCP
  server's tools out of a project or agent entirely (`docs/mcp-tools.md`). <!-- XCOD-167 -->
- **Accessibility checks for the desktop and web app**: automated axe-core checks in CI
  on 9 screens in light and dark, with the serious and critical findings fixed; the TUI shows status
  with glyphs as well as colour. <!-- XCOD-141 --> <!-- internal -->

### Security

- **Affected by a keyless fallback to upstream opencode.** With no model provider set up,
  `lunos run` still sent its first prompt to upstream opencode's hosted free tier, which refused
  it. Fixed in v1.18.46; upgrade. <!-- XCOD-221 -->

- **No request to upstream opencode's services on any default path, once a model provider is set up**. There is no
  OpenCode Console sign-in (`lunos account login` needs a URL you run) and no shared free-tier key
  for the `opencode` provider. The model catalogue comes from models.dev. A build without the
  embedded web UI says so instead of loading upstream's hosted one, and the local server no longer
  trusts upstream's web origins. Docs links, the system prompts and request headers point at
  Lunos. A CI test fails on a new upstream address, and the offline-egress check proves a normal run
  and a `lunos github` run make no connection to it. <!-- XCOD-174 -->
- **Secrets with quotes load correctly, and a config parse error never prints them**.
  An `{env:}` or `{file:}` value containing `"`, `\` or a newline made the config invalid, and the
  error printed the whole substituted config, secret included. <!-- XCOD-151 -->
- **Memory now refuses instruction-shaped text** ("ignore all previous instructions", chat role
  markers, tool-call syntax), for the agent's `memory_remember` as well as imports. <!-- XCOD-133 -->

- **`/settings`: every configuration option in one place,** after Claude Code's `/config`. One
  dialog with **Status | Settings | Usage** tabs; `/config` is an alias, `/status` opens the Status
  tab and `lunos settings` starts the TUI on it. Settings lists every option, generated from the
  config schema, by category, with its value and a source badge (default, user, project, env,
  managed 🔒); typing filters, and Enter or Space change a value by its type (toggle, pick list,
  the model and theme pickers, an inline prompt, the MCP/providers dialogs, or `$EDITOR` for
  structured settings). Changes are validated against the schema, go to the user config (Ctrl+S
  switches to the project's `.opencode/opencode.json`) with comments kept, are refused for keys
  locked by organisation policy, and offer `/restart` when they need one. `/settings key=value`
  changes one value from the prompt, and `lunos settings list [--json] | get <key> | set <key>
<value> [--project]` does the same for scripts. <!-- XCOD-128 --> <!-- highlight -->

### Changed

- **The default agent asks before commands that publish or reach outside the project**:
  `git push`, `git remote add`/`set-url`, `git config --global`/`--system`, `gh repo create`/`delete`,
  `gh pr create`/`merge`, `gh release create`, `npm`/`pnpm`/`yarn`/`bun publish`, `cargo publish`,
  `twine upload` and `docker push`. In the TUI you're asked; `lunos run` can't ask, so it refuses
  them. Before, they ran unasked: one run committed, rewrote the global git config, added a remote
  and tried `git push` and `gh repo create --public`. Allow them again in your config, e.g.
  `"permission": { "bash": { "git push *": "allow" } }`, or `"bash": "allow"` for everything. <!-- XCOD-164 -->

- **`/connect` is now `/providers`,** the same word as the `lunos providers` CLI command. It opens
  on your configured providers, each with its status (connected, expired or error), auth method and
  jurisdiction, with **Add provider** (the old connect flow), **Log out** and **Set as default for
  model picker**. `/connect` remains a hidden alias that shows "/connect is now /providers", and the
  `provider_connect` keybind still works as an alias of the new `provider_list`; both aliases will
  be removed in 1.21.0, after the next two minor releases. <!-- XCOD-130 -->
- **`lunos update` is now the name of the update command,** and `/update` in the TUI. `lunos upgrade`
  and `/upgrade` remain working aliases, so no script breaks. When you're already current it prints
  `Lunos is up to date (X.Y.Z).` and exits 0. Lunos now checks the npm registry on every start (in
  the background, never delaying startup, 3 s timeout, falling back to the last known result)
  instead of once a day, and the TUI shows `There is a new version: X.Y.Z — please run lunos update`
  in the bottom-right corner of every screen, home and session alike, until you update (`New
version: X.Y.Z · lunos update` below 100 columns). This replaces the home-screen footer's `·
update available (/upgrade)`. Plain commands print `There is a new version: X.Y.Z — please run
"lunos update"` to stderr at most once a day. Nothing is checked or shown with `"autoupdate":
false`, `LUNOS_DISABLE_AUTOUPDATE=1`, `LUNOS_OFFLINE=1` or a policy-locked `autoupdate: false`. <!-- XCOD-147 -->

### Fixed

- Loading config no longer writes `$schema` into the project's `opencode.json`, a tracked file. <!-- XCOD-165 -->
- The built-in configuration skill is `customize-lunos` and points at `lunos settings`, not at
  upstream's schema or commands. <!-- XCOD-168 -->
- An unknown model says `Model not found: …` with suggestions, not `Unexpected server error`. <!-- XCOD-166 -->
- `/tasks` no longer cuts a background job's model off; it moved to the row's footer. <!-- XCOD-161 -->
- `lunos stats` totals no longer round to `$0.00` beside non-zero model costs. <!-- XCOD-169 -->
- `lunos run --format json` writes at most one error record. <!-- XCOD-148 -->
- Windows: a path with no drive letter resolves against the project, not the process's drive, and
  permission rules written with 8.3 short names (`C:\PROGRA~1\…`) match long-form paths. <!-- XCOD-137 XCOD-149 -->
- A legacy keybind name in `tui.json` (such as `agent_list`, renamed in an earlier release) was silently
  dropped when the config loaded, instead of resolving to its new name. <!-- XCOD-40 XCOD-130 -->

## [1.18.42] - 2026-09-29

### Added

- **Offline install bundles,** one `lunos-offline-<os>-<arch>.tar.gz` per platform, for installing
  Lunos on a machine with no internet access. Each contains the CLI, the model catalogue, the SBOM,
  the signed `SHA256SUMS`, Sigstore's trust root, and pinned ripgrep and cosign builds. Verify a
  bundle with `SHA256SUMS-offline` and its signature before you transfer it. `INSTALL-OFFLINE.md`
  inside the bundle has the steps, and [Air-gapped deployment](docs/deployment/self-hosted.md#air-gapped-deployment)
  covers running against your own model. <!-- XCOD-121 --> <!-- highlight -->

### Fixed

- The offline install bundles missing from v1.18.41 ship with this release: the release job no
  longer hangs while building them. <!-- XCOD-121 -->

## [1.18.41] - 2026-09-29

### Security

- **A residency policy now checks the endpoint, not just the provider ID.** Up to v1.18.40, pointing
  an EU-tagged provider (such as `mistral`) at another host with `baseURL` still passed
  `"allow": ["eu"]`. Built-in EU claims now hold only for the provider's own API hosts; any other
  endpoint is `unknown` and an EU-only policy refuses it. <!-- XCOD-138 -->

### Added

- **`residency.endpoints`** declares the region of an endpoint Lunos can't assess itself, such as a
  self-hosted vLLM or Ollama server or a company proxy. Declared calls are allowed and recorded in the
  audit log with basis `declared`. <!-- XCOD-121 XCOD-138 -->
- **Offline mode:** `LUNOS_OFFLINE=1` turns off every outbound call Lunos makes on its own behalf;
  `lunos --version --verbose` reports it, with the upstream base and lag. <!-- XCOD-121 XCOD-118 --> <!-- highlight -->
- **Air-gapped deployment** guide, with an Ollama/vLLM recipe tested on an isolated network. <!-- XCOD-121 -->
- **Desktop app** ships again, as Lunos (`lunos-desktop-*`, `tech.lunos.desktop`), updating only
  from Lunos releases. <!-- XCOD-123 --> <!-- highlight -->
- **VS Code extension** "Lunos" (publisher `axsion`) on Open VSX and the VS Code Marketplace. <!-- XCOD-122 -->
- Weekly upstream merges, with a published "days behind upstream" metric. <!-- XCOD-118 --> <!-- internal -->

### Fixed

- The CLI no longer tells you to run `opencode …` in hints, errors or `--help`. <!-- XCOD-127 -->
- `lunos uninstall` no longer removes upstream opencode's package or PATH line.

### Known issues

- **The offline install bundles weren't attached to this release.** The release job hung building them. They follow in
  the next release. <!-- XCOD-121 -->

## [1.18.40] - 2026-09-26

### Security

- **Affected: the desktop app once attached to this release.** It installed as "OpenCode" and
  updated itself to upstream opencode, without Lunos's residency enforcement or audit log. The
  CLI is not affected. Its files have been removed; if you installed it, uninstall it. From
  v1.18.41 the desktop app ships as Lunos and updates only from Lunos releases.

- **Affected by a residency check on the provider ID only.** A residency policy judged a provider
  by its ID only, so an EU-tagged provider pointed at another host with `baseURL` still passed an
  EU-only policy. Fixed in v1.18.41; upgrade. <!-- XCOD-138 -->

### Changed

- **The built-in marketplace matches what lunos.tech publishes.** `marketplace.json` v1.2.0 adds a
  category to every plugin and lists the MCP servers lunos.tech shows: filesystem, git, fetch,
  playwright, github, postgres (`postgres-mcp`) and searxng, in place of memory,
  sequential-thinking, time, everything and context7. lunos.tech now publishes this file at a
  pinned commit instead of keeping its own copy. <!-- XCOD-95 --> <!-- highlight -->
- **npm installs need `--allow-scripts=lunos-ai`.** The install instructions add it: npm 12 no longer runs install scripts by
  default, so without it `lunos` fails to start after an npm install.
- The data-residency docs record that sessions enforce the policy from v1.18.39. <!-- internal -->

### Fixed

- The v1 plugin loader logs v2 plugin files at DEBUG instead of reporting them as errors. <!-- XCOD-96 -->

## [1.18.39] - 2026-09-25

### Security

- **Affected: the desktop app once attached to this release.** It installed as "OpenCode" and
  updated itself to upstream opencode, without Lunos's residency enforcement or audit log. The
  CLI is not affected. Its files have been removed; if you installed it, uninstall it. From
  v1.18.41 the desktop app ships as Lunos and updates only from Lunos releases.

- **Affected by a residency check on the provider ID only.** A residency policy judged a provider
  by its ID only, so an EU-tagged provider pointed at another host with `baseURL` still passed an
  EU-only policy. Fixed in v1.18.41; upgrade. <!-- XCOD-138 -->

### Added

- **`/artifacts`** (alias `/plans`) lists this project's plans, research notes and dev-cycle records,
  newest first, and opens the file itself in `$EDITOR`. Without an editor it copies the path instead.
  `GET /experimental/artifact` serves the same list to the app. The deployment guide now names
  export and committed artifacts as the supported way to share inside your perimeter.
- **Background subagents are a documented, opt-in setting:** `"subagent": { "background": true }`
  (the old `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` still works). `/tasks` in the TUI lists every
  background job with its agent, model, status and elapsed time; Enter opens it and `ctrl+d` cancels
  it. `GET /experimental/background` and `POST /experimental/background/{id}/cancel` expose the
  same list to the app and ACP. What happens on abort, delete, compaction and exit is written down
  in `specs/background-subagents.md`.
- **Choose which model each subagent uses.** `agent.<type>.model` now accepts `"inherit"` and
  `"small"` as well as `provider/model`. The new `subagent.model` sets a default for every
  subagent, and `subagent.dynamic` lets the main agent pick a model per task, from a list you allow.
  Subagent models are checked against the residency policy before they start. An inherited model
  keeps the main agent's reasoning variant; before this, the variant was dropped whenever a model
  was configured.
- **Skills can restrict the agent's tools** with `allowed-tools` in `SKILL.md`, in Claude Code's
  format. The restriction applies from when the skill loads to the end of the turn, through the
  permission system. Hook scripts now receive `LUNOS_AGENT` and `LUNOS_SKILL`. `research-mode`
  uses this instead of its lock file and guard hook.
- **Claude Code subagents work:** `.claude/agents/*.md` is discovered (project and home), and
  `tools: Read, Grep, Glob` allow-lists and model aliases like `sonnet` are translated. Before
  this, one such file made the whole config invalid.
- **Marketplace install commands copied from lunos.tech work on a fresh install.** `lunos-community`
  is now a built-in marketplace (fetched only when you use marketplace commands; turn it off with
  `"marketplace_default": false`). `lunos marketplace install <marketplace>/<name> --kind <kind>` is
  the one documented form for every kind, and it gains `--from <source>`, which adds a
  marketplace on the fly, and `--local`. Plugin installs now show the same preview and confirmation
  as other kinds. Re-installing something already installed reports it and exits 0. An unknown
  name says which marketplaces were searched.
- **v2 plugins can hook tool calls:** `ctx.tool["execute.before"]` and `ctx.tool["execute.after"]`,
  in both the Effect and Promise plugin APIs. A failing `before` hook aborts the call, so a plugin can
  act as a guard. They run in real sessions, after v1 plugin and config hooks, and the first tool
  call of a run waits for plugins to finish loading.
- **A checked-in reference deployment config,** `examples/reference-deployment/opencode.json`: an
  EU-only residency policy with auditing, Mistral as the only enabled provider, sharing disabled
  and updates set to notify. §5 of the self-hosted deployment guide walks through it key by key,
  and a test keeps the guide's copy and the file identical.

### Changed

- **Session sharing is now covered by the residency policy.** With a `residency` policy set, every
  share upload is checked before any connection. Upstream's `opncd.ai` is refused under an EU-only
  policy, with a plain message, and each attempt is written to the audit log. A self-hosted
  `enterprise.url` share server is allowed with `"unknown"` in `residency.allow`, like any other
  self-hosted endpoint.
- **The npm packages now say what they are.** `lunos-ai` and the 12 `lunos-<os>-<arch>` platform
  packages are published with a description, homepage (`lunos.tech`), repository and issue
  tracker (`AxsionDev/Lunos`), author (ITService EOOD) and keywords, and `lunos-ai` ships a README.
  Releases built in GitHub Actions are published with npm provenance, so the npm page links each
  version to the workflow run that built it.
- **Updates now track Lunos, not upstream opencode, and are never installed silently (behaviour
  change from upstream).** The update check reads the `lunos-ai` npm package, at most once a day.
  `lunos upgrade`, the TUI's reminder and the new `/upgrade` command install `lunos-ai` through
  npm, pnpm or bun; other channels refuse with a plain message instead of running upstream's
  install script. With `autoupdate` unset Lunos only tells you about a new release (upstream
  installs patch releases silently); set `"autoupdate": true` to opt back in. The home footer keeps
  showing "update available" after the reminder is dismissed, and plain CLI commands print one
  stderr line a day when a newer release exists. `LUNOS_DISABLE_AUTOUPDATE` is accepted as an
  alias of `OPENCODE_DISABLE_AUTOUPDATE`.
- **One version label everywhere: `Lunos v1.18.38`** (dev builds show `Lunos dev (local build)`)
  on the home footer, session sidebar, crash screen and `/status`. Builds now record the upstream
  opencode release they are based on, shown as `· based on opencode 1.18.31` in `/status`, the
  debug dialog and `lunos debug info`, which also prints the channel and install method for bug
  reports. The crash screen's "open an issue" link now goes to `AxsionDev/Lunos` instead of
  upstream, and `lunos --help` says `lunos`. `lunos --version` still prints the bare number.
- **Session sharing is now off by default (behaviour change from upstream opencode).** When no
  config layer sets `share`, Lunos treats it as `"disabled"`: `/share`, `lunos run --share` and the
  share API route refuse with a message saying how to turn it on, and nothing is uploaded. A shared
  session contains the full transcript and goes to upstream's `opncd.ai` by default, outside the
  residency policy. To get the old behaviour back, set `"share": "manual"` (or `"auto"`). The
  deprecated `"autoshare": true` still counts as an explicit opt-in and maps to `"auto"`.

### Fixed

- **The data-residency policy is enforced for sessions.** In v1.18.38 and earlier, `lunos run` and
  the TUI sent model requests without checking the policy and wrote no audit log, because it was
  only wired into a code path sessions don't use. Upgrade before relying on it. <!-- XCOD-93 -->
- Debug commands no longer cut off output piped to another program. <!-- XCOD-77 -->
- Update checks and `lunos upgrade` stopped tracking upstream opencode. <!-- XCOD-91 -->
- A Claude Code marketplace is named as such instead of failing with a raw schema error.

## [1.18.38] - 2026-09-24

### Added

- **The marketplace carries all four kinds of extension:** plugins, skills, hooks and MCP servers,
  searchable and installable from the CLI and shown in a tabbed TUI Discover view. <!-- XCOD-72 -->
- The community marketplace is seeded with MCP servers. <!-- XCOD-69 -->

### Changed

- Community plugins install from npm; 11 entries that could not be installed were removed.

### Security

- **Affected: the desktop app once attached to this release.** It installed as "OpenCode" and
  updated itself to upstream opencode, without Lunos's residency enforcement or audit log. The
  CLI is not affected. Its files have been removed; if you installed it, uninstall it. From
  v1.18.41 the desktop app ships as Lunos and updates only from Lunos releases.

- **Fixes a local file disclosure from v1.18.37.** A marketplace MCP entry whose URL or header
  names carried config substitution tokens (`{file:…}`, `{env:…}`) could make Lunos read a local
  file and send it to the entry's server. Such entries are now refused.

### Fixed

- Scoped entry names (`@scope/pkg`) resolve; `list`, `add` and `update` count every content kind;
  install refusals print as plain errors.

## [1.18.37] - 2026-09-22

### Added

- **Data-residency controls and an egress audit log**, with provider jurisdiction metadata. Note: not enforced for sessions until v1.18.39. <!-- XCOD-61 XCOD-62 -->
- Config-driven lifecycle hooks, and research mode on Lunos. <!-- XCOD-68 XCOD-71 -->
- Install MCP servers by name from a marketplace.
- A self-hosted deployment guide for procurement reviewers, a release SBOM, and a
  vulnerability-handling policy.

### Security

- **Affected: the desktop app once attached to this release.** It installed as "OpenCode" and
  updated itself to upstream opencode, without Lunos's residency enforcement or audit log. The
  CLI is not affected. Its files have been removed; if you installed it, uninstall it. From
  v1.18.41 the desktop app ships as Lunos and updates only from Lunos releases.

- **Affected by a local file disclosure** when installing an MCP server by name from a
  third-party marketplace. Fixed in v1.18.38; see that release's notes for how to check your
  config.

## [1.18.35] - 2026-09-21

### Security

- **Affected: the desktop app once attached to this release.** It installed as "OpenCode" and
  updated itself to upstream opencode, without Lunos's residency enforcement or audit log. The
  CLI is not affected. Its files have been removed; if you installed it, uninstall it. From
  v1.18.41 the desktop app ships as Lunos and updates only from Lunos releases.

### Fixed

- Release versions are computed from `lunos-ai`, not upstream's `opencode-ai`.

## [1.18.32] - 2026-09-21

The first release published under the Lunos name. It also carries the fork's foundation work
from before releases were cut.

### Added

- Upstream sync policy documenting how Lunos tracks opencode, with the merge-over-rebase decision
  and its measurement (109 conflicts rebasing vs. 0 merging).
- A one-page landing site with email capture.
- Build-in-public publishing cadence: note triggers, format, and channel sequencing, with the
  pre-launch publication gate recorded explicitly.
- "Why we forked opencode" FAQ, drafted and held until launch.
- **A named legal entity behind the project: Lunos operates under ITService EOOD (UIC 201069485),
  registered in Sofia, Bulgaria and trading as Axsion.** Recorded provisionally, with a revisit
  point named, and with the implications for IP ownership and liability written down rather than
  left implicit. Bulgarian incorporation puts the counterparty inside the EU — though note this is
  entity-level sovereignty, not infrastructure sovereignty; self-hosted deployments run on
  infrastructure you supply.

### Changed

- **The product is named Lunos.** The name is frozen after an earlier sequence of renames
  (AXCODE → Ratio → Lunos). Trademark clearance remains a separate, open question.
- **The CLI publishes as `lunos-ai` and installs a `lunos` binary.**
- **Release assets are named `lunos-*`**, matching what the installer expects.
- The README now leads with Lunos's positioning — EU-sovereign, self-hostable, deployable under EU
  law — rather than with a feature comparison against upstream.
- The 21 inherited translated READMEs were resolved to reflect the fork.
- The GitHub organisation and repository were renamed to match the brand.
- Correctness gates in CI moved off runners only the upstream project can use, so the fork's own
  CI is able to run.

### Removed

- 8 inherited CI workflows that were meaningful only for the upstream project.

### Fixed

- Install instructions pointed at a branch that does not exist in this repository.
- Release publishing failed when no GitHub App was configured; it now falls back to the default
  token.

## Known limitations

These are open and tracked. They are listed here rather than omitted, because a changelog that
only records wins is not useful for deciding whether to try something.

- **Binaries are not code-signed** on any platform. Downloads will trip OS gatekeepers.
- **No security certification is held.** No CRA, EUCS, ISO or SOC certification, and none is
  claimed. An SBOM ships with each release as readiness groundwork, not as a compliance claim.
- **Feature parity with upstream is not claimed or measured.**

Two entries were removed from this list in Phase 1, because they stopped being true:

- ~~Installation is not verified end-to-end on a clean machine.~~ `npm install -g lunos-ai`
  was verified end to end at v1.18.35, and again at v1.18.39 on npm 10 and npm 12 (with
  `--allow-scripts=lunos-ai`, which npm 12 needs).
- ~~No EU-specific functionality exists yet.~~ Phase 1 shipped provider jurisdiction metadata and
  enforceable, audit-logged data-residency controls. Scoped precisely: this is control over which
  provider may be used and a record of what left — **not** EU-operated infrastructure, which
  remains something Lunos does not have and does not claim. See `docs/deployment/self-hosted.md`.

---

## Upstream lineage

Lunos forked from opencode and continues to merge upstream releases. The fork exists to add
EU-sovereign deployment and compliance characteristics, not because of any disagreement with
upstream's direction — the infrastructure Lunos builds on is upstream's work.

Upstream changes are not re-listed here. See
[opencode's releases](https://github.com/sst/opencode/releases) for that history.

Lunos is not affiliated with, or endorsed by, the opencode project or Anthropic.

[Unreleased]: https://github.com/AxsionDev/Lunos/compare/v1.18.48...dev
[1.18.48]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.48
[1.18.47]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.47
[1.18.46]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.46
[1.18.44]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.44
[1.18.43]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.43
[1.18.41]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.41
[1.18.40]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.40
[1.18.39]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.39
[1.18.38]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.38
[1.18.37]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.37
[1.18.35]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.35
[1.18.32]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.32
