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

> [!NOTE]
> **No public Lunos release has shipped yet.** Everything below is on `dev` and has not been
> published as an installable release. The install path is not yet verified end-to-end and
> binaries are not code-signed — see [Known limitations](#known-limitations).

### Added

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

### Known limitations

These are open and tracked. They are listed here rather than omitted, because a changelog that
only records wins is not useful for deciding whether to try something.

- **Binaries are not code-signed** on any platform. Downloads will trip OS gatekeepers.
- **No security certification is held.** No CRA, EUCS, ISO or SOC certification, and none is
  claimed. An SBOM ships with each release as readiness groundwork, not as a compliance claim.
- **Feature parity with upstream is not claimed or measured.**

Two entries were removed from this list in Phase 1, because they stopped being true:

- ~~Installation is not verified end-to-end on a clean machine.~~ `npm install -g lunos-ai`
  was verified end to end at v1.18.35.
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

[Unreleased]: https://github.com/AxsionDev/Lunos/commits/dev
