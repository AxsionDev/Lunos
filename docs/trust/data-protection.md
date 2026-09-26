# Data protection (GDPR)

Reviewed by ITService EOOD's counsel, September 2026. This note describes how Lunos works, so that
the organisation deploying it can do its own assessment. It is not legal advice for your deployment.

## Roles

- **Lunos is software you run yourself.** ITService EOOD operates no service in the data path,
  receives no data from your deployment and has no telemetry
  ([deployment guide §3](../deployment/self-hosted.md#3-where-your-data-goes)).
- **Your organisation is the controller** for personal data processed with Lunos. ITService EOOD is
  **neither controller nor processor** for that data: supplying software is not processing it.
- **The model provider you configure** is your processor, or an independent controller depending on
  its terms, under **your** agreement with it. Lunos does not stand between you and that contract.
- **One exception reaches ITService EOOD:** the built-in marketplace catalogue. When a marketplace
  command runs, or the Discover view opens, Lunos fetches `https://lunos.tech/marketplace.json`, and
  the lunos.tech web server receives the requester's IP address, as any web server does. For that,
  ITService EOOD is the controller of its own server data. Turn the fetch off with
  `"marketplace_default": false`.

## What personal data can reach a model provider

Whatever the developer sends as context: prompts, the contents of files the agent reads, and command
output. That can include personal data, for example author names and email addresses in source
headers or git output, or personal data in fixtures, logs or databases the agent is pointed at.
Lunos does not classify or filter it.

Session sharing, which would upload a whole transcript, is **off by default**. Long-term memory
(from v1.18.40) is also off by default and stored locally
([security overview](security-overview.md#memory)).

## How the residency controls help

With a data-residency policy set, Lunos refuses model requests to providers outside the allowed
jurisdictions before any connection is made, and records each allowed and refused call in a local
audit log, without prompt or file contents ([data residency](../data-residency.md),
[audit log](../audit-log.md)).

The policy restricts **where Lunos sends** requests. It does not govern what a provider does with
them afterwards (sub-processors, retention, onward transfers). That is covered by the provider's
data processing agreement.

## DPIA-support checklist

Questions for your data protection impact assessment:

1. Which model provider or providers, in which jurisdiction? Is a data processing agreement in
   place, with standard contractual clauses or an adequacy basis where needed? See
   [model provider jurisdictions](../provider-jurisdictions.md).
2. Is a residency policy set, and locked through organisation policy so developers can't change it?
3. Which repositories or data may developers use Lunos on? Do any contain personal data?
4. Does the provider retain requests or train on them? Is zero retention available, and on?
5. Is session sharing left off, and locked?
6. Is the audit log kept and forwarded to your SIEM? What is its retention?
7. Where do local session files live, who can read them, and how are they deleted?
8. Is the marketplace catalogue fetch acceptable, or should it be turned off?
9. Are MCP servers or plugins in use that send data to other third parties?
10. If long-term memory is turned on: which `memory.model` extracts facts, and who reviews what is
    stored?

## Not claimed

- That the software is "GDPR compliant". Compliance is a property of your processing, not of a tool.
- Any certification.
- Anything about model providers' own processing.
