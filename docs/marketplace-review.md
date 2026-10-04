# The lunos-community marketplace: review criteria and log

`lunos-community` (the repository's `marketplace.json`, published at
`https://lunos.tech/marketplace.json`) lists plugins, MCP servers, skill sources and hooks that
Lunos users can install. This document says what an entry must meet to be marked **verified**, how
entries are added and removed, and what has been checked so far.

## What "verified" and "community" mean

Every entry carries a `review` block:

- **`verified`**: the marketplace maintainer agent checked the entry against the criteria below, and
  a named person read its report, checked what it can't (criteria 4–6), and approved the entry at
  the exact version in `review.reviewed_version`. Lunos installs that version and nothing else. The
  entry records who approved it (`reviewer`) and which agent report they read (`agent_version`,
  `agent_report`).
- **`community`**: listed so people can find it, **not reviewed**. Installing it needs
  `--allow-unreviewed`, and an organisation can forbid that (`marketplace_unreviewed: false`,
  locked in managed config).

An entry with no `review` block at all, in any marketplace, is treated as unreviewed. "Verified" is
an assertion by whoever publishes the manifest; the install preview says whose
(`verified by lunos-community (<source>)`), so a verified badge from a third-party marketplace
reads as that party's claim, not Lunos's.

## Inclusion criteria

A **verified** entry must meet all of these, at the reviewed version:

1. **OSI-approved licence**, recorded as an SPDX identifier in `license`.
2. **Public source** matching the published package (repository link, tagged release or commit).
3. **Active maintainer**: the repository is not archived, and issues or releases show activity in
   the last 12 months.
4. **No telemetry**, or telemetry that is disclosed and off by default.
5. **No network access beyond what's declared** in `egress`. A reviewer lists every host the entry
   contacts at runtime; anything else fails the review.
6. **Manual review of install scripts and requested permissions**: `preinstall`/`install`/
   `postinstall` scripts are read and understood, and the tools, commands, file access and
   environment variables the entry uses are proportionate to what it claims to do.
7. For npm packages, **`integrity`** is the registry's `dist.integrity` for the reviewed version.

A **community** entry must still meet criterion 1 (an OSI licence) to be listed at all.

## What the integrity check covers, precisely

- **npm plugins:** before installing, Lunos compares the manifest's `integrity` with the registry's
  `dist.integrity` for the pinned version and refuses on any difference. npm or bun then checks the
  downloaded tarball against that same value. The chain runs from the reviewed hash to the bytes on
  disk.
- **MCP servers started with `npx`, `uvx` or `docker`** fetch their code when the server starts,
  not at install time, so the install-time check doesn't cover them. Their commands are pinned
  instead: `npx pkg@version`, `uvx pkg==version`, and container images by digest.
- **Skill sources and hooks** are URLs and commands, not packages; they are reviewed as written.

## The maintainer agent

`script/marketplace-check.ts` runs on every pull request that changes `marketplace.json` and weekly
(`.github/workflows/marketplace-check.yml`). For each entry it records, from the npm registry and
GitHub:

- the licence in the manifest, on npm, and in the source repository; copyleft is flagged, a non-OSI
  or changed licence fails (criterion 1)
- the source repository, whether it is archived, and its last commit (criteria 2–3)
- the text of any `preinstall` / `install` / `postinstall` script (criterion 6)
- whether `integrity` still matches the registry, and whether a newer version exists (criterion 7)
- whether an MCP server's command is pinned to a version or image digest
- the network access the entry **declares** in `egress`. The agent doesn't observe network traffic;
  checking that declaration is part of the person's review (criterion 5).

It proposes a verdict per entry (keep, keep with a warning, needs a person's review, delist) and
writes the report to `marketplace-reviews/<date>.md` and `.json`. Weekly reports arrive as a pull
request.

**What it never does:** edit `marketplace.json`, or mark an entry verified. Telemetry (criterion 4)
and whether an entry's tools and permissions are proportionate (criterion 6) need a person. A test
fails any `verified` entry that doesn't name a person as `reviewer` and the agent version they read.

## Adding an entry

Open a pull request against `marketplace.json` in the Lunos repository with the entry, its SPDX
`license`, the version you are proposing and its `integrity`, and `review: { "status":
"community" }`. A maintainer who reviews it against the criteria above changes the status to
`verified` and fills in `reviewed_version`, `reviewed_at`, `reviewer` and `egress` in the same
pull request, with `agent_version` and `agent_report` naming the agent report they read.

## Removing an entry

An entry is removed when it stops meeting the listing criterion (for example it relicenses to a
non-OSI licence), when a verified entry fails a re-review, or when a vulnerability or malicious
change is found. Removal is a pull request that says why; the removed entry and reason are added to
the log below. Users who already installed it keep it until they remove it; `lunos marketplace
list` shows it only if it's still listed.

## Review log

### 2026-10-04: decisions on the first agent report (Petar Minev)

**Removed** (archived repository: no maintainer to fix them, criterion 3):

| Entry                     | Package                       | Version | Why                                                                                       |
| ------------------------- | ----------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| opencode-skillful         | `@zenobius/opencode-skillful` | 1.2.5   | `zenobi-us/opencode-skillful` archived, last push 2026-02-13                              |
| opencode-antigravity-auth | `opencode-antigravity-auth`   | 1.6.0   | `NoeFabris/opencode-antigravity-auth` archived, last push 2026-08-27; handles credentials |

**Kept as community, with a note in the description users see:**

- `opencode-dynamic-context-pruning`: "Licensed AGPL-3.0 (copyleft)."
- `opencode-conductor`: "On install it copies an agent and slash commands into ~/.config/opencode,
  replacing files of the same name." (Its `postinstall` at 1.32.0 makes no network calls.)

Users who already installed a removed entry keep it until they uninstall it.

### 2026-10-03: first maintainer-agent report (proposed verdicts, nothing changed)

Full report: [`marketplace-reviews/2026-10-03.md`](../marketplace-reviews/2026-10-03.md). 32 entries:
27 keep, 4 keep with a warning, 1 needs a person's review. The four flagged entries, with what was
checked first-hand:

| Entry                              | Finding                                                                                                                                                                                                                                       | Proposed                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `opencode-skillful`                | `zenobi-us/opencode-skillful` is **archived** (GitHub API), last push 2026-02-13. MIT.                                                                                                                                                        | Keep as community with a warning, or remove; it fails criterion 3 for verified          |
| `opencode-antigravity-auth`        | `NoeFabris/opencode-antigravity-auth` is **archived** (GitHub API), last push 2026-08-27. MIT.                                                                                                                                                | Same as above                                                                           |
| `opencode-dynamic-context-pruning` | **AGPL-3.0-or-later** on npm and in the repository (OSI-approved copyleft). Repository active (push 2026-09-25).                                                                                                                              | Keep, with the licence shown, so users know it's copyleft                               |
| `opencode-conductor`               | `postinstall` runs `node scripts/postinstall.cjs` (read at 1.32.0): no network access; it copies `conductor.md` and the plugin's slash-command files into `~/.config/opencode/agent/` and `command/`, **overwriting files of the same name**. | Keep as community; tell users it writes to their global config on install. Not verified |

The decision on each is ITService EOOD's, through a pull request.

### 2026-09-25: first catalogue pass (facts only, no entry verified)

Facts read from the npm and PyPI registries for the latest version of every listed package. **No
entry has been reviewed against criteria 3–6**: that needs a person, so every entry is `community`.
Network access (`egress`) has not been assessed for any entry.

**Removed** (fail criterion 1, the listing criterion):

| Entry               | Package                        | Version | Licence                                         |
| ------------------- | ------------------------------ | ------- | ----------------------------------------------- |
| oh-my-opencode      | `oh-my-opencode`               | 4.19.4  | SUL-1.0 (not OSI-approved)                      |
| @openspoon/subtask2 | `@spoons-and-mirrors/subtask2` | 0.3.5   | PolyForm-Noncommercial-1.0.0 (not OSI-approved) |

**Listed as community:**

| Entry                            | Kind         | Package / command                                                                                          | Version listed    | Licence            | Install scripts                   | Published  | Notes                                                                                                                   |
| -------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------- | ------------------ | --------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| opencode-helicone-session        | plugin       | `opencode-helicone-session`                                                                                | 1.0.1             | MIT                | none                              | 2025-12-10 |                                                                                                                         |
| opencode-openai-codex-auth       | plugin       | `opencode-openai-codex-auth`                                                                               | 4.4.0             | MIT                | none                              | 2026-01-09 |                                                                                                                         |
| opencode-gemini-auth             | plugin       | `opencode-gemini-auth`                                                                                     | 2.0.1             | MIT                | none                              | 2026-09-23 |                                                                                                                         |
| opencode-antigravity-auth        | plugin       | `opencode-antigravity-auth`                                                                                | 1.6.0             | MIT                | none                              | 2026-02-20 |                                                                                                                         |
| opencode-devcontainers           | plugin       | `opencode-devcontainers`                                                                                   | 0.5.1             | MIT                | none                              | 2026-08-24 |                                                                                                                         |
| opencode-dynamic-context-pruning | plugin       | `@tarquinen/opencode-dcp`                                                                                  | 3.2.0             | AGPL-3.0-or-later  | none                              | 2026-09-20 | AGPL-3.0: OSI-approved, copyleft                                                                                        |
| opencode-vibeguard               | plugin       | `opencode-vibeguard`                                                                                       | 0.1.0             | MIT                | none                              | 2026-02-28 |                                                                                                                         |
| opencode-websearch-cited         | plugin       | `opencode-websearch-cited`                                                                                 | 1.2.0             | Apache-2.0         | none                              | 2026-01-10 |                                                                                                                         |
| opencode-pty                     | plugin       | `opencode-pty`                                                                                             | 0.4.0             | MIT                | none                              | 2026-09-18 |                                                                                                                         |
| opencode-wakatime                | plugin       | `opencode-wakatime`                                                                                        | 1.3.9             | MIT                | none                              | 2026-07-14 |                                                                                                                         |
| opencode-md-table-formatter      | plugin       | `@franlol/opencode-md-table-formatter`                                                                     | 0.0.6             | MIT                | none                              | 2026-02-21 |                                                                                                                         |
| opencode-morph-plugin            | plugin       | `@morphllm/opencode-morph-plugin`                                                                          | 2.0.17            | MIT                | none                              | 2026-09-07 |                                                                                                                         |
| opencode-notifier                | plugin       | `@mohak34/opencode-notifier`                                                                               | 0.3.0             | MIT                | none                              | 2026-09-21 |                                                                                                                         |
| opencode-zellij-namer            | plugin       | `opencode-zellij-namer`                                                                                    | 1.1.3             | MIT                | none                              | 2025-12-20 |                                                                                                                         |
| opencode-skillful                | plugin       | `@zenobius/opencode-skillful`                                                                              | 1.2.5             | MIT                | none                              | 2026-02-13 | No licence field on npm; GitHub repo is MIT but **archived**: fails _active maintainer_ unless a maintained fork exists |
| opencode-supermemory             | plugin       | `opencode-supermemory`                                                                                     | 2.0.13            | MIT                | none                              | 2026-09-01 |                                                                                                                         |
| opencode-scheduler               | plugin       | `opencode-scheduler`                                                                                       | 1.3.0             | MIT                | none                              | 2026-02-17 |                                                                                                                         |
| opencode-conductor               | plugin       | `opencode-conductor-plugin`                                                                                | 1.32.0            | Apache-2.0         | yes: node scripts/postinstall.cjs | 2026-03-02 | Has an install script: needs manual review                                                                              |
| micode                           | plugin       | `micode`                                                                                                   | 0.11.0            | MIT                | none                              | 2026-09-17 |                                                                                                                         |
| octto                            | plugin       | `octto`                                                                                                    | 0.4.5             | MIT                | none                              | 2026-09-23 |                                                                                                                         |
| opencode-sentry-monitor          | plugin       | `opencode-sentry-monitor`                                                                                  | 0.1.7             | MIT                | none                              | 2026-03-19 | No repository field on npm; source is github.com/stolinski/opencode-sentry-monitor (MIT)                                |
| opencode-jfrog-plugin            | plugin       | `@jfrog/opencode-jfrog-plugin`                                                                             | 0.3.2             | Apache-2.0         | none                              | 2026-09-24 |                                                                                                                         |
| opencode-goal-plugin             | plugin       | `opencode-goal-plugin`                                                                                     | 0.10.0            | MIT                | none                              | 2026-09-07 |                                                                                                                         |
| filesystem                       | MCP (npx)    | `@modelcontextprotocol/server-filesystem@2026.8.31`                                                        | pinned in command | Apache-2.0 AND MIT | n/a (fetched at server start)     |            |                                                                                                                         |
| git                              | MCP (uvx)    | `mcp-server-git==2026.8.18`                                                                                | pinned in command | MIT                | n/a (fetched at server start)     |            |                                                                                                                         |
| fetch                            | MCP (uvx)    | `mcp-server-fetch==2026.8.18`                                                                              | pinned in command | MIT                | n/a (fetched at server start)     |            |                                                                                                                         |
| playwright                       | MCP (npx)    | `@playwright/mcp@0.0.82`                                                                                   | pinned in command | Apache-2.0         | n/a (fetched at server start)     |            |                                                                                                                         |
| github                           | MCP (docker) | `ghcr.io/github/github-mcp-server@sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6` | pinned in command | MIT                | n/a (fetched at server start)     |            |                                                                                                                         |
| postgres                         | MCP (uvx)    | `postgres-mcp==0.3.0`                                                                                      | pinned in command | MIT                | n/a (fetched at server start)     |            |                                                                                                                         |
| searxng                          | MCP (npx)    | `mcp-searxng@2.4.0`                                                                                        | pinned in command | MIT                | n/a (fetched at server start)     |            |                                                                                                                         |
