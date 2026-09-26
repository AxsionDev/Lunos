# Lunos Trust pack

For procurement officers and security reviewers. One place that answers the questions security,
data-protection and accessibility checklists ask, with every statement linked to the document or
code that backs it.

**Versioning.** This pack is versioned with the repository: the copy on a release tag describes that
release. The latest published release is **v1.18.39**. Where a control exists on the `dev` branch
but has not been released yet, it says **"from the next release"**. Where it doesn't exist yet, it
says **Planned**. Nothing here is a certification or a claim of compliance.

| Document                                                                                                                            | What it answers                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [What Lunos claims, and what it doesn't](../deployment/self-hosted.md#2-what-is-true-today--the-sovereignty-claim-stated-precisely) | The claim table every other document must agree with (checked in CI by `script/check-claims.ts`)          |
| [Security overview](security-overview.md)                                                                                           | Architecture, trust boundaries, and a threat model: what is mitigated and what isn't                      |
| [Supply chain](supply-chain.md)                                                                                                     | How releases are built and how to verify them; how marketplace entries are reviewed                       |
| [CRA readiness](cra-readiness.md)                                                                                                   | Where Lunos stands under the EU Cyber Resilience Act, the SBOM, vulnerability handling, support           |
| [Data protection](data-protection.md)                                                                                               | Status of the GDPR note (under legal review; not yet published)                                           |
| [Accessibility](accessibility.md)                                                                                                   | Status of the accessibility statement and conformance report                                              |
| [Questionnaire: CSA CAIQ v3.0.1](questionnaire-caiq-v3.0.1.md)                                                                      | Pre-filled answers to all 295 CAIQ questions; organisational ones are marked for ITService EOOD to answer |

Related reference documents:
[Self-hosted deployment guide](../deployment/self-hosted.md) ·
[Data residency controls](../data-residency.md) ·
[Model provider jurisdictions](../provider-jurisdictions.md) ·
[Audit log](../audit-log.md) ·
[Marketplace review criteria](../marketplace-review.md) ·
[`SECURITY.md`](../../SECURITY.md)

**Reporting a vulnerability:** privately through
[GitHub Security Advisories](https://github.com/AxsionDev/Lunos/security/advisories/new). See
[`SECURITY.md`](../../SECURITY.md).
