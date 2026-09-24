# Self-hosted deployment guide

For procurement, security and compliance reviewers evaluating Lunos, and for the administrator who will deploy it.

Written to be read without any familiarity with the codebase. It states what Lunos is, exactly where data goes, what the EU-sovereignty claim does and does not cover, and how to deploy it under a data-residency policy.

---

## 1. What Lunos is

An AI coding assistant that runs as a command-line tool on a developer's machine or on a server you operate. It sends coding prompts to a large language model of your choosing and applies the results to files in your repository.

It is a fork of the open-source project [opencode](https://github.com/anomalyco/opencode), maintained by **ITService EOOD** (Bulgaria, UIC 201069485). MIT licensed.

**The deployment model is self-hosted.** You install it on infrastructure you control. There is no Lunos-operated service involved in running it, and no account to create with us.

## 2. What is true today — the sovereignty claim, stated precisely

This is the claim table maintained in the project's own sovereignty decision record. It is reproduced here without softening.

| Claim                                                          | True today?            | Basis                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The vendor is EU-incorporated                                  | **Yes**                | ITService EOOD, Bulgaria, UIC 201069485                                                                                                                            |
| The vendor is outside non-EU compulsory-disclosure reach       | **Yes**                | Bulgarian legal person; not a US-parented subsidiary                                                                                                               |
| Lunos can be run entirely on infrastructure the buyer controls | **Yes**                | Self-hosted is the shipping distribution model                                                                                                                     |
| Lunos is provider-agnostic for model routing                   | **Yes**                | Inherited from opencode                                                                                                                                            |
| _Lunos-operated_ infrastructure is EU-sovereign                | **N/A**                | There is no Lunos-operated production infrastructure for customers                                                                                                 |
| EU-specific functionality exists in the build                  | **Yes, as of Phase 1** | Provider jurisdiction metadata and enforceable data-residency controls — see §5. Previously "No"; this row changed when those shipped and is the only row that has |

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

#### Session sharing — off by default

`/share` publishes a session at a public link. **Lunos turns this off unless you enable it**, because a shared session contains the whole transcript: your prompts, the contents of every file the agent read, and tool output. That is more sensitive than any single model request.

| Setting               | What happens                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `share` unset         | Same as `"disabled"`. This differs from upstream opencode, where `/share` works out of the box     |
| `"share": "disabled"` | `/share` is refused with a message saying how to enable it. Nothing is uploaded                    |
| `"share": "manual"`   | `/share` uploads the session when a person runs it                                                 |
| `"share": "auto"`     | Every new session is uploaded as it is created. The deprecated `"autoshare": true` also means this |

When sharing is on, uploads go to `enterprise.url` if you set one, and otherwise to **`https://opncd.ai`**, upstream opencode's hosted share service. That host is operated by a non-EU third party, not by Lunos, and **is not covered by the residency policy** (§5, §7). The `OPENCODE_AUTO_SHARE` environment variable only turns `"manual"` into `"auto"`; it cannot re-enable sharing that is disabled.

### Stays on your infrastructure

Everything else:

- Your source code, except the portions sent to your chosen model provider as context
- Conversation history and session state, stored in local files
- Configuration and credentials, stored locally
- The data-residency audit log (§5)

### Touches Lunos-operated infrastructure

**Nothing.** There is no Lunos-operated production infrastructure in the data path, because there is no hosted offering. Nothing is sent to ITService EOOD, and there is no telemetry endpoint we operate for you to disable.

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
npm install -g lunos-ai
lunos --version
```

Verified against version **1.18.35**: the package installs and the `lunos` command reports its version.

### Method B — standalone binary

Download the archive for your platform from the [releases page](https://github.com/AxsionDev/Lunos/releases), extract it, and place the `lunos` binary on your `PATH`. Assets are named `lunos-<os>-<arch>`.

> **Binaries are not code-signed on any platform.** macOS Gatekeeper and Windows SmartScreen will warn, and release artifacts cannot currently be verified by signature. This is a known and tracked limitation — see §7. If signature verification is a procurement requirement, Method A or building from source is the better route today.

### Method C — build from source

For reviewers who require building from audited source. See [`CONTRIBUTING.md`](../../CONTRIBUTING.md) in the repository.

## 5. Configuring data residency

This is the control that makes "EU alternative" enforceable rather than advisory.

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

Full reference, including the audit log format and how to opt into configurable providers: [Data residency controls](../data-residency.md).

### EU-resident providers available today

| Provider | Country | API key variable   |
| -------- | ------- | ------------------ |
| Mistral  | France  | `MISTRAL_API_KEY`  |
| Scaleway | France  | `SCALEWAY_API_KEY` |
| OVHcloud | France  | `OVHCLOUD_API_KEY` |
| Hetzner  | Germany | `HETZNER_API_KEY`  |

Each is an EU-incorporated company processing in the EU. Per-provider detail, and what "EU" rests on in each case, is in [Model provider jurisdictions](../provider-jurisdictions.md).

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

- **Binaries are not code-signed** on any platform. Tracked; blocked on code-signing credentials.
- **No security certification is held.** Lunos holds no CRA, EUCS, ISO or SOC certification and claims none. On the project's current assessment it falls outside the scope of the EU Cyber Resilience Act entirely, because it is free, MIT-licensed, self-hosted and unmonetised. A CycloneDX **software bill of materials is published with each release** as manufacturer-readiness groundwork, not as a compliance claim.
- **The agent is not sandboxed.** Lunos can execute shell commands and modify files. Its permission system is a UX safeguard that prompts before acting — it is _not_ a security boundary. For true isolation, run it in a container or VM. This is inherited from upstream and documented in [`SECURITY.md`](../../SECURITY.md).
- **Model provider data handling is governed by your agreement with that provider,** not by Lunos. Residency controls determine _which_ provider may be used; they do not alter what that provider does with what it receives.
- **Session sharing, if you turn it on, is not covered by the residency policy.** With `"share": "manual"` or `"auto"`, `/share` uploads the full transcript to `opncd.ai` (or your `enterprise.url`) whatever `residency.allow` says, and no audit-log entry is written. Sharing is off by default; leave it off under a residency policy. Putting share uploads under the policy is tracked as XCOD-80.
- **Feature parity with upstream opencode is not claimed or measured.**
- **A vulnerability disclosure process exists** ([`SECURITY.md`](../../SECURITY.md)) but there is no dedicated security contact address yet; reports go through GitHub Security Advisories, which is private to maintainers.

## 8. Questions a reviewer usually asks next

**Can it run fully air-gapped?** Not with a hosted model provider — model inference requires egress. It can run against a self-hosted, OpenAI-compatible model endpoint on your own network, in which case egress can be confined to your perimeter. Such an endpoint is untagged by default and a residency policy will deny it until you record its jurisdiction.

**Does the vendor receive telemetry?** No. There is no Lunos-operated endpoint receiving data from your deployment.

**What happens if the project is abandoned?** It is MIT-licensed and the full source is public. You may fork, build and maintain it without our involvement — the same property that let Lunos itself fork from opencode.

**Who is accountable?** ITService EOOD, a Bulgarian legal person. Note that MIT-licensed software is provided without warranty; a support arrangement, if you need one, would be a separate commercial agreement and does not exist today.

---

_This document is maintained in the Lunos repository. The sovereignty claim table and wording rules in §2 are reproduced from the project's sovereignty decision record; if the two ever disagree, that record is the source of truth and this document is the bug._
