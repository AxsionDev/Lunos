<p align="center">
  <a href="https://github.com/AxsionDev/Lunos">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Lunos logo">
    </picture>
  </a>
</p>

<p align="center">
  <b>Lunos is the EU-sovereign, self-hostable AI coding agent</b> — opencode's infrastructure plus
  Claude Code's platform features, built so a public-sector procurement officer can actually
  approve it.
</p>

> **Lunos** is a fork of [opencode](https://github.com/anomalyco/opencode). It is not built by,
> maintained by, or affiliated with the OpenCode team in any way — see
> [Building on OpenCode](#building-on-opencode) below.

## Why Lunos

Most AI coding agents are a single vendor's closed product running in that vendor's cloud, under
that vendor's jurisdiction. For a bank, a hospital, a municipal platform, or anyone with a
data-protection obligation, that is not a procurement conversation that ends well.

Lunos is built for the organisations that have to answer those questions:

- **Self-hostable, not merely "EU region".** Run it inside your own infrastructure. Sovereignty is
  an architectural property — who controls the deployment, which law governs the processor, what
  the sub-processor chain looks like — not a region toggle in someone else's console.
- **Provider-agnostic by design.** Inherited from opencode. If you cannot send code to a
  US-headquartered provider, you still have a working agent. If you can, you keep the frontier
  models. A single-vendor product cannot offer that by construction.
- **Open source, auditable, forkable.** You can read what it does, and it keeps working if any
  vendor changes terms.
- **Answerable in a procurement review.** The explicit design target, not an afterthought.

**What Lunos is not claiming:** it is not at feature parity with closed single-vendor agents today.
The gap is real and the work is tracked in the open. The claim is structural — a closed
single-vendor product cannot become self-hostable and provider-agnostic without ceasing to be
itself, whereas an open fork can close a feature gap.

### Project status

Lunos is **early**. Phase 0 — forking, rebranding, and standing up its own governance, CI and
release pipeline — is complete, and Lunos now publishes releases under its own name. Phase 1
(sovereignty foundation) has landed provider jurisdiction metadata and enforceable data-residency
controls; see the [self-hosted deployment guide](docs/deployment/self-hosted.md).

Treat it as early software rather than production-ready: binaries are not code-signed, and feature
parity with upstream is not claimed or measured.

Decision records for the work so far live in [`.claude/docs/`](.claude/docs/) — covering the
upstream sync policy, the CI workflow triage, and the product name freeze.

<!-- XCOD-23: a feature-parity table was dropped from scope by the product owner (2026-09-18).
     The ticket sourced it from product-vision-roadmap.md, which is confirmed lost — no written
     parity table has ever existed; comparisons were made ad hoc from vendors' own sites. Do not
     re-open this as an oversight; add one only if someone decides to author it from scratch. -->

A published roadmap and a feature-parity comparison table are still to come.

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

<!-- XCOD-23: capturing a Lunos-specific terminal GIF/screenshot was explicitly skipped by the
     product owner (2026-09-18). This image is upstream opencode's UI, not Lunos's splash or
     default theme. Kept deliberately as a stand-in; replace it whenever someone records one. -->

[![Terminal UI — upstream opencode, pending a Lunos capture](packages/web/src/assets/lander/screenshot.png)](https://github.com/AxsionDev/Lunos)

---

### Installation

```bash
# npm — verified end to end at v1.18.39 on npm 10 and npm 12
npm i -g lunos-ai@latest --allow-scripts=lunos-ai   # or bun/pnpm/yarn
lunos --version

# install script
curl -fsSL https://raw.githubusercontent.com/AxsionDev/Lunos/dev/install | bash
```

**npm 12 needs `--allow-scripts=lunos-ai`.** npm 12 no longer runs install scripts by default,
so without the flag the package installs but its postinstall (which fetches the `lunos` binary)
is skipped, and `lunos` exits with "lunos-ai's postinstall script was not run". Earlier npm
versions accept the flag and run the script either way.

The install script places the binary in `$HOME/.lunos/bin` and offers to add it to your `PATH`.
Standalone archives for Linux, macOS and Windows are also attached to each
[release](https://github.com/AxsionDev/Lunos/releases) as `lunos-<os>-<arch>`.

**Channels Lunos does not publish to yet:** Homebrew, Scoop, Chocolatey, AUR, Nix and `mise`.
They are listed here as _absent_ rather than shown as commands that would fail.

> [!NOTE]
> **Binaries are not code-signed yet**, so macOS Gatekeeper and Windows SmartScreen will warn.
> The npm package and building from source are unaffected.
>
> Deploying in a regulated or public-sector environment? See the
> [self-hosted deployment guide](docs/deployment/self-hosted.md), which covers data flows,
> EU data-residency controls, and what the sovereignty claim does and does not cover.

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

Lunos is also available as a desktop application, attached to each
[Lunos release](https://github.com/AxsionDev/Lunos/releases).

| Platform              | Download                                              |
| --------------------- | ----------------------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`                      |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`                        |
| Windows               | `opencode-desktop-win-x64.exe`                        |
| Linux                 | `opencode-desktop-linux-*.deb` / `.rpm` / `.AppImage` |

> [!NOTE]
> These are Lunos builds from the Lunos release, but the **desktop artifacts are still named
> `opencode-desktop-*`** — the desktop packaging has not been rebranded yet, unlike the CLI
> (`lunos-*`). The filenames above are the real ones you will find on the release page. Tracked
> separately; the CLI is unaffected.

#### Installation Directory

The install script installs to **`$HOME/.lunos/bin`** and offers to add that directory to your
`PATH`.

> [!NOTE]
> Upstream's install script honoured `$OPENCODE_INSTALL_DIR`, `$XDG_BIN_DIR` and `$HOME/bin`
> before falling back to a default. **Lunos's install script does not** — `INSTALL_DIR` is
> currently fixed (`install:68`), so setting those variables has no effect. This section
> previously documented the upstream behaviour, which was inaccurate for Lunos.
>
> To install somewhere else today, download the archive from the
> [releases page](https://github.com/AxsionDev/Lunos/releases) and place the `lunos` binary
> where you want it, or use `npm i -g lunos-ai@latest --allow-scripts=lunos-ai` and let npm decide. Restoring the
> override is a code change, tracked separately.

### Modes

Lunos ships four built-in **modes**. Cycle through them with `Tab`, or `Shift+Tab` to go back.
Each mode is a different permission posture, not a different model.

- **build** — the default. Executes tools according to your configured permissions.
- **plan** — disallows every edit tool. Plans are written to `.opencode/plans/`, so it can record
  its thinking without touching your code.
- **research** — deep investigation of a topic or goal, with no code changes. Output is Markdown
  files and specs under `.opencode/research/`.
- **dev-cycle** — the full development cycle: discover, architect, plan, build and verify, with
  human approval gates between phases.

Alongside these are **subagents**, which a mode delegates to rather than you selecting directly:
`general` (complex searches and multi-step tasks), `explore`, `architect`, `planner` and `qa`.
Invoke one explicitly by mentioning it in a message, e.g. `@general`.

> [!NOTE]
> Modes were called _agents_ before the rename. `agent_cycle` still works as an alias for
> `mode_cycle` in keybindings, so existing configs keep working.

### Documentation

**Lunos has no documentation site yet.** What exists lives in this repository:

- [Self-hosted deployment guide](docs/deployment/self-hosted.md) — deployment, data flows, and what
  the EU-sovereignty claim covers
- [Data residency controls](docs/data-residency.md) — restricting provider jurisdictions, and the
  egress audit log
- [Model provider jurisdictions](docs/provider-jurisdictions.md) — where each provider processes data
- [`SECURITY.md`](SECURITY.md) — threat model and vulnerability reporting
- Decision records in [`.claude/docs/`](.claude/docs/)

For configuration options not covered above, upstream opencode's documentation still largely
applies, since Lunos inherits its configuration format — but it describes _opencode_, and the two
have begun to diverge. Treat it as a reference, not as Lunos documentation.

### Contributing

If you're interested in contributing to Lunos, please read our
[contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

<!-- XCOD-65: which channels Lunos should point at is an open product decision (Lunos has no
     Discord or X presence; LinkedIn only). Until that is decided, these are labelled as
     upstream's rather than presented as Lunos's own — they were previously captioned
     "Join our community", which sent Lunos users to opencode's channels. -->

**Lunos has no community channels of its own yet.** For questions about Lunos, open a
[GitHub issue](https://github.com/AxsionDev/Lunos/issues).

Upstream opencode's community — not affiliated with Lunos —
is at [Discord](https://discord.gg/opencode) and [X.com](https://x.com/opencode).
