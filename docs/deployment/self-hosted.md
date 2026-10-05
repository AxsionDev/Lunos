# Self-hosted deployment guide

For procurement, security and compliance reviewers evaluating Lunos, and for the administrator who will deploy it.

Written to be read without any familiarity with the codebase. It states what Lunos is, exactly where data goes, what the EU-sovereignty claim does and does not cover, and how to deploy it under a data-residency policy.

The rest of the reviewer documentation (security overview and threat model, supply chain, CRA readiness, and pre-filled CAIQ answers) is in the [Trust pack](../trust/README.md).

---

## 1. What Lunos is

An AI coding assistant that runs as a command-line tool on a developer's machine or on a server you operate. It sends coding prompts to a large language model of your choosing and applies the results to files in your repository.

It is a fork of the open-source project [opencode](https://github.com/anomalyco/opencode), maintained by **ITService EOOD** (Bulgaria, UIC 201069485). MIT licensed.

**The deployment model is self-hosted.** You install it on infrastructure you control. No Lunos-operated service is needed to run it, and there is no account to create with us. (The optional built-in marketplace catalogue is a static file on lunos.tech; see §3.)

## 2. What is true today — the sovereignty claim, stated precisely

This is the claim table maintained in the project's own sovereignty decision record. It is reproduced here without softening.

| Claim                                                          | True today?            | Basis                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The vendor is EU-incorporated                                  | **Yes**                | ITService EOOD, Bulgaria, UIC 201069485                                                                                                                                                                    |
| The vendor is outside non-EU compulsory-disclosure reach       | **Yes**                | Bulgarian legal person; not a US-parented subsidiary                                                                                                                                                       |
| Lunos can be run entirely on infrastructure the buyer controls | **Yes**                | Self-hosted is the shipping distribution model                                                                                                                                                             |
| Lunos is provider-agnostic for model routing                   | **Yes**                | Inherited from opencode                                                                                                                                                                                    |
| _Lunos-operated_ infrastructure is EU-sovereign                | **N/A**                | There is no Lunos-operated production infrastructure for customers                                                                                                                                         |
| EU-specific functionality exists in the build                  | **Yes, from v1.18.39** | Provider jurisdiction metadata ships, and the data-residency controls in §5 are enforced for sessions from v1.18.39. In v1.18.38 and earlier they are **not enforced** (see the correction in §5, XCOD-93) |

### Wording rules

These govern how the project describes itself, and are reproduced so you can hold us to them:

- ✅ **"EU-sovereign, self-hostable"** — accurate; the two words qualify each other.
- ✅ **"EU-incorporated vendor"** — a fact about the entity.
- ❌ **"EU-sovereign infrastructure" / "sovereign cloud"** — implies Lunos-operated hosting. Not true, and not claimed.
- ❌ **Any claim of CRA, EUCS or similar certification.** None is held. See §7.

If you encounter Lunos marketing that uses the ❌ phrasings, it contradicts this document and this document is authoritative.

## 3. Where your data goes

### Leaves your infrastructure

**Only one thing: the model requests you make.** When Lunos answers a prompt it sends the prompt, relevant file contents, and conversation context to the model provider **you configure** — for example Mistral, Scaleway, Anthropic or OpenAI.

That provider is your choice and your contractual relationship. Lunos does not select one for you and has no commercial arrangement with any of them. Where each provider processes data is documented in [Model provider jurisdictions](../provider-jurisdictions.md).

The tool also fetches its model catalogue (a list of available models and their capabilities — no prompt data) over the network, and checks for updates unless disabled. None of these other calls carries project data. [Every outbound call](#every-outbound-call-and-offline-mode) lists all of them, and one switch turns them all off.

**The update check** reads the `lunos-ai` package entry from your npm registry: `https://registry.npmjs.org/lunos-ai/latest` by default, or whatever registry your npm configuration points at, so a corporate or EU mirror is honoured. It sends no project data. It runs on every start, in the background, and never delays startup: if the registry doesn't answer within 3 seconds, the last result (cached in Lunos's state directory) is used. Lunos only _announces_ new releases: `There is a new version: X.Y.Z — please run lunos update` in the bottom-right of the TUI, and at most once a day on stderr for plain commands. It never installs one unless a person runs `lunos update` (or `/update` in the TUI), or you set `"autoupdate": true`. To turn the check off entirely, set `"autoupdate": false` or the environment variable `LUNOS_DISABLE_AUTOUPDATE=1`.

**Long-term memory, if you turn it on** (from v1.18.40; `"memory": { "enabled": true }`; off by default). Measured on 2026-09-26:

- **First start.** It downloads its Python packages from PyPI (`pypi.org`, `files.pythonhosted.org`), pinned by hash, and the local embedding model from Hugging Face (`huggingface.co` and its CDN hosts).
- **After that, no network of its own.** Every remember and recall ran with all outbound connections blocked.
- **Fact extraction** uses the model you set as `memory.model`, through your normal provider and residency policy, so it is one more model request like any other.
- **Avoiding the downloads.** You can pre-seed the uv cache and the model directory. Details are in [`specs/memory-layer.md` §7](../../packages/opencode/specs/memory-layer.md).
- **Exports stay where you put them** (from the next release). `lunos memory export` writes a bundle to a local path you choose: facts with provenance, the extracted graph, copies of `.opencode/memory/*.md`, and a manifest. It makes no model call. Reading the graph starts the local memory process, which after its first start uses only what it has cached. The bundle leaves the machine only if you move it; the TUI writes it to the Lunos data directory, never into the project. Embeddings and engine database files are included only with `--include-index`. `--encrypt` locks it with a passphrase that is never stored.
- **Retention, encryption and audit** (from the next release). None of these makes a network call.
  - `memory.retention.days` expires facts that many days after they were saved (default: never); expired facts stop being recalled at once and are deleted `memory.retention.grace_days` later (default 7). Facts can also be marked outdated (`lunos memory outdate`): kept for history, never recalled.
  - `"memory": { "encryption": "os-keychain" }` encrypts the provenance ledger (`facts.jsonl`) with AES-256-GCM, using a random key held only in the OS keychain (macOS Keychain, Windows Credential Manager, libsecret on Linux; a headless Linux host needs a running Secret Service). **It does not encrypt the memory engine's own database files** in the same directory (Cognee's SQLite, LanceDB and Kuzu stores, its plain-text copy of each fact under `data/`, and its logs under `logs/`; measured 2026-09-29, all hold fact text), nor the hand-written notes in `.opencode/memory/*.md`. Put the project and the Lunos data directory on full-disk-encrypted storage. If the keychain entry is lost, the ledger can't be read: Lunos refuses to use that memory rather than starting empty, and nothing else holds the key.
  - Each ledger line carries a SHA-256 and a hash chain; lines that don't match are quarantined (not recalled, not exported) and reported by `lunos memory verify` and the audit log. The hashes are unkeyed: they catch damage and hand edits, not a deliberate rewrite by someone with write access.
  - Every memory operation is an audit event (`memory.remember`, `recall`, `forget`, `outdate`, `import`, `export`, `purge`, `verify_failed`): time, scope, fact ids, counts and where it came from, never a fact's text or a search query. They are forwarded to your SIEM with everything else.

**The marketplace** (`lunos marketplace …` commands and the TUI's Discover view) fetches `https://lunos.tech/marketplace.json`, the built-in `lunos-community` catalogue: names, descriptions and install sources of community plugins and MCP servers. It sends no project data, runs only when you use those commands, never at startup, and is cached for a day. Installing an entry then fetches that entry's package (for example from npm). Turn off the built-in catalogue with `"marketplace_default": false`. Marketplaces you add yourself are fetched the same way.

#### Session sharing — off by default

`/share` publishes a session at a public link. **Lunos turns this off unless you enable it**, because a shared session contains the whole transcript: your prompts, the contents of every file the agent read, and tool output. That is more sensitive than any single model request.

| Setting               | What happens                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `share` unset         | Same as `"disabled"`. This differs from upstream opencode, where `/share` works out of the box     |
| `"share": "disabled"` | `/share` is refused with a message saying how to enable it. Nothing is uploaded                    |
| `"share": "manual"`   | `/share` uploads the session when a person runs it                                                 |
| `"share": "auto"`     | Every new session is uploaded as it is created. The deprecated `"autoshare": true` also means this |

When sharing is on, uploads go to `enterprise.url` if you set one, and otherwise to **`https://opncd.ai`**, upstream opencode's hosted share service. That host is operated by a non-EU third party, not by Lunos.

**Sharing is governed by the residency policy.** With a `residency` policy set, every share upload (creating a share, syncing it, removing it) is checked before a connection is made, and each attempt is recorded in the audit log:

- `opncd.ai`, and the opencode console's share service for signed-in orgs, count as non-EU (`us`). An EU-only policy refuses them: `/share` says "Session sharing to opncd.ai is blocked by the data-residency policy", and nothing is uploaded.
- A self-hosted share server at `enterprise.url` is treated like any other self-hosted endpoint. Lunos can't verify where it runs, so its region is `unknown`, and you allow it explicitly with `"residency": { "allow": ["eu", "unknown"] }`. That is the supported way to share under an EU-only policy. The `OPENCODE_AUTO_SHARE` environment variable only turns `"manual"` into `"auto"`; it cannot re-enable sharing that is disabled.

**Sharing without any upload (the supported path).** Lunos runs no share service. The way to share inside your perimeter is to share files you already control:

- **A session:** `/export` in the TUI (or `lunos export <session-id>` for JSON, with `--sanitize` to redact file contents and tool output) writes the transcript to a local file. Send it through whatever channel your organisation already approves. Nothing is uploaded.
- **Plans, research notes and dev-cycle records:** these are Markdown files in `.opencode/plans/`, `.opencode/research/` and `.opencode/dev-cycle/`. Commit them and review them like any other document. `/artifacts` in the TUI lists and opens them.

### Stays on your infrastructure

Everything else:

- Your source code, except the portions sent to your chosen model provider as context
- Conversation history and session state, stored in local files
- Configuration and credentials, stored locally
- Long-term memory, when on (from v1.18.40): the knowledge graph and its provenance ledger, in local files, or, if you configure one, in a Neo4j database you run ([External memory database](#external-memory-database)). `lunos memory export` bundles are written only where you tell them to go
- The audit log: model calls and share uploads (v1.18.39); tool runs, permission decisions, installs and policy refusals from v1.18.40. No prompt or file contents (§5, and [The audit log](../audit-log.md)). It leaves the machine only if you configure forwarding to your own SIEM

### Touches Lunos-operated infrastructure

**No project data.** There is no Lunos-operated production infrastructure in the data path, because there is no hosted offering. Nothing about your code, prompts or sessions is sent to ITService EOOD, and there is no telemetry endpoint we operate for you to disable.

**One Lunos-operated host is contacted, and only on use:** `lunos.tech`, which serves the built-in marketplace catalogue (`https://lunos.tech/marketplace.json`, a static file) when you run a marketplace command or open the Discover view. The request carries nothing from your project, and turning off the built-in catalogue with `"marketplace_default": false` stops it (see "The marketplace" above). The update check goes to your npm registry, not to us.

```
   ┌──────────────────────────────────────┐
   │   YOUR INFRASTRUCTURE                │
   │                                      │
   │   ┌────────────┐   ┌──────────────┐  │
   │   │ Lunos CLI  │──▶│ Your source  │  │
   │   └─────┬──────┘   │ code, config │  │
   │         │          │ sessions,    │  │
   │         │          │ audit log    │  │
   │         │          └──────────────┘  │
   └─────────┼────────────────────────────┘
             │  prompts + code context
             │  (the only egress)
             ▼
   ┌──────────────────────────────────────┐
   │  MODEL PROVIDER YOU CHOOSE           │
   │  e.g. Mistral (FR), Scaleway (FR)    │
   │  Your contract, your jurisdiction    │
   └──────────────────────────────────────┘

   ┌──────────────────────────────────────┐
   │  ITSERVICE EOOD / LUNOS              │
   │  ── not in the data path ──          │
   └──────────────────────────────────────┘
```

### Every outbound call, and offline mode

Set **`LUNOS_OFFLINE=1`** (from v1.18.41) to turn off every call Lunos makes on its own behalf, in one switch. That covers the model catalogue, update checks, downloads of LSP servers, formatters and ripgrep, syntax-highlighting grammars, sharing, the marketplace, and the `webfetch` and `websearch` tools. What stays on is what you configured yourself: your model provider, MCP servers, remote config and skills, and audit forwarding to your SIEM. Offline mode means "only talk to what I set up", not "no network at all".

With offline mode on:

- **The model catalogue** comes from the snapshot built into the binary.
- **LSP servers and formatters** are used only if they're already installed. Code navigation for a language is missing if its server isn't.
- **Syntax highlighting** is off in the TUI.
- **ripgrep** must be installed as `rg`.
- **Memory**, if you turn it on, uses only what uv and Hugging Face have already cached. See [Avoiding the downloads](#leaves-your-infrastructure).

Every refused call names `LUNOS_OFFLINE` in its message. It doesn't hang or retry. This table is generated from the code that does the gating, so it lists every outbound call Lunos can make:

<!-- offline-calls:start (generated by script/offline-calls.ts; do not edit) -->

| Outbound call                                                                     | Host(s)                                                                                                   | When                                                                                              | With `LUNOS_OFFLINE=1`     | Other switch                                                                                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| Models catalogue refresh                                                          | models.dev (or `OPENCODE_MODELS_URL`)                                                                     | startup, then hourly                                                                              | **Off**                    | `OPENCODE_DISABLE_MODELS_FETCH`. The catalogue snapshot built into the binary is used instead |
| Update check (`lunos update` notice) and automatic update                         | npm registry (or your `.npmrc` registry)                                                                  | every start, in the background (3 s timeout)                                                      | **Off**                    | `LUNOS_DISABLE_AUTOUPDATE`, or `"autoupdate": false`                                          |
| npm installs: LSP servers, formatters, the plugin SDK, npm plugins, provider SDKs | npm registry (or your `.npmrc` registry)                                                                  | startup, and when a file type or provider is first used                                           | **Off**                    | `OPENCODE_DISABLE_LSP_DOWNLOAD` (LSP servers only)                                            |
| LSP server downloads and toolchain installs (`go install`, `gem`, `dotnet tool`)  | github.com, download-cdn.jetbrains.com, releases.hashicorp.com, proxy.golang.org, rubygems.org, nuget.org | when a matching file is first opened                                                              | **Off**                    | `OPENCODE_DISABLE_LSP_DOWNLOAD`                                                               |
| ripgrep download, when `rg` isn't installed                                       | github.com                                                                                                | first search                                                                                      | **Off**                    | none                                                                                          |
| Syntax-highlighting grammars for the TUI                                          | github.com, raw.githubusercontent.com                                                                     | when the TUI first shows code in that language                                                    | **Off**                    | none                                                                                          |
| Session sharing                                                                   | opncd.ai, or your enterprise share URL                                                                    | only when you share (off by default)                                                              | **Off**                    | `OPENCODE_DISABLE_SHARE`                                                                      |
| Marketplace index, manifests and integrity lookups                                | lunos.tech, raw.githubusercontent.com, api.github.com, npm registry                                       | `lunos marketplace` and the Discover view                                                         | **Off**                    | none                                                                                          |
| Console account: organisation config and token refresh                            | the console URL you logged in to (there is no default)                                                    | startup, only if you logged in with `lunos account login <url>`                                   | **Off**                    | none                                                                                          |
| Memory sidecar dependencies and embedding model                                   | pypi.org, huggingface.co                                                                                  | first memory use (memory is opt-in). Offline, uv and Hugging Face only use what is already cached | **Off**                    | `LUNOS_DISABLE_MEMORY`                                                                        |
| `webfetch` tool                                                                   | any URL the agent chooses                                                                                 | when the agent calls it                                                                           | **Off** (tool not offered) | none                                                                                          |
| `websearch` tool                                                                  | mcp.exa.ai, search.parallel.ai                                                                            | when the agent calls it (off unless enabled)                                                      | **Off** (tool not offered) | none                                                                                          |
| Model provider API, including its login and model list                            | the provider you configure                                                                                | every model call                                                                                  | On: you configured it      | none                                                                                          |
| Remote MCP servers, and their OAuth                                               | URLs in `mcp`                                                                                             | startup, and on each MCP tool call                                                                | On: you configured it      | none                                                                                          |
| Remote config from `.well-known/opencode`                                         | URLs you added with `lunos providers login <url>`                                                         | startup                                                                                           | On: you configured it      | none                                                                                          |
| Remote skills and URL instructions                                                | URLs in `skills.urls` and `instructions`                                                                  | startup and each prompt                                                                           | On: you configured it      | none                                                                                          |
| Audit forwarding to your SIEM                                                     | `audit.forward` endpoint (OTLP/HTTP or syslog)                                                            | background, only if configured                                                                    | On: you configured it      | none                                                                                          |
| OpenTelemetry export                                                              | `OTEL_EXPORTER_OTLP_ENDPOINT`                                                                             | background, only if set                                                                           | On: you configured it      | none                                                                                          |
| Remote workspaces (experimental)                                                  | your workspace URL                                                                                        | only with `OPENCODE_EXPERIMENTAL_WORKSPACES`                                                      | On: you configured it      | none                                                                                          |
| `git fetch` when resetting a worktree                                             | your git remote                                                                                           | on demand                                                                                         | On: you configured it      | none                                                                                          |
| `account login`, `providers login`, `import <url>`, `github install` / `run`      | api.github.com, the URL you pass                                                                          | only when you run that command                                                                    | Only if you run it         | none                                                                                          |

<!-- offline-calls:end -->

## 4. Installing

### Prerequisites

- **Operating system:** Linux, macOS or Windows.
- **Node.js 18+** (for the npm method), or nothing beyond the OS for the standalone binary.
- **Outbound HTTPS** to your chosen model provider, and to `registry.npmjs.org` / `github.com` at install time.
- **An API key** from your chosen model provider.

### Method A — npm (recommended)

```sh
npm install -g lunos-ai --allow-scripts=lunos-ai
lunos --version
```

Verified against version **1.18.40** on npm 10 and npm 12: the package installs and the `lunos` command reports its version. npm 12 skips install scripts unless they're allowed, and without `--allow-scripts=lunos-ai` the postinstall that fetches the binary never runs, so `lunos` refuses to start. Earlier npm versions accept the flag.

### Method B — standalone binary

Download the archive for your platform from the [releases page](https://github.com/AxsionDev/Lunos/releases), extract it, and place the `lunos` binary on your `PATH`. Assets are named `lunos-<os>-<arch>`.

> **Binaries are not OS code-signed.** macOS Gatekeeper and Windows SmartScreen will warn when you first run them. You can still check that a download is genuine: see [Verify your download](#verify-your-download) below. To avoid the OS warning, install with Method A (npm), or allow the binary manually: on macOS, `xattr -d com.apple.quarantine ./lunos`; on Windows, "More info → Run anyway" in the SmartScreen dialog. See §7.

### Method C — build from source

For reviewers who require building from audited source. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) in the repository.

### Installing without internet access

From the next release, every release carries an **offline bundle** per platform, `lunos-offline-<os>-<arch>.tar.gz`. It contains:

- the CLI archive
- the model catalogue built into that release
- the SBOM
- the release's signed `SHA256SUMS`, with Sigstore signatures
- Sigstore's trusted root
- `INSTALL-OFFLINE.md`
- ripgrep and cosign builds for that platform, with `TOOLS.txt` recording each one's source URL and pinned checksum

Every Lunos file in the bundle except the trusted root is covered by the signed `SHA256SUMS`, so it can be verified without a network. The two tools are third-party builds: the release checks them against checksums pinned in Lunos's release script, and the signed `SHA256SUMS-offline` covers them as part of the bundle.

1. **On a machine with internet access,** verify the bundle against `SHA256SUMS-offline`, which is signed the same way. Then transfer it. A trust root shipped inside the bundle can't vouch for the bundle itself, so this is the step that establishes trust.
2. **On the offline machine,** unpack it and follow `INSTALL-OFFLINE.md`. The bundled cosign re-checks the signature and checksums there, offline. Then install the binary and the bundled `rg`.
3. **Set `LUNOS_OFFLINE=1`.** The `linux-arm64-musl` bundle has no `rg`, because ripgrep has no build for that platform: install it from your OS packages.

### Air-gapped deployment

With the offline bundle, a model server on your own network, and `LUNOS_OFFLINE=1`, Lunos runs with no route to the internet. Any OpenAI-compatible server works; vLLM and Ollama are the common ones.

**1. Run the model server** on a host the developer machines can reach. Load or pull the model while that host still has a network, or copy the weights in.

```bash
# vLLM
vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct --port 8000 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder
# Ollama (pull first, then move it into the isolated network)
ollama pull qwen3:4b && ollama serve
```

Lunos's agent works through tool calls, so choose a model that supports them and enable tool calling on the server (vLLM needs the two flags above). Give Ollama a context window of at least 16k tokens with `OLLAMA_CONTEXT_LENGTH=16384`; its default is too small for the agent's instructions.

**2. Point Lunos at it and declare its region,** so the residency policy allows it. In `opencode.json`, or in [managed config](#organisation-policy-settings-developers-cant-change) so developers can't change it:

```json
{
  "model": "ollama/qwen3:4b",
  "residency": {
    "allow": ["eu"],
    "endpoints": { "ollama": { "region": "eu", "note": "Ollama on gpu01, Sofia data centre" } }
  },
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama",
      "options": { "baseURL": "http://gpu01.internal:11434/v1" },
      "models": { "qwen3:4b": { "name": "Qwen3 4B", "tool_call": true } }
    }
  }
}
```

For vLLM, use `"baseURL": "http://<host>:8000/v1"` and the model name you served. The declaration is yours: Lunos can't check where the server is, and the audit log records these calls with basis `declared` ([data residency](../data-residency.md#self-hosted-models-and-other-endpoints-you-run)).

**3. Set `LUNOS_OFFLINE=1`** for every user, and check with `lunos run "say hello"`.

**What we tested (2026-09-28):** a Docker `--internal` network with no route out, holding an Ollama server (`qwen3:4b`, CPU only) and an Ubuntu 24.04 client. Lunos was installed on the client from an offline bundle as described above, with the configuration above and `LUNOS_OFFLINE=1`. It completed a task that wrote a Python file and ran it. Under `strace` and `tcpdump`, its only connections were to the Ollama server and the container's DNS resolver, and every DNS lookup was for the Ollama server's name. The audit log recorded each model call as `region: eu`, `basis: declared`, `allowed: true`. Run again without `LUNOS_OFFLINE`, Lunos also tried to resolve `models.opencode.ai` and `registry.npmjs.org`, the model catalogue and npm registry calls listed in [Every outbound call, and offline mode](#every-outbound-call-and-offline-mode), and nothing else. We didn't test vLLM or GPU inference; the vLLM settings above follow vLLM's documentation. A small model on CPU is slow (about 25 minutes for that task). A 3B model we tried wrote its tool calls as text instead of making them, and an 8B one ran out of the test machine's 8 GB of memory.

### Verify your download

Releases can be checked without trusting the download location. None of this needs a certificate from us.

**npm (Method A): provenance.** `lunos-ai` and its platform packages are published from this repository's GitHub Actions workflow with npm provenance (SLSA attestations) and registry signatures. In any directory:

```sh
npm init -y
npm install lunos-ai@<version> --ignore-scripts
npm audit signatures
```

Expected: `2 packages have verified registry signatures` and `2 packages have verified attestations` (`lunos-ai` and your platform's package). This was checked against 1.18.40. `--ignore-scripts` only skips the binary download, which the audit doesn't need.

**Release assets (Method B): signed checksums.** Starting with v1.18.40, each GitHub release also carries:

- `SHA256SUMS`: the SHA-256 of every asset on the release
- `SHA256SUMS.sigstore.json`: a [Sigstore](https://www.sigstore.dev/) signature bundle for `SHA256SUMS`, made keylessly by the release workflow
- `lunos-sbom-<version>.cdx.json.sigstore.json`: the same for the SBOM

With [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) installed, download `SHA256SUMS`, its bundle and your archive into one directory, then:

```sh
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/AxsionDev/Lunos/\.github/workflows/publish\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

sha256sum --check --ignore-missing SHA256SUMS      # Linux
shasum -a 256 --check --ignore-missing SHA256SUMS  # macOS
```

The first command proves `SHA256SUMS` was produced by this repository's release workflow and hasn't changed since. The second proves your archive matches it; a modified file fails with `FAILED`. The SBOM verifies the same way, with `--bundle lunos-sbom-<version>.cdx.json.sigstore.json` and the SBOM file in place of `SHA256SUMS`.

Releases up to and including 1.18.39 have no `SHA256SUMS`. For those, use Method A and `npm audit signatures`.

## 5. Configuring data residency

This is the control that makes "EU alternative" enforceable rather than advisory.

> [!WARNING]
> **Correction (2026-09-24): in Lunos v1.18.38 and earlier, the residency policy is not enforced for sessions.** With `"residency": {"allow": ["eu"]}` set, `lunos run` and the TUI still send model requests to non-EU providers, and no audit log is written. The policy was only wired into a code path that sessions don't use. **Fixed in v1.18.39 (2026-09-25):** sessions now enforce the policy and write the audit log. If you run v1.18.38 or earlier, upgrade before relying on this policy as a control; until you do, restrict providers with `enabled_providers` and by holding only EU providers' API keys. Tracked as XCOD-93.

The repository ships a reference configuration for exactly this deployment: [`examples/reference-deployment/opencode.json`](../../examples/reference-deployment/opencode.json). Copy it to `opencode.json` in your project directory, or to your global config directory to apply it to every project. A test decodes that file through the same config path `lunos` uses at startup, so it can't drift into describing keys the runtime ignores.

```json
{
  "$schema": "https://lunos.tech/config.json",
  "residency": {
    "allow": ["eu"],
    "audit": true
  },
  "enabled_providers": ["mistral"],
  "provider": {
    "mistral": {
      "options": {
        "apiKey": "{env:MISTRAL_API_KEY}"
      }
    }
  },
  "model": "mistral/mistral-large-latest",
  "small_model": "mistral/mistral-small-latest",
  "share": "disabled",
  "autoupdate": "notify"
}
```

Key by key:

| Key                               | Value                            | Why                                                                                                                                                                                                                                                                     |
| --------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `residency.allow`                 | `["eu"]`                         | The enforcement. Model requests may only go to providers that process data in the EU; anything else is refused before a connection is opened. Described in full below                                                                                                   |
| `residency.audit`                 | `true`                           | Records every outbound model call, and every refused one, to a local audit log. This is already the default once `residency` is set; it is written out so a reviewer doesn't have to know that                                                                          |
| `enabled_providers`               | `["mistral"]`                    | Loads only this provider. Defence in depth: the residency policy would refuse the others anyway, but they don't appear in the model list at all, so nobody picks one and gets an error                                                                                  |
| `provider.mistral.options.apiKey` | `"{env:MISTRAL_API_KEY}"`        | Mistral AI (France) processes in the EU; see [Model provider jurisdictions](../provider-jurisdictions.md). The key is read from the environment, so the file itself holds no secret and can be committed. Scaleway, OVHcloud or Hetzner work the same way (§5 table)    |
| `model`                           | `"mistral/mistral-large-latest"` | The main agent's model, on the provider above                                                                                                                                                                                                                           |
| `small_model`                     | `"mistral/mistral-small-latest"` | Used for titles and summaries. Set explicitly so it can't fall back to a model on another provider                                                                                                                                                                      |
| `share`                           | `"disabled"`                     | Already the default. Set explicitly so a later config layer or a copy of this file can't turn sharing on without it showing in review. See [Session sharing](#session-sharing--off-by-default)                                                                          |
| `autoupdate`                      | `"notify"`                       | Lunos tells you when a new release exists but never installs one without a person choosing it. A procurement reviewer should expect updates to be a decision, not a side effect. The check itself is a network call on every start; set `false` to turn it off entirely |

To confirm the policy is active, run `lunos debug config` in that directory. The resolved config it prints includes `"residency": { "allow": ["eu"], "audit": true }`.

With that in place:

- **Only providers that process data in the EU may be used.** Any other provider is blocked before a request is made — not warned about, not logged-and-permitted.
- **Every outbound model call is recorded** to a local audit log with timestamp, provider, jurisdiction and destination host. Blocked attempts are recorded too. The log never contains request contents.
- **Providers whose region cannot be verified are denied,** including ones that _could_ be EU (Azure, AWS Bedrock, Google Vertex). Their region is a choice made in your cloud account, which the software cannot inspect — so permitting them automatically would let an unverified US-region resource pass a policy claiming to enforce EU residency. You may opt in explicitly once you have verified the region.
- **Providers with no recorded jurisdiction are always denied.**
- **Subagents are checked too.** A subagent's model is checked against the policy before the subagent starts. If you assign models to subagents, keep them on EU providers with per-type settings: for example `"agent": { "explore": { "model": "small" } }`, where `small_model` is also an EU provider. See "Choosing models for subagents" in the agents documentation.

Full reference, including the audit log format and how to opt into configurable providers: [Data residency controls](../data-residency.md).

### EU-resident providers available today

| Provider | Country | API key variable   |
| -------- | ------- | ------------------ |
| Mistral  | France  | `MISTRAL_API_KEY`  |
| Scaleway | France  | `SCALEWAY_API_KEY` |
| OVHcloud | France  | `OVHCLOUD_API_KEY` |
| Hetzner  | Germany | `HETZNER_API_KEY`  |

Each is an EU-incorporated company processing in the EU. Per-provider detail, and what "EU" rests on in each case, is in [Model provider jurisdictions](../provider-jurisdictions.md).

### Organisation policy: settings developers can't change

**From v1.18.40.**

To set company-wide settings and stop developers turning them off, put a policy file in a system
location only administrators can write: `/etc/lunos/managed.json` (Linux),
`/Library/Application Support/Lunos/managed.json` or an MDM profile in the `tech.lunos.managed`
domain (macOS), or `%ProgramData%\Lunos\managed.json` (Windows). No server is involved.

Keys listed under `$locked` take their value from the policy only. User and project config,
environment variables such as `OPENCODE_AUTO_SHARE`, CLI flags such as `lunos run --share`, and
in-session commands such as `/share` can't change them; each attempt says "_&lt;key&gt; is set by your
organisation's policy_". A locked key the policy doesn't set falls back to the Lunos default.
`marketplace_allow`, when locked, is the only list of marketplace sources that may be used; the
built-in catalogue counts as one.

A sample policy with a macOS profile and Windows and Linux deployment notes is in
[`examples/managed-policy/`](../../examples/managed-policy/). To check a machine, run
`lunos debug config --sources`: it shows which layer set each key and which are locked.

**Locking permissions** (XCOD-202, unreleased). `"$locked": ["permission.webfetch"]` with
`"permission": { "webfetch": "ask" }` fixes one tool's rule; `"$locked": ["permission"]` fixes all
of them. A locked rule holds wherever another rule would otherwise win: a later `"*": "allow"` in
user or project config, an agent's own `permission`, `OPENCODE_PERMISSION` and
`OPENCODE_CONFIG_CONTENT`. Under a lock, an agent's own rule for that tool (under `"permission"`,
all of an agent's `permission`) comes from the policy only. Refused config values are in the audit
log as `policy.override_refused`; a user config that repeats the policy's rule isn't. A lock never
loosens what Lunos itself restricts: a built-in deny (the plan agent's edits, tools a subagent isn't
given) still denies, and agents can still read their own truncated tool output unless the policy
names that directory. A lock fixes the configured rule, not the developer's answers: on a locked
`"ask"`, "always allow" still holds, for every session in that project until Lunos restarts, and
`--auto` (`--yolo`, `--dangerously-skip-permissions`) still answers. Neither is ever written to
config, and neither can lift a locked `"deny"`. Every answer is in the audit log as
`permission.decision`. Lock a tool with a value: a locked tool the policy doesn't set falls back to
the default, which a wildcard rule elsewhere can still change.

**Requiring sandboxed runs** (XCOD-157, unreleased). `"$locked": ["sandbox.required"]` with
`"sandbox": { "required": true }` means nothing runs on developers' machines except in a Docker
sandbox: `lunos` and `lunos run` start one automatically, `lunos serve`, `web`, `acp`, `github` and
`pr` refuse to start, and any agent tool call outside a sandbox is refused. The policy itself is
copied into each sandbox, read-only, so its other locked keys (a residency policy, for example) hold
inside too. See [sandboxed runs](../sandboxed-runs.md#requiring-sandboxes-organisations).

A sandbox's own network is limited by `sandbox.network` (default `"policy"`): only the model
endpoints your residency policy allows, remote MCP servers, the npm registry and `sandbox.allow`,
enforced by an egress proxy container outside the sandbox, with each connection in the audit log
as `sandbox.egress`. Lock `sandbox` in managed config to fix the mode and allow list for everyone.
Starting a sandbox pulls `ghcr.io/axsiondev/lunos:<version>` when it isn't already on the machine;
mirror it to your registry and set `sandbox.image` in global or managed config for machines
without access to ghcr.io (the egress proxy then runs from your mirror too). See
[sandboxed runs](../sandboxed-runs.md#network).

`sandbox.workspace: "mount"` (XCOD-158, unreleased) bind-mounts a developer's working tree into the
sandbox instead of copying it: weaker isolation, so only global and managed config can choose it,
and under a managed `sandbox.required` only managed config. To keep everyone on copies, set
`"sandbox": { "workspace": "copy" }` in managed config and lock `sandbox`. `sandbox.mounts` (extra
read-only directories, e.g. a shared package cache) follows the same rule. See
[sandboxed runs](../sandboxed-runs.md#mounting-your-working-tree-reduced-isolation).

A project's devcontainer image (XCOD-158, unreleased) becomes its sandbox's toolchain, with Lunos
added from the Lunos image (your mirror, if `sandbox.image` points at one). A devcontainer that
builds from a Dockerfile is built only with `"sandbox": { "devcontainer": "build" }` in global or
managed config, since building runs the repository's own steps on the developer's machine. Lock
`"devcontainer": "off"` to rule devcontainers out. See
[sandboxed runs](../sandboxed-runs.md#the-projects-devcontainer).

### External memory database

From XCOD-134 (unreleased), long-term memory can live in a Neo4j database your team runs, instead of on each developer's machine. A team then shares project memory, backs it up with its normal database tooling, and decides where the data sits.

```jsonc
"memory": {
  "enabled": true,
  "scope": ["project", "user"],
  "backend": {
    "type": "neo4j",                              // "embedded" (the default) | "neo4j" | "memgraph" (refused: not supported yet)
    "url": "bolt+s://graph.internal:7687",        // TLS; plain bolt:// only to localhost
    "username": "{env:LUNOS_MEMORY_DB_USER}",     // {env:} or {file:} only: a literal is refused at load
    "password": "{file:~/.config/lunos/neo4j-password}",
    "jurisdiction": "EU-DE",                      // required; checked against the residency policy
    "database": "neo4j",                          // optional: the server's default database
    "read_only": false                            // true: recall only, no remember tool
    // "allow_insecure": true                     // plain bolt:// to another host, with a warning
    // "user": "alice@example.com"                // who you are for user memory (hashed); default: a random per-machine id
  }
}
```

**Checked before anything connects.** When memory starts, Lunos refuses the backend, without opening a socket or loading the database driver, if:

- no `jurisdiction` is declared;
- a residency policy is set and doesn't allow the jurisdiction's region (`EU`, `EU-DE` or an EU country code count as `eu`, `US` or `US-…` as `us`, anything else as `other`). The refusal names `memory.backend` and is written to the audit log as `memory.denied`;
- the URL is plain `bolt://` or `neo4j://` to a host that isn't this machine, unless `allow_insecure` is set. `lunos memory status` then shows a warning. `+ssc` is encrypted but doesn't verify the certificate, and says so;
- the URL has credentials in it, or `memory.encryption` is `"os-keychain"`. That key is in one person's keychain, and the database is shared, so encrypt at rest on the server instead.

`memory.enabled: false`, `LUNOS_DISABLE_MEMORY=1` or `/memory off` mean no connection is opened at all. That includes `lunos memory status` and `list`, which then say memory is off instead of reading the database.

**Credentials** are accepted only as `{env:VAR}` or `{file:path}` references. A literal username or password in any config layer fails config loading with a pointer here. The message names the key, never the value.

**Neo4j, and APOC.** Lunos talks to Neo4j 5 directly over Bolt, with the official JavaScript driver. It creates one uniqueness constraint, one index and one full-text index on its own label, `:LunosMemoryFact`, and doesn't use APOC. Cognee's own Neo4j adapter, which Lunos doesn't use here, requires the APOC plugin; you only need it if you run Cognee against the same server yourself. Neo4j Community Edition has one user database, so leave `database` unset there. Give Lunos a database user that can create constraints and indexes the first time; after that, a user with read and write access is enough, or read access with `read_only: true`.

**What data lives where:**

| Where              | What                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Neo4j database | One `:LunosMemoryFact` node per fact: its text, its provenance (session id, agent, source, date), lifecycle (status, kind, expiry, replacement links), its scope, a namespace, and a SHA-256 of its record. This **is** the ledger in external mode. The namespace is `project:<SHA-256 of the repository's git remote>` or `user:<SHA-256 of the user id>`, never a local path |
| Each machine       | Nothing memory-related but `memory/user.id` in the Lunos data directory (a random id, if you don't set `user`), and the hand-written notes in `.opencode/memory/*.md`, which stay in the repository and are **not** copied into the database                                                                                                                                    |
| Nowhere            | Embeddings and an entity graph. External memory stores facts only, and recall uses the database's own full-text index. Nothing is computed on one machine that a second one would have to re-index, and remembering a fact makes no model call                                                                                                                                  |

**Scopes in a shared database.** Project memory is keyed by the repository's `origin` remote (normalised, so `git@host:org/repo.git` and `https://host/org/repo` are the same project); a project with no remote can't use project memory in an external database. Everyone working on the same repository shares its project memory, and recall in one project never returns another project's facts. Every query filters on the namespace in the database. User memory is keyed by `user`, or a random id kept on the machine, so Lunos never recalls one person's user memory for another, nor on your own other machines unless you set `user` on each.

**Namespaces keep recall apart; they are not access control.** Anyone with the database's credentials, which in a team setup is usually everyone, can query the database directly and read every project's memory and every user's user memory. A hashed `user` value that is guessable (an email address) can be linked back to its person. There is no mixed mode that keeps user memory on the machine while project memory is external: with `memory.backend` set, both scopes are in the database. If user memory must stay private, leave `"user"` out of `memory.scope`, or give each person separate database credentials and a database only they can read.

**Moving existing memory:** `lunos memory migrate --to neo4j` exports this machine's embedded memory as a bundle, then imports it into the database with the same preview and write guard as `lunos memory import`. Facts keep their ids and provenance. Run it once without `--yes` to see the preview. The embedded memory is left as it is; delete it with `lunos memory purge` once you have checked the database. `lunos memory status` shows the backend, whether it can be reached, and each scope's fact count and last write.

**Integrity.** Each node carries a SHA-256 of its record. A node whose record, text or namespace no longer matches is quarantined: listed by `lunos memory verify`, never recalled. Like the local ledger's hashes, these catch damage and naive edits, not someone with write access who recomputes them. Anyone with the database's credentials can write facts that every user of that project will recall. Treat database write access like commit access, and give readers `read_only: true`.

A Docker Compose example for a single Neo4j server (put TLS in front of it, or use `bolt+s://` with Neo4j's own TLS, before other machines connect):

```yaml
# docker-compose.yml
services:
  neo4j:
    image: neo4j:5
    restart: unless-stopped
    ports:
      - "127.0.0.1:7687:7687" # Bolt; expose it beyond this host only over TLS
    environment:
      NEO4J_AUTH_FILE: /run/secrets/neo4j_auth # contains: neo4j/<password>
    secrets:
      - neo4j_auth
    volumes:
      - neo4j-data:/data
secrets:
  neo4j_auth:
    file: ./neo4j_auth.txt
volumes:
  neo4j-data:
```

Back up the `neo4j-data` volume, or run `neo4j-admin database dump`, like any other database. `lunos memory export` from any machine is also a full, portable copy of that project's facts.

## 6. What you need to provide

| You provide                          | Notes                                                   |
| ------------------------------------ | ------------------------------------------------------- |
| Machines to run it on                | Developer workstations or a server you operate          |
| A model provider account and API key | Your contract with them; see §5 for EU options          |
| Network egress to that provider      | The only required outbound path at runtime              |
| Storage for local state              | Sessions, config and audit log are ordinary local files |
| Your own backup and retention policy | Lunos does not manage retention of local state          |

Lunos requires no database, no message broker and no inbound network access. An external memory database is optional (see [External memory database](#external-memory-database)). Server mode exists and is **opt-in only**; leave it off unless you need it, and set a password if you enable it (see [`SECURITY.md`](../../SECURITY.md)).

## 7. Known limitations — stated, not buried

- **The residency policy is not enforced for sessions in v1.18.38 and earlier.** See the correction in §5. It is enforced from v1.18.39; on older versions the policy is advisory only.
- **Binaries are not OS code-signed** on any platform: no Apple Developer ID or notarization, no Windows Authenticode. Gatekeeper and SmartScreen will warn. What you _can_ verify is that a download came from this repository's release workflow unchanged: npm provenance for the npm packages, and a Sigstore-signed `SHA256SUMS` for the release archives (see [Verify your download](#verify-your-download)). OS signing needs certificates that haven't been bought; it's deferred, not dropped.
- **No security certification is held.** Lunos holds no CRA, EUCS, ISO or SOC certification and claims none. On the project's current assessment it falls outside the scope of the EU Cyber Resilience Act entirely, because it is free, MIT-licensed, self-hosted and unmonetised. A CycloneDX **software bill of materials is published with each release** as manufacturer-readiness groundwork, not as a compliance claim.
- **The agent is not sandboxed by default.** Lunos can execute shell commands and modify files. Its permission system is a UX safeguard that prompts before acting — it is _not_ a security boundary. This is inherited from upstream and documented in [`SECURITY.md`](../../SECURITY.md). `lunos run --sandbox` / `lunos --sandbox` run the agent in a locked-down Docker container with the project copied in, and hand the results back as a branch ([Sandboxed runs](../sandboxed-runs.md)); that container shares the host kernel and does not yet restrict network egress, so for untrusted code where that matters, use a VM.
- **Model provider data handling is governed by your agreement with that provider,** not by Lunos. Residency controls determine _which_ provider may be used; they do not alter what that provider does with what it receives.
- **Allowing a self-hosted share server is coarse.** `enterprise.url` counts as `unknown`, so allowing it with `"unknown"` also allows other endpoints whose region can't be determined, such as gateways and generic OpenAI-compatible endpoints. There is no per-host allow list yet. Leave sharing off (the default) if that's too broad.
- **A self-hosted endpoint's region is your declaration, not something Lunos verifies.** From v1.18.41 you allow a self-hosted model under a residency policy by declaring its region in `residency.endpoints` ([data residency](../data-residency.md#self-hosted-models-and-other-endpoints-you-run)). The audit log records those calls with basis `declared`, so a reviewer can tell them from recorded facts. Lock the declaration in managed config.
- **Feature parity with upstream opencode is not claimed or measured.**

## 8. Questions a reviewer usually asks next

**Can it run fully air-gapped?** Not with a hosted model provider: model inference needs egress. Against a self-hosted, OpenAI-compatible model endpoint on your own network, set `LUNOS_OFFLINE=1` ([offline mode](#every-outbound-call-and-offline-mode)) and Lunos contacts only that endpoint and anything else you configured. To keep a residency policy on, declare the endpoint's region in `residency.endpoints` (from v1.18.41); otherwise the policy refuses it, because Lunos can't know where it runs. See [Air-gapped deployment](#air-gapped-deployment). To install without internet access, use the offline bundle (see [Installing without internet access](#installing-without-internet-access)).

**Does the vendor receive telemetry?** No. There is no Lunos-operated endpoint receiving data from your deployment.

**What happens if the project is abandoned?** It is MIT-licensed and the full source is public. You may fork, build and maintain it without our involvement — the same property that let Lunos itself fork from opencode.

**Who is accountable?** ITService EOOD, a Bulgarian legal person. Note that MIT-licensed software is provided without warranty; a support arrangement, if you need one, would be a separate commercial agreement and does not exist today.

---

_This document is maintained in the Lunos repository. The sovereignty claim table and wording rules in §2 are reproduced from the project's sovereignty decision record; if the two ever disagree, that record is the source of truth and this document is the bug._
