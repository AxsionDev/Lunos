# Security

## IMPORTANT

We do not accept AI generated security reports. We receive a large number of
these and we absolutely do not have the resources to review them all. If you
submit one that will be an automatic ban from the project.

## Threat Model

### Overview

Lunos is an AI-powered coding assistant that runs locally on your machine. It provides an agent system with access to powerful tools including shell execution, file operations, and web access.

Lunos is self-hosted. It is operated entirely on infrastructure you provide — there is no Lunos-operated service in the data path. See [Reporting Security Issues](#reporting-security-issues) for where reports go.

### No Sandbox

Lunos does **not** sandbox the agent. The permission system exists as a UX feature to help users stay aware of what actions the agent is taking - it prompts for confirmation before executing commands, writing files, etc. However, it is not designed to provide security isolation.

If you need true isolation, run Lunos inside a Docker container or VM.

### Server Mode

Server mode is opt-in only. When enabled, set `OPENCODE_SERVER_PASSWORD` to require HTTP Basic Auth. Without this, the server runs unauthenticated (with a warning). It is the end user's responsibility to secure the server - any functionality it provides is not a vulnerability.

### Out of Scope

| Category                        | Rationale                                                               |
| ------------------------------- | ----------------------------------------------------------------------- |
| **Server access when opted-in** | If you enable server mode, API access is expected behavior              |
| **Sandbox escapes**             | The permission system is not a sandbox (see above)                      |
| **LLM provider data handling**  | Data sent to your configured LLM provider is governed by their policies |
| **MCP server behavior**         | External MCP servers you configure are outside our trust boundary       |
| **Malicious config files**      | Users control their own config; modifying it is not an attack vector    |

### Known limitations

These are open, tracked, and listed here rather than omitted:

- **Binaries are not code-signed on any platform.** Downloads will trip OS gatekeepers, and release artifacts cannot currently be verified by signature. Also recorded in [`CHANGELOG.md`](CHANGELOG.md); the CI signing jobs exist but skip when credentials are absent.

---

# Reporting Security Issues

We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

**Report Lunos vulnerabilities to the Lunos project**, not to upstream opencode:

→ **[Report a Vulnerability](https://github.com/AxsionDev/Lunos/security/advisories/new)** (GitHub Security Advisories — private to maintainers)

→ Or email **[security@lunos.tech](mailto:security@lunos.tech)**, if you can't use GitHub.

Please do **not** open a public issue for a suspected vulnerability.

If the issue is in code Lunos inherits unchanged from upstream opencode, it may also affect upstream. We will coordinate with them where relevant; you are also free to report it to [upstream](https://github.com/anomalyco/opencode/security/advisories/new) directly.

### What to include

A report is actionable when it has: affected version or commit, platform, reproduction steps, observed versus expected behaviour, and impact. A proof of concept helps. Reports that assert a vulnerability without a reproduction are usually not actionable.

### What happens next

| Stage             | Target                                                                |
| ----------------- | --------------------------------------------------------------------- |
| Acknowledgement   | Within **6 business days**                                            |
| Triage assessment | Severity, affected versions, and whether it is in scope per the above |
| Progress updates  | At meaningful milestones, or on request                               |
| Fix and release   | Coordinated with you; timing depends on severity and complexity       |
| Disclosure        | Public advisory once a fix ships, crediting you unless you prefer not |

If you do not receive an acknowledgement within 6 business days, please comment on your advisory thread to escalate.

## Vulnerability handling process

How the project handles a report once received:

1. **Record.** Every report is tracked in a GitHub Security Advisory from intake through disclosure, so there is a durable record of what was reported, when, and what was done.
2. **Assess.** Determine affected versions, severity, and whether the issue falls inside the scope defined by the threat model above.
3. **Remediate.** Develop a fix privately. Security fixes take priority over feature work.
4. **Release.** Ship the fix in a release and state its security relevance in the release notes.
5. **Disclose.** Publish the advisory once users have a fixed version available, crediting the reporter unless they prefer otherwise.
6. **Component inventory.** A Software Bill of Materials (CycloneDX) is generated automatically for each release, so the dependency tree can be checked against a newly disclosed upstream vulnerability without guesswork.

This policy is published as good practice. Lunos is free, MIT-licensed, self-hosted and unmonetised, and on the current assessment falls outside the scope of the EU Cyber Resilience Act; nothing here is a claim of CRA compliance. See [`.claude/docs/xcod-64-cra-readiness.md`](.claude/docs/xcod-64-cra-readiness.md) for what is and is not claimed.
