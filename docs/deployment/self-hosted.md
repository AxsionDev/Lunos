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

The tool also fetches its model catalogue (a list of available models and their capabilities — no prompt data) over the network, and checks for updates unless disabled.

**The update check** reads the `lunos-ai` package entry from your npm registry: `https://registry.npmjs.org/lunos-ai/latest` by default, or whatever registry your npm configuration points at, so a corporate or EU mirror is honoured. It sends no project data, and runs at most once a day; the result is cached in Lunos's state directory. Lunos only _announces_ new releases. It never installs one unless a person chooses to, or you set `"autoupdate": true`. To turn the check off entirely, set `"autoupdate": false` or the environment variable `LUNOS_DISABLE_AUTOUPDATE=1`.

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
- The audit log: model calls and share uploads (v1.18.39); tool runs, permission decisions, installs and policy refusals from the next release. No prompt or file contents (§5, and [The audit log](../audit-log.md)). It leaves the machine only if you configure forwarding to your own SIEM

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

Verified against version **1.18.39** on npm 10 and npm 12: the package installs and the `lunos` command reports its version. npm 12 skips install scripts unless they're allowed, and without `--allow-scripts=lunos-ai` the postinstall that fetches the binary never runs, so `lunos` refuses to start. Earlier npm versions accept the flag.

### Method B — standalone binary

Download the archive for your platform from the [releases page](https://github.com/AxsionDev/Lunos/releases), extract it, and place the `lunos` binary on your `PATH`. Assets are named `lunos-<os>-<arch>`.

> **Binaries are not OS code-signed.** macOS Gatekeeper and Windows SmartScreen will warn when you first run them. You can still check that a download is genuine: see [Verify your download](#verify-your-download) below. To avoid the OS warning, install with Method A (npm), or allow the binary manually: on macOS, `xattr -d com.apple.quarantine ./lunos`; on Windows, "More info → Run anyway" in the SmartScreen dialog. See §7.

### Method C — build from source

For reviewers who require building from audited source. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) in the repository.

### Verify your download

Releases can be checked without trusting the download location. None of this needs a certificate from us.

**npm (Method A): provenance.** `lunos-ai` and its platform packages are published from this repository's GitHub Actions workflow with npm provenance (SLSA attestations) and registry signatures. In any directory:

```sh
npm init -y
npm install lunos-ai@<version> --ignore-scripts
npm audit signatures
```

Expected: `2 packages have verified registry signatures` and `2 packages have verified attestations` (`lunos-ai` and your platform's package). This was checked against 1.18.39. `--ignore-scripts` only skips the binary download, which the audit doesn't need.

**Release assets (Method B): signed checksums.** Starting with the first release after 1.18.39, each GitHub release also carries:

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
  "$schema": "https://opencode.ai/config.json",
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

| Key                               | Value                            | Why                                                                                                                                                                                                                                                                  |
| --------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `residency.allow`                 | `["eu"]`                         | The enforcement. Model requests may only go to providers that process data in the EU; anything else is refused before a connection is opened. Described in full below                                                                                                |
| `residency.audit`                 | `true`                           | Records every outbound model call, and every refused one, to a local audit log. This is already the default once `residency` is set; it is written out so a reviewer doesn't have to know that                                                                       |
| `enabled_providers`               | `["mistral"]`                    | Loads only this provider. Defence in depth: the residency policy would refuse the others anyway, but they don't appear in the model list at all, so nobody picks one and gets an error                                                                               |
| `provider.mistral.options.apiKey` | `"{env:MISTRAL_API_KEY}"`        | Mistral AI (France) processes in the EU; see [Model provider jurisdictions](../provider-jurisdictions.md). The key is read from the environment, so the file itself holds no secret and can be committed. Scaleway, OVHcloud or Hetzner work the same way (§5 table) |
| `model`                           | `"mistral/mistral-large-latest"` | The main agent's model, on the provider above                                                                                                                                                                                                                        |
| `small_model`                     | `"mistral/mistral-small-latest"` | Used for titles and summaries. Set explicitly so it can't fall back to a model on another provider                                                                                                                                                                   |
| `share`                           | `"disabled"`                     | Already the default. Set explicitly so a later config layer or a copy of this file can't turn sharing on without it showing in review. See [Session sharing](#session-sharing--off-by-default)                                                                       |
| `autoupdate`                      | `"notify"`                       | Lunos tells you when a new release exists but never installs one without a person choosing it. A procurement reviewer should expect updates to be a decision, not a side effect. The check itself is a network call; set `false` to turn it off entirely             |

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

**From the next release; not in v1.18.39.**

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

## 6. What you need to provide

| You provide                          | Notes                                                   |
| ------------------------------------ | ------------------------------------------------------- |
| Machines to run it on                | Developer workstations or a server you operate          |
| A model provider account and API key | Your contract with them; see §5 for EU options          |
| Network egress to that provider      | The only required outbound path at runtime              |
| Storage for local state              | Sessions, config and audit log are ordinary local files |
| Your own backup and retention policy | Lunos does not manage retention of local state          |

Lunos requires no database, no message broker and no inbound network access. Server mode exists and is **opt-in only**; leave it off unless you need it, and set a password if you enable it (see [`SECURITY.md`](../../SECURITY.md)).

## 7. Known limitations — stated, not buried

- **The residency policy is not enforced for sessions in v1.18.38 and earlier.** See the correction in §5. It is enforced from v1.18.39; on older versions the policy is advisory only.
- **Binaries are not OS code-signed** on any platform: no Apple Developer ID or notarization, no Windows Authenticode. Gatekeeper and SmartScreen will warn. What you _can_ verify is that a download came from this repository's release workflow unchanged: npm provenance for the npm packages, and a Sigstore-signed `SHA256SUMS` for the release archives (see [Verify your download](#verify-your-download)). OS signing needs certificates that haven't been bought; it's deferred, not dropped.
- **No security certification is held.** Lunos holds no CRA, EUCS, ISO or SOC certification and claims none. On the project's current assessment it falls outside the scope of the EU Cyber Resilience Act entirely, because it is free, MIT-licensed, self-hosted and unmonetised. A CycloneDX **software bill of materials is published with each release** as manufacturer-readiness groundwork, not as a compliance claim.
- **The agent is not sandboxed.** Lunos can execute shell commands and modify files. Its permission system is a UX safeguard that prompts before acting — it is _not_ a security boundary. For true isolation, run it in a container or VM. This is inherited from upstream and documented in [`SECURITY.md`](../../SECURITY.md).
- **Model provider data handling is governed by your agreement with that provider,** not by Lunos. Residency controls determine _which_ provider may be used; they do not alter what that provider does with what it receives.
- **Allowing a self-hosted share server is coarse.** `enterprise.url` counts as `unknown`, so allowing it with `"unknown"` also allows other endpoints whose region can't be determined, such as gateways and generic OpenAI-compatible endpoints. There is no per-host allow list yet. Leave sharing off (the default) if that's too broad.
- **Feature parity with upstream opencode is not claimed or measured.**
- **A vulnerability disclosure process exists** ([`SECURITY.md`](../../SECURITY.md)) but there is no dedicated security contact address yet; reports go through GitHub Security Advisories, which is private to maintainers.

## 8. Questions a reviewer usually asks next

**Can it run fully air-gapped?** Not with a hosted model provider — model inference requires egress. It can run against a self-hosted, OpenAI-compatible model endpoint on your own network, in which case egress can be confined to your perimeter. Such an endpoint is untagged by default and a residency policy will deny it until you record its jurisdiction.

**Does the vendor receive telemetry?** No. There is no Lunos-operated endpoint receiving data from your deployment.

**What happens if the project is abandoned?** It is MIT-licensed and the full source is public. You may fork, build and maintain it without our involvement — the same property that let Lunos itself fork from opencode.

**Who is accountable?** ITService EOOD, a Bulgarian legal person. Note that MIT-licensed software is provided without warranty; a support arrangement, if you need one, would be a separate commercial agreement and does not exist today.

---

_This document is maintained in the Lunos repository. The sovereignty claim table and wording rules in §2 are reproduced from the project's sovereignty decision record; if the two ever disagree, that record is the source of truth and this document is the bug._
