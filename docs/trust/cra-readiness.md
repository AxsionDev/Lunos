# EU Cyber Resilience Act (CRA): readiness

**Lunos holds no certification and claims no CRA compliance.** This page states where it stands.

## Current position

On ITService EOOD's assessment ([`.claude/docs/xcod-54-cra-status-assessment.md`](../../.claude/docs/xcod-54-cra-status-assessment.md)):

- Lunos is free, MIT-licensed, self-hosted and not monetised by its manufacturer, so it most likely
  falls **outside the CRA's scope** (software not made available in the course of a commercial
  activity).
- If that reading were contested, the fallback is the **open-source software steward** regime
  (Article 24), whose obligations apply from **11 December 2027**.
- The **manufacturer** regime (conformity assessment, CE marking, technical documentation) would
  apply only if Lunos were monetised, for example through a paid hosted offering or paid support.

This is a first-pass assessment made from the Regulation's text, **not legal advice**; the open
questions for counsel are listed in the assessment.

## What exists anyway, as readiness

| Area                               | Status                                                                                       | Where                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Software bill of materials         | Generated for every release; licence data from the next release                              | [Supply chain](supply-chain.md#software-bill-of-materials)                           |
| Documented vulnerability handling  | Intake, assessment, remediation, release, disclosure; acknowledgement within 6 business days | [`SECURITY.md`](../../SECURITY.md#vulnerability-handling-process)                    |
| Private vulnerability reporting    | Enabled (GitHub Security Advisories)                                                         | [Report a vulnerability](https://github.com/AxsionDev/Lunos/security/advisories/new) |
| Dedicated security contact address | security@lunos.tech                                                                          | [`SECURITY.md`](../../SECURITY.md#reporting-security-issues)                         |
| Verifiable releases                | npm provenance now; signed checksums from the next release                                   | [Supply chain](supply-chain.md)                                                      |
| Support periods                    | **Not yet defined**                                                                          | To be decided by ITService EOOD. Until then, fixes ship in the latest release only   |

Readiness groundwork detail: [`.claude/docs/xcod-64-cra-readiness.md`](../../.claude/docs/xcod-64-cra-readiness.md).

## When this changes

Any monetisation of Lunos moves it toward the manufacturer regime and triggers a re-assessment.
Absent that, the assessment is re-checked at **11 December 2027**.
