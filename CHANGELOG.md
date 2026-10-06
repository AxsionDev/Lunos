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

---

## [Unreleased]

### Added

- **Edit agents.** `lunos agent edit <name>` changes an agent's prompt, model, permissions, the
  skills it may load, the MCP servers it may use, and its step limit, from flags or in `$EDITOR`.
  In the TUI, `/agents` lists every agent and opens one in `$EDITOR` (`/agents` used to be an alias
  of `/modes`). Each save is checked against the models, tools, skills and MCP servers available
  here, and nothing is written if anything is wrong. See
  [Editing and sharing agents](docs/sharing-agents.md) (XCOD-210, part of XCOD-203).
- **Run agents unattended, now or on a schedule.** `lunos agent run <name> --prompt …` runs an
  agent with hard limits on time, spend and steps (subagents included), in the Docker sandbox by
  default. Nobody approves anything: every permission prompt is refused and reported, and the agent
  is told why. `--schedule "<cron>"` installs a launchd, systemd or Task Scheduler job;
  `lunos agent schedule list|remove` manages them. Each run writes a report and an `agent.run`
  audit event, and `--notify` can POST the outcome to a webhook. See
  [Running agents unattended](docs/unattended-agents.md) (XCOD-211, part of XCOD-203).

- **Share an agent as one file.** `lunos agent export <name>` writes the agent, the MCP servers it
  uses and the skills it names into a `.lunos-agent` bundle, with MCP environment variables and
  headers by name only, never by value. `lunos agent import <file|url>` shows what the agent may
  do, what it adds and where its model runs before writing anything. Imported agents ask before
  bash, edits and subagents unless you pass `--trust`, and Claude Code subagent files import with
  a report of the fields that didn't carry over. An organisation can turn imports off with a
  locked `agent_import: false`. See [Editing and sharing agents](docs/sharing-agents.md) (XCOD-209, part of
  XCOD-203).

### Changed

- **Stricter front-matter parsing.** Agent, mode and command files must use YAML (or JSON) front
  matter; a file using any other front-matter language is now refused with an error naming the
  file, and skipped (XCOD-208).

## [1.18.44] - 2026-10-05

### Fixed

- **A failed update says why.** When `lunos update` or the TUI's update dialog fails, it now names
  the package manager's error code (e.g. `EBUSY`, `EACCES`, `ERR_PNPM_…`) and the path of npm's
  debug log, instead of only the exit code. Nothing else from the package manager's output is
  shown, since it can contain registry tokens (XCOD-171).
- **Licence notices cover Bun's LGPL libraries in full.** `THIRD_PARTY_NOTICES` and
  `lunos licenses` now include the LGPL-2.0 and LGPL-2.1 texts, the exact WebKit and tinycc commits
  that Bun 1.3.14 statically links, and how to relink with a modified copy. The desktop app's
  notices now include Bun's licence and this section too, since it ships the `lunos` binary
  (XCOD-177).

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
  Lunos**, with an unbound `app_restart` keybind (XCOD-129).
- **`lunos memory export` writes a full, versioned bundle** (`lunos-memory/1`): facts with provenance,
  the entity graph tied to the facts it came from, hand-written notes, and a manifest with a SHA-256
  per file, documented by a JSON Schema in the bundle's `SCHEMA.md`. `--zip`, `--encrypt`
  (OpenSSL-compatible), `--scope`, `--since` and `--include-index`; also `ctrl+s` in the TUI memory
  browser. `--format markdown` keeps the old one-file-per-fact export (XCOD-132).
- **`lunos memory import`** brings memory in from a Lunos bundle (folder, `.zip` or `.zip.enc`),
  Markdown, or `AGENTS.md` / `CLAUDE.md` / Claude Code auto-memory notes. Imported memory is treated
  as untrusted. Bundles are checksum-verified, every fact passes the write guard, and duplicates and
  conflicts are found. A preview of new / duplicate / conflict / rejected rows comes first, and
  nothing is written without `--yes` or approval in the TUI (`ctrl+o` in the memory browser).
  Imported facts keep their original provenance as `origin` and are labelled "imported" when
  recalled. The audit log records each import without its text (XCOD-133).
- **External memory sources** (`memory.sources`): recall from a Neo4j knowledge graph or an MCP
  memory server with a search tool (verified with the reference `@modelcontextprotocol/server-memory`)
  alongside Lunos's own memory. Sources are read-only and untrusted: each needs a `jurisdiction` the residency policy
  allows before it is first contacted; results are screened like imports, cut to the source's
  `max_tokens`, shown in a labelled `<memory-source>` section, and never stored locally. A slow or
  failing source is skipped after `timeout_ms` (2 s) with a notice. `/memory sources` lists them and
  turns one off for the session. A source's fact is kept only through `memory_remember` with the
  source as provenance. New audit events `memory.source_query` and `memory.source_denied`
  (XCOD-135).

- **Sandboxed runs** (XCOD-144, XCOD-157, XCOD-158). `lunos run --sandbox` and `lunos --sandbox` run
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
    `workspace: "mount"`, `devcontainer: "build"`, `network: "open"`).
- **Memory lifecycle** (XCOD-136): a fact can be marked outdated (`lunos memory outdate`, `ctrl+u` in
  the memory browser, or `memory_remember` with `replaces`); it stays in the ledger but is no longer
  recalled, and `search --history` still finds it. A contradicting fact asks whether to replace or
  keep both. Facts can expire (`memory.retention.days`, or `expires` per fact), the ledger is
  integrity-checked, can be encrypted at rest, and every memory operation is in the audit log.
- **Memory in an external Neo4j database** (XCOD-134), so a team shares one ledger: one node per
  fact with its provenance and a checksum, full-text recall, and project and user scopes kept apart.
  `memory.backend.jurisdiction` is checked against your residency policy before Lunos connects, and
  `lunos memory migrate` moves embedded memory across.
- **Third-party licence notices** (XCOD-177). Every npm package, release archive and offline bundle
  carries `LICENSE` and `THIRD_PARTY_NOTICES`, generated at build time from what ships, including
  the Bun runtime's licence. `lunos licenses [--output <file>]` prints them, offline. The desktop
  app has **Help → Third-Party Licences**, and the VS Code extension includes both files. The build
  fails on a copyleft or undeclared licence that isn't on a reviewed allowlist.
- **Lunos JSON Schemas** (XCOD-174). `https://lunos.tech/config.json`, `tui.json`, `theme.json` and
  `desktop-theme.json`, generated from the source and covering Lunos's own keys (`sandbox`,
  `residency`, `memory`, `audit`, `hooks`). The `$schema` Lunos writes now points there.
- **The GitHub agent works with your own token** (XCOD-174). `lunos github install` writes
  `.github/workflows/lunos.yml`, which runs `AxsionDev/Lunos/github` with the repository's
  `GITHUB_TOKEN` (or a fine-grained personal access token); there is no GitHub App to install and
  no token-exchange service. Triggered by `/lunos` or `/oc`. Setup and permissions:
  [docs.lunos.tech/docs/github](https://docs.lunos.tech/docs/github/).
- **Unknown tools name the nearest real ones** (XCOD-167): when a model calls a tool that doesn't
  exist, the error lists the closest names. `"permission": { "<server>_*": "deny" }` keeps an MCP
  server's tools out of a project or agent entirely (`docs/mcp-tools.md`).
- **Accessibility checks for the desktop and web app** (XCOD-141): automated axe-core checks in CI
  on 9 screens in light and dark, with the serious and critical findings fixed; the TUI shows status
  with glyphs as well as colour.

### Security

- **No request to upstream opencode's services on any default path** (XCOD-174). There is no
  OpenCode Console sign-in (`lunos account login` needs a URL you run) and no shared free-tier key
  for the `opencode` provider. The model catalogue comes from models.dev. A build without the
  embedded web UI says so instead of loading upstream's hosted one, and the local server no longer
  trusts upstream's web origins. Docs links, the system prompts and request headers point at
  Lunos. A CI test fails on a new upstream address, and the offline-egress check proves a normal run
  and a `lunos github` run make no connection to it.
- **Secrets with quotes load correctly, and a config parse error never prints them** (XCOD-151).
  An `{env:}` or `{file:}` value containing `"`, `\` or a newline made the config invalid, and the
  error printed the whole substituted config, secret included.
- **Memory now refuses instruction-shaped text** ("ignore all previous instructions", chat role
  markers, tool-call syntax), for the agent's `memory_remember` as well as imports (XCOD-133).

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
<value> [--project]` does the same for scripts (XCOD-128).

### Changed

- **The default agent asks before commands that publish or reach outside the project** (XCOD-164):
  `git push`, `git remote add`/`set-url`, `git config --global`/`--system`, `gh repo create`/`delete`,
  `gh pr create`/`merge`, `gh release create`, `npm`/`pnpm`/`yarn`/`bun publish`, `cargo publish`,
  `twine upload` and `docker push`. In the TUI you're asked; `lunos run` can't ask, so it refuses
  them. Before, they ran unasked: one run committed, rewrote the global git config, added a remote
  and tried `git push` and `gh repo create --public`. Allow them again in your config, e.g.
  `"permission": { "bash": { "git push *": "allow" } }`, or `"bash": "allow"` for everything.

- **`/connect` is now `/providers`,** the same word as the `lunos providers` CLI command. It opens
  on your configured providers, each with its status (connected, expired or error), auth method and
  jurisdiction, with **Add provider** (the old connect flow), **Log out** and **Set as default for
  model picker**. `/connect` remains a hidden alias that shows "/connect is now /providers", and the
  `provider_connect` keybind still works as an alias of the new `provider_list`; both aliases will
  be removed in 1.21.0, after the next two minor releases (XCOD-130).
- **`lunos update` is now the name of the update command,** and `/update` in the TUI. `lunos upgrade`
  and `/upgrade` remain working aliases, so no script breaks. When you're already current it prints
  `Lunos is up to date (X.Y.Z).` and exits 0. Lunos now checks the npm registry on every start (in
  the background, never delaying startup, 3 s timeout, falling back to the last known result)
  instead of once a day, and the TUI shows `There is a new version: X.Y.Z — please run lunos update`
  in the bottom-right corner of every screen, home and session alike, until you update (`New
version: X.Y.Z · lunos update` below 100 columns). This replaces the home-screen footer's `·
update available (/upgrade)`. Plain commands print `There is a new version: X.Y.Z — please run
"lunos update"` to stderr at most once a day. Nothing is checked or shown with `"autoupdate":
false`, `LUNOS_DISABLE_AUTOUPDATE=1`, `LUNOS_OFFLINE=1` or a policy-locked `autoupdate: false`
  (XCOD-147).

### Fixed

- Loading config no longer writes `$schema` into the project's `opencode.json`, a tracked file
  (XCOD-165).
- The built-in configuration skill is `customize-lunos` and points at `lunos settings`, not at
  upstream's schema or commands (XCOD-168).
- An unknown model says `Model not found: …` with suggestions, not `Unexpected server error`
  (XCOD-166).
- `/tasks` no longer cuts a background job's model off; it moved to the row's footer (XCOD-161).
- `lunos stats` totals no longer round to `$0.00` beside non-zero model costs (XCOD-169).
- `lunos run --format json` writes at most one error record (XCOD-148).
- Windows: a path with no drive letter resolves against the project, not the process's drive, and
  permission rules written with 8.3 short names (`C:\PROGRA~1\…`) match long-form paths
  (XCOD-137, XCOD-149).
- A legacy keybind name in `tui.json` (such as `agent_list`, renamed in XCOD-40) was silently
  dropped when the config loaded, instead of resolving to its new name (XCOD-130).

## [1.18.41] - 2026-09-29

### Security

- **A residency policy now checks the endpoint, not just the provider ID.** Up to v1.18.40, pointing
  an EU-tagged provider (such as `mistral`) at another host with `baseURL` still passed
  `"allow": ["eu"]`. Built-in EU claims now hold only for the provider's own API hosts; any other
  endpoint is `unknown` and an EU-only policy refuses it (XCOD-138).

### Added

- **`residency.endpoints`** declares the region of an endpoint Lunos can't assess itself, such as a
  self-hosted vLLM or Ollama server or a company proxy. Declared calls are allowed and recorded in the
  audit log with basis `declared` (XCOD-121, XCOD-138).
- **Offline mode:** `LUNOS_OFFLINE=1` turns off every outbound call Lunos makes on its own behalf;
  `lunos --version --verbose` reports it, with the upstream base and lag (XCOD-121, XCOD-118).
- **Air-gapped deployment** guide, with an Ollama/vLLM recipe tested on an isolated network
  (XCOD-121).
- **Desktop app** ships again, as Lunos (`lunos-desktop-*`, `tech.lunos.desktop`), updating only
  from Lunos releases (XCOD-123).
- **VS Code extension** "Lunos" (publisher `axsion`) on Open VSX and the VS Code Marketplace
  (XCOD-122).
- Weekly upstream merges, with a published "days behind upstream" metric (XCOD-118).

### Fixed

- The CLI no longer tells you to run `opencode …` in hints, errors or `--help` (XCOD-127).
- `lunos uninstall` no longer removes upstream opencode's package or PATH line.

### Known issues

- The offline install bundles were not attached: the release job hung building them. They follow in
  the next release (XCOD-121).

## [1.18.40] - 2026-09-26

### Changed

- **The built-in marketplace matches what lunos.tech publishes.** `marketplace.json` v1.2.0 adds a
  category to every plugin and lists the MCP servers lunos.tech shows: filesystem, git, fetch,
  playwright, github, postgres (`postgres-mcp`) and searxng, in place of memory,
  sequential-thinking, time, everything and context7. lunos.tech now publishes this file at a
  pinned commit instead of keeping its own copy (XCOD-95).
- The install instructions add `--allow-scripts=lunos-ai`: npm 12 no longer runs install scripts by
  default, so without it `lunos` fails to start after an npm install.
- The data-residency docs record that sessions enforce the policy from v1.18.39.

### Fixed

- The v1 plugin loader logs v2 plugin files at DEBUG instead of reporting them as errors
  (XCOD-96).

## [1.18.39] - 2026-09-25

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
  only wired into a code path sessions don't use (XCOD-93). Upgrade before relying on it.
- Debug commands no longer cut off output piped to another program (XCOD-77).
- Update checks and `lunos upgrade` stopped tracking upstream opencode (XCOD-91).
- A Claude Code marketplace is named as such instead of failing with a raw schema error.

## [1.18.38] - 2026-09-24

### Added

- **The marketplace carries all four kinds of extension:** plugins, skills, hooks and MCP servers,
  searchable and installable from the CLI and shown in a tabbed TUI Discover view (XCOD-72).
- The community marketplace is seeded with MCP servers (XCOD-69).

### Changed

- Community plugins install from npm; 11 entries that could not be installed were removed.

### Security

- **Fixes a local file disclosure from v1.18.37.** A marketplace MCP entry whose URL or header
  names carried config substitution tokens (`{file:…}`, `{env:…}`) could make Lunos read a local
  file and send it to the entry's server. Such entries are now refused.

### Fixed

- Scoped entry names (`@scope/pkg`) resolve; `list`, `add` and `update` count every content kind;
  install refusals print as plain errors.

## [1.18.37] - 2026-09-22

### Added

- **Data-residency controls and an egress audit log**, with provider jurisdiction metadata
  (XCOD-61, XCOD-62). Note: not enforced for sessions until v1.18.39.
- Config-driven lifecycle hooks (XCOD-68), and research mode on Lunos (XCOD-71).
- Install MCP servers by name from a marketplace.
- A self-hosted deployment guide for procurement reviewers, a release SBOM, and a
  vulnerability-handling policy.

### Security

- **Affected by a local file disclosure** when installing an MCP server by name from a
  third-party marketplace. Fixed in v1.18.38; see that release's notes for how to check your
  config.

## [1.18.35] - 2026-09-21

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

[Unreleased]: https://github.com/AxsionDev/Lunos/compare/v1.18.44...dev
[1.18.44]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.44
[1.18.43]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.43
[1.18.41]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.41
[1.18.40]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.40
[1.18.39]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.39
[1.18.38]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.38
[1.18.37]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.37
[1.18.35]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.35
[1.18.32]: https://github.com/AxsionDev/Lunos/releases/tag/v1.18.32
