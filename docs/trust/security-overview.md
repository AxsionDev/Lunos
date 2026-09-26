# Security overview

Applies to release **v1.18.39** and the `dev` branch. Controls marked **next release** are on `dev`
but not in a published release yet.

## Architecture

Lunos is a command-line AI coding agent. It runs as a local process on a developer's machine (or a
server you operate) with that user's permissions. It has three parts:

- **The CLI and terminal UI** (`packages/opencode`, `packages/tui`), which the user drives.
- **A local HTTP server** inside the same process, used by the terminal UI and SDK clients. It
  listens on the loopback interface. Opt-in server mode can expose it; when it does, set
  `OPENCODE_SERVER_PASSWORD` to require authentication ([`SECURITY.md`](../../SECURITY.md#server-mode)).
- **Tools the model can call:** read, edit and write files, run shell commands, search, fetch web
  pages, and call MCP servers and plugins the user has installed.

Lunos-operated infrastructure is **not** in the data path: there is no Lunos account, no telemetry
endpoint and no hosted service. The only Lunos-operated host the CLI contacts is `lunos.tech`, for
the built-in marketplace catalogue, and only when a marketplace command runs
([deployment guide §3](../deployment/self-hosted.md#3-where-your-data-goes)).

## Trust boundaries

| Boundary                         | What crosses it                                     | Who is trusted                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User ↔ Lunos                    | Prompts, approvals                                  | The user is trusted; their config is theirs ([`SECURITY.md`](../../SECURITY.md#out-of-scope))                                                                     |
| Lunos ↔ model provider          | Prompts, file contents the agent reads, tool output | The provider **you** configure, under **your** contract. Lunos restricts _which_ providers may be used (residency policy), not what a provider does with the data |
| Lunos ↔ tools on your machine   | Shell commands, file writes                         | Gated by the permission system, which is **not a sandbox**                                                                                                        |
| Lunos ↔ MCP servers and plugins | Tool calls and their results                        | Code you chose to install. Outside Lunos's trust boundary ([`SECURITY.md`](../../SECURITY.md#out-of-scope))                                                       |
| Lunos ↔ content it reads        | Web pages, files, tool output                       | **Untrusted.** Any of it may contain instructions aimed at the model (prompt injection)                                                                           |
| Organisation ↔ developer        | Managed policy                                      | The organisation's policy wins over the developer's config for locked keys (**next release**)                                                                     |

## Threat model

For each threat: what Lunos does about it, and what remains.

### Prompt injection

Content the agent reads (a web page, a file, an issue, tool output) can carry instructions that the
model may follow.

**Mitigated by:**

- The **permission system** asks before shell commands, file edits and access outside the project,
  unless the user has allowed them ([docs: permissions](../../packages/web/src/content/docs/permissions.mdx)).
- **Access outside the project directory** asks separately (`external_directory`), and paths are
  compared in their on-disk case so a differently cased path can't slip past a rule
  (`packages/opencode/src/tool/external-directory.ts`; case handling **next release**).
- **Read-only agent modes** (for example research mode) remove edit tools from the agent.
- **Organisation policy** can lock permission-relevant settings (**next release**,
  [deployment guide](../deployment/self-hosted.md#organisation-policy-settings-developers-cant-change)).

**Not mitigated:** Lunos cannot tell injected instructions from legitimate ones. A user who approves
every prompt, or allows everything by rule, gets no protection. The permission system is a UX
safeguard, **not a security boundary** ([`SECURITY.md`](../../SECURITY.md#no-sandbox)). For isolation,
run Lunos in a container or VM.

### Tool execution

The agent can run shell commands and change files with the user's permissions.

**Mitigated by:** per-command permission prompts and allow/deny rules
(`packages/opencode/src/permission/index.ts`); every tool run and permission decision recorded in
the audit log (**next release**, [audit log](../audit-log.md)).

**Not mitigated:** there is no sandbox. An allowed command runs with the user's full rights.

### Supply chain: plugins, MCP servers, skills and hooks

Extensions run code on the user's machine.

**Mitigated by:**

- Marketplace installs show exactly what will run or connect, and where it writes, before asking
  (`packages/opencode/src/marketplace/install.ts`).
- Manifests can't carry credentials: they name environment variables, and Lunos writes
  `{env:NAME}` references, never values; `{file:}` substitutions are refused
  (`packages/opencode/src/marketplace/guard.ts`).
- The `lunos-community` catalogue records a review status, licence and pinned version for every
  entry; plugins install at the pinned version and are checked against the reviewed integrity hash;
  MCP launch commands are pinned (**next release**, [marketplace review](../marketplace-review.md)).
- Organisation policy can restrict marketplaces to an allow-list and forbid unreviewed entries
  (**next release**).

**Not mitigated:** no entry in `lunos-community` has been verified by a human reviewer yet; all are
`community` ([review log](../marketplace-review.md#review-log)). Extensions installed outside the
marketplace are not reviewed at all.

### Lunos's own releases

See [Supply chain](supply-chain.md). npm packages carry provenance today; signed checksums for
release archives start with the next release. Binaries are **not OS code-signed**.

### Data leaving the machine

**Mitigated by:** the **data-residency policy**, which refuses model requests (and share uploads) to
providers outside the allowed jurisdictions before any connection is made, and records every
allowed and refused call ([data residency](../data-residency.md); enforced for sessions from
**v1.18.39**). Session sharing is **off by default** and governed by the same policy.

**Not mitigated:** what a permitted provider does with the data is governed by your agreement with
it. Self-hosted, OpenAI-compatible endpoints are untagged and denied until you record their
jurisdiction.

### Secrets

**Mitigated by:** provider credentials are stored in a local file written with mode `0600`
(`packages/opencode/src/auth/index.ts`); config files can reference environment variables instead of
holding values; marketplace-installed MCP servers get `{env:NAME}` references only; the audit log
masks key-shaped strings in recorded command lines (**next release**, [audit log](../audit-log.md#fields-that-can-hold-user-data)).

**Not mitigated:** secrets the agent reads from files, or that appear in tool output, are sent to the
model provider like any other context. Keep secrets out of the files the agent works on.

### Memory

**Next release.** Long-term memory ([rules](../../packages/web/src/content/docs/rules.mdx), design in
[`specs/memory-layer.md` §7](../../packages/opencode/specs/memory-layer.md)) keeps facts across
sessions. A stored fact is a standing prompt-injection candidate for every later session.

**Mitigated by:**

- **Off by default.** It is controlled by `memory.enabled`, `LUNOS_DISABLE_MEMORY=1`, `/memory off`,
  and a per-agent `memory` permission. When off, no memory process starts, no files are written and
  no memory tools are offered (`packages/opencode/src/memory/switch.ts`).
- **A person approves every fact** (`memory` permission, `ask` by default). The model can't write
  memory through files instead: edits under `.opencode/memory/` ask, and the stored graph is denied
  (`packages/opencode/src/agent/agent.ts`).
- **Outside content is refused.** Nothing is remembered in a turn that used `webfetch`,
  `websearch`, an MCP resource or a read outside the project. Key-shaped strings and `{env:}` /
  `{file:}` substitutions are also refused (`packages/opencode/src/memory/guard.ts`).
- **Every fact carries provenance** (session, agent, source, date). Recall shows it, and presents
  memory as reference context, not instructions. Facts can be reviewed, exported, forgotten and
  purged (`lunos memory`, TUI `/memory`).
- **Residency and egress.** Fact extraction uses the configured `memory.model` through Lunos's
  normal model path, so the residency policy applies and memory refuses to start if the policy
  denies that model. Embeddings are computed locally. The memory process gets no API keys, and its
  Python packages are pinned by hash. Writes and forgets are recorded in the audit log, never with
  the fact's text.

**Not mitigated:** shell commands can still write files in `.opencode/memory/`, so review changes to
that folder. Hand-written notes there are trusted by design. The first start downloads packages from
PyPI and an embedding model from Hugging Face (pre-seedable). Memory needs uv and Python 3.10–3.13,
which Lunos does not install.

### The audit log itself

**Next release.** The log is hash-chained, so a line edited, removed or inserted in the middle is
detected by `lunos audit verify`. It **cannot** detect the last lines being removed, or a rewrite by
someone with write access to the file. Forwarding it to a SIEM is what anchors it
([audit log](../audit-log.md#verifying-the-log)).

## Reporting a vulnerability

Privately, through [GitHub Security Advisories](https://github.com/AxsionDev/Lunos/security/advisories/new),
or by email to security@lunos.tech.
Process and response targets: [`SECURITY.md`](../../SECURITY.md).
