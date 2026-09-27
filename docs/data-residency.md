# Data residency controls

Restrict which jurisdictions this deployment may send model requests to, and keep an audit log of what actually left.

Intended for regulated and public-sector deployments where "we told everyone to pick an EU model" is not an adequate control. Companion to [Model provider jurisdictions](provider-jurisdictions.md), which records where each provider processes data.

> [!WARNING]
> **Correction (2026-09-24): in Lunos v1.18.38 and earlier, the residency policy is not enforced for sessions.** With `"residency": {"allow": ["eu"]}` set, `lunos run` and the TUI still send model requests to non-EU providers, and no audit log is written. The policy was only wired into a code path that sessions don't use. **Fixed in v1.18.39 (2026-09-25):** sessions now enforce the policy and write the audit log. If you run v1.18.38 or earlier, upgrade before relying on this policy as a control; until you do, restrict providers with `enabled_providers` and by holding only EU providers' API keys. Tracked as XCOD-93.

## The shortest useful config

```json
{
  "residency": {
    "allow": ["eu"]
  }
}
```

That is the whole feature for most deployments. It means:

- Only providers that process data in the EU may be used. Anything else is **blocked before any request is made** — not warned about, not logged-and-allowed.
- Every outbound model call is recorded to an audit log. Auditing switches on automatically with the policy; you do not need a second setting.

**With no `residency` block in config, none of this is active** — no enforcement, no logging, no added per-request work.

## What gets blocked

Enforcement happens when a model is resolved, before any connection to the provider. There is no path to a model that skips the check, so this cannot be bypassed by selecting a model through a different surface.

| Situation                                                                                   | Under `"allow": ["eu"]` | Why                                                                        |
| ------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| Provider processes in the EU (Mistral, Scaleway, OVHcloud, Hetzner)                         | **Allowed**             | Both the vendor and the processing are in the EU                           |
| Provider processes outside the EU (Anthropic, OpenAI, Groq…)                                | **Blocked**             | Outside the allowed region                                                 |
| Provider's region depends on configuration (Azure, AWS Bedrock, Google Vertex, SAP AI Core) | **Blocked**             | See below                                                                  |
| Provider is a gateway (OpenRouter, Vercel AI Gateway…)                                      | **Blocked**             | Routes onward to other providers; no single jurisdiction can be guaranteed |
| Provider has no recorded jurisdiction                                                       | **Blocked**             | Never assessed, so never assumed safe                                      |

### Why configurable providers are blocked by default

Azure, AWS Bedrock, Google Vertex and SAP AI Core can all run in the EU. The software cannot verify that _this_ deployment pointed them at an EU region — that lives in your cloud account, not in configuration Lunos can read.

Allowing them automatically would mean a US-region Azure resource passes a policy that claims to enforce EU residency, and the policy would report success while being untrue. So they are denied unless you opt in deliberately:

```json
{
  "residency": {
    "allow": ["eu", "configurable"]
  }
}
```

Opting in is a statement that **you** have verified the region. [Model provider jurisdictions](provider-jurisdictions.md) lists, per provider, exactly what to set — for example `AWS_REGION=eu-central-1` for Bedrock, or a `europe-*` location for Vertex.

## Allowed values

`eu`, `us`, `other`, `configurable`, `unknown`.

`unknown` covers providers assessed as indeterminable — gateways, and the generic OpenAI-compatible adapter pointed at an endpoint of your choosing. Allowing it is a deliberate widening. It does **not** permit providers that were never assessed at all; those are always denied.

## Session sharing

Share uploads are checked like model calls. `opncd.ai` (upstream's share service) counts as `us`. A self-hosted share server at `enterprise.url` counts as `unknown`, like any self-hosted endpoint, so you allow it with `"unknown"`. Refused and allowed share uploads both appear in the audit log with a `share:` provider id (`share:opncd`, `share:enterprise`). Sharing is off by default; see the deployment guide.

## The audit log

One JSON object per line, appended per outbound call:

```json
{
  "v": 1,
  "event": "model.call",
  "timestamp": "2026-09-21T12:00:00.000Z",
  "providerID": "scaleway",
  "region": "eu",
  "basis": "both",
  "host": "api.scaleway.ai",
  "allowed": true,
  "seq": 42,
  "prev": "9f86d0…"
}
```

From v1.18.40 (schema v1, XCOD-103; v1.18.39 and earlier write the residency fields only, without `v`, `event`, `seq` and `prev`), this file is the organisation audit trail: the same stream also records
tool runs, permission decisions, MCP connections, marketplace installs and policy refusals, and
each line is hash-chained to the one before it. The residency fields above are unchanged; `v`,
`event`, `seq` and `prev` are added. Lines written before v1 have none of the added fields. The
full schema, `lunos audit verify`, export and SIEM forwarding are in [The audit log](audit-log.md).

Default location is `~/.local/share/opencode/log/residency-egress.log` (or `$XDG_DATA_HOME/opencode/log/` when that is set), on every platform. The directory is named `opencode` because Lunos keeps upstream's data directory. Override it:

```json
{
  "residency": {
    "allow": ["eu"],
    "auditPath": "/var/log/lunos/egress.log"
  }
}
```

Notes for reviewers:

- **Blocked attempts are recorded too**, with `"allowed": false`. A log that only shows successful calls cannot answer "did anything try to leave the region?", which is the question that matters.
- **Only the destination host is recorded — never the request path or body.** An audit trail of what left must not itself become a copy of what left.
- The log is a local file. Nothing is sent to ITService EOOD; Lunos is self-hosted and operates no service that could receive it. You can forward it to your own SIEM ([Forwarding](audit-log.md#forwarding-to-a-siem)), which is off unless you configure it.
- Turn logging off, keeping enforcement, with `"audit": false`.

## Full example

A deployment permitting EU providers plus a verified EU-region Azure resource:

```json
{
  "residency": {
    "allow": ["eu", "configurable"],
    "audit": true,
    "auditPath": "/var/log/lunos/egress.log"
  },
  "model": "mistral/mistral-large-latest"
}
```

## Limits worth stating plainly

- This controls **where model requests go**. It is not a data-protection assessment and does not by itself discharge GDPR obligations — you still need the appropriate agreement with the provider.
- Jurisdiction entries reflect the project's best current understanding, not the provider's contractual commitments. The source of truth is `packages/core/src/jurisdiction.ts`; corrections there flow into the published table.
- Sub-processors are not enumerated. A provider processing in the EU may still use sub-processors.
- The audit log records outbound **model** calls. It is not a general-purpose network monitor.
