<p align="center">
  <a href="https://github.com/pminev1/Lunos">
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

> [!WARNING]
> **Pre-release.** Lunos has not shipped an installable build yet. The install commands below
> still install **upstream opencode**, not Lunos. Build from source in the meantime.

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

Lunos is **pre-release** and in Phase 0: forking, rebranding, and standing up its own governance,
CI, and release pipeline. Nothing here is production-ready yet.

Decision records for the work so far live in [`.claude/docs/`](.claude/docs/) — covering the
upstream sync policy, the CI workflow triage, and the product name freeze.

<!-- TODO(XCOD-23): link or embed the feature-parity table once it exists. The ticket sources it
     from product-vision-roadmap.md, which is not present in this repository. -->
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

<!-- TODO(XCOD-23): replace with a terminal GIF/screenshot of Lunos actually running.
     This still shows upstream opencode's UI, not Lunos's splash or default theme.
     Needs a real capture (asciinema or similar). -->
[![Terminal UI — upstream opencode, pending a Lunos capture](packages/web/src/assets/lander/screenshot.png)](https://github.com/pminev1/Lunos)

---

### Installation

> [!IMPORTANT]
> **These commands install upstream opencode, not Lunos.** They are kept because they work and
> because opencode is what Lunos forks — running them gives you the base this project builds on.
> Lunos does not publish an installable artifact yet: there is no Lunos install script, tap, or
> signed binary, and the `lunos-ai` npm name is unpublished. Publishing is gated on standing up
> release CI under Lunos-owned credentials. Until then, build from source — see
> [Contributing](#contributing).

```bash
# YOLO
curl -fsSL https://opencode.ai/install | bash

# Package managers
npm i -g opencode-ai@latest        # or bun/pnpm/yarn
scoop install opencode             # Windows
choco install opencode             # Windows
brew install anomalyco/tap/opencode # macOS and Linux (recommended, always up to date)
brew install opencode              # macOS and Linux (official brew formula, updated less)
sudo pacman -S opencode            # Arch Linux (Stable)
paru -S opencode-bin               # Arch Linux (Latest from AUR)
mise use -g opencode               # Any OS
nix run nixpkgs#opencode           # or github:anomalyco/opencode for latest dev branch
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App (BETA)

OpenCode is also available as a desktop application. Download directly from the [releases page](https://github.com/anomalyco/opencode/releases) or [opencode.ai/download](https://opencode.ai/download).

| Platform              | Download                           |
| --------------------- | ---------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-mac-arm64.dmg`   |
| macOS (Intel)         | `opencode-desktop-mac-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe` |
| Linux                 | `.deb`, `.rpm`, or `.AppImage`     |

```bash
# macOS (Homebrew)
brew install --cask opencode-desktop
# Windows (Scoop)
scoop bucket add extras; scoop install extras/opencode-desktop
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$OPENCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if it exists or can be created)
4. `$HOME/.opencode/bin` - Default fallback

```bash
# Examples
OPENCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://opencode.ai/install | bash
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://opencode.ai/install | bash
```

### Agents

OpenCode includes two built-in agents you can switch between with the `Tab` key.

- **build** - Default, full-access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode, [**head over to our docs**](https://opencode.ai/docs).

### Contributing

If you're interested in contributing to OpenCode, please read our [contributing docs](./CONTRIBUTING.md) before submitting a pull request.

### Building on OpenCode

If you are working on a project that's related to OpenCode and is using "opencode" as part of its name, for example "opencode-dashboard" or "opencode-mobile", please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way.

---

**Join our community** [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
