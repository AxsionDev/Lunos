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
| Software bill of materials         | Generated for every release; licence data from v1.18.40                                      | [Supply chain](supply-chain.md#software-bill-of-materials)                           |
| Documented vulnerability handling  | Intake, assessment, remediation, release, disclosure; acknowledgement within 6 business days | [`SECURITY.md`](../../SECURITY.md#vulnerability-handling-process)                    |
| Private vulnerability reporting    | Enabled (GitHub Security Advisories)                                                         | [Report a vulnerability](https://github.com/AxsionDev/Lunos/security/advisories/new) |
| Dedicated security contact address | security@lunos.tech                                                                          | [`SECURITY.md`](../../SECURITY.md#reporting-security-issues)                         |
| Verifiable releases                | npm provenance, and signed checksums from v1.18.40                                           | [Supply chain](supply-chain.md)                                                      |
| Support periods                    | **6 months of security fixes** for each release from its release date, from v1.18.43 onward  | [Security support period](#security-support-period)                                  |

## Security support period

Decided by ITService EOOD on 2026-10-02:

- **Each release gets security fixes for 6 months from its release date**, starting with v1.18.43.
  Releases before v1.18.43 have no support period: fixes for them ship only in a later release.
- A security fix ships as a new release. Its GitHub Security Advisory names the affected versions
  and the release that fixes them ([`SECURITY.md`](../../SECURITY.md)).
- **How you learn a release is out of support:** its release date is on its
  [GitHub Release](https://github.com/AxsionDev/Lunos/releases) and on
  [lunos.tech/changelog](https://lunos.tech/changelog); support ends 6 months after that date.
  When a newer release exists, Lunos says so at startup (`There is a new version: … please run
"lunos update"`), and `lunos update` moves to it.

Readiness groundwork detail: [`.claude/docs/xcod-64-cra-readiness.md`](../../.claude/docs/xcod-64-cra-readiness.md).

## When this changes

Any monetisation of Lunos moves it toward the manufacturer regime and triggers a re-assessment.
Absent that, the assessment is re-checked at **11 December 2027**.
