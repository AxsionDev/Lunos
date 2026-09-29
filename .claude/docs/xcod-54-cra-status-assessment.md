# XCOD-54 — CRA status: **outside scope today, steward as the fallback, manufacturer on monetisation**

**Status:** first-pass assessment · **Date:** 2026-09-20 · **Assessed by:** Petar Minev (product owner)
**Epic:** XCOD-15 · **Follow-up from:** XCOD-17 · **Depends on:** XCOD-55 · **Regulation:** (EU) 2024/2847

> **This document is analysis, not legal advice.** No counsel was engaged in producing it. The
> ticket anticipated exactly this: a first-pass assessment drafted from primary text, to be
> confirmed by counsel before it is relied on externally.

## The determination

**Under the current distribution model, Lunos is most likely outside the CRA's scope entirely —
not merely inside the lighter steward regime.**

The CRA reaches free and open-source software only where it is made available on the market
"in the course of a commercial activity". The Commission states that products qualifying as FOSS
which are **"not monetised by their manufacturers"** should not be treated as commercial activity.

Lunos today is MIT-licensed, distributed free, self-hosted by whoever runs it, and **not monetised
in any form** — no paid hosting, no paid support, no commercial licence. Per
[XCOD-55](xcod-55-infrastructure-sovereignty-decision.md), a hosted offering is "on the roadmap
eventually, but not near-term".

**This is the least burdensome of the three possible positions, and it is the one the facts
currently support.** The value of saying so precisely is that it identifies exactly which change
would end it.

### The three positions

| Position              | Trigger                                                                                           | Applies to Lunos                   |
| --------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **Outside scope**     | FOSS not monetised by its manufacturer — not a commercial activity                                | **Today**                          |
| **Steward** (Art. 24) | Sustained support for FOSS _intended for commercial activities_, without placing it on the market | Fallback if the above is contested |
| **Manufacturer**      | Places a product with digital elements on the EU market in the course of a commercial activity    | If a paid offering launches        |

The steward position matters as a **fallback** rather than a prediction. ITService EOOD does
sustain Lunos's development, so if a regulator disputed the "not monetised" reading, steward is the
next position rather than manufacturer. It is a short fall: stewards carry Article 24 only and are
**exempt from administrative fines under Article 64(10)**.

## Obligation set

Assessed against the **steward** regime, since that is the binding-but-realistic downside case.
Under "outside scope" none of these are legal obligations; several remain good practice.

| Obligation                                                                   | Source                            | Status             | Note                                                                                                 |
| ---------------------------------------------------------------------------- | --------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- |
| Documented cybersecurity policy (secure development, vulnerability handling) | Art. 24(1)                        | **Not started**    | No `SECURITY.md` policy covering documenting/addressing/remediating vulnerabilities                  |
| Support voluntary vulnerability reporting                                    | Art. 24(1), 15                    | **Not started**    | No coordinated disclosure channel published                                                          |
| Cooperate with market surveillance authorities on request                    | Art. 24(2)                        | **Not started**    | Reactive; nothing to build until asked, but the Art. 24(1) documentation must exist to hand over     |
| Report actively exploited vulnerabilities / severe incidents                 | Art. 24(3) → Art. 14(1), (3), (8) | **Not started**    | Scoped, not blanket — see below                                                                      |
| SBOM                                                                         | Manufacturer regime; Annex I      | **Not started**    | No SBOM tooling anywhere in the repo. Planned as a milestone in `xcod-31-build-in-public-cadence.md` |
| Conformity assessment, CE marking, technical documentation                   | Manufacturer regime               | **Not applicable** | Manufacturer-only. Would become live on monetisation                                                 |

**On the reporting duty's scope.** Article 24(3) does not impose Article 14 wholesale. Article 14(1)
binds stewards "to the extent that they are involved in the development of" the product; Article
14(3) and (8) bind them to the extent severe incidents affect **the network and information systems
the steward provides for developing** the product. For Lunos that second limb points at the GitHub
org and release infrastructure, not at users' machines.

## Timeline

Verified against Article 71, which excepts **only** Article 14 and Chapter IV from the general date:

| Date            | What applies                                                                          | Relevance to Lunos                         |
| --------------- | ------------------------------------------------------------------------------------- | ------------------------------------------ |
| 10 Dec 2024     | Entry into force                                                                      | —                                          |
| 11 Jun 2026     | Chapter IV (Arts. 35–51), notification of conformity assessment bodies                | None — concerns notifying bodies           |
| **11 Sep 2026** | **Article 14 — reporting of actively exploited vulnerabilities and severe incidents** | **Binds manufacturers.** Passed 9 days ago |
| 11 Dec 2027     | The Regulation generally, including Article 24                                        | The date that matters if steward applies   |

**Article 24 is not excepted by Article 71, so steward obligations run from 11 December 2027** —
the Article 24(3) cross-reference to Article 14 does not pull Article 24's own application date
forward. This is a reading of the text, and among the better candidates for counsel to confirm.

> **Correction to an existing document.** `xcod-31-build-in-public-cadence.md:49` justifies the
> CRA/SBOM milestone's urgency with "the **May 2026** deadline". **No CRA milestone falls in May 2026.** The nearest are 11 June 2026 and 11 September 2026.

## Code signing and SBOM

The ticket asked for these to be addressed explicitly.

**Code signing.** Lunos binaries are **not signed on any platform** — recorded in `CHANGELOG.md:71`
and gated in CI under XCOD-49, which detects absent credentials and skips the signing jobs rather
than failing. Signing is **not itself a named CRA obligation**; it bears on the Annex I essential
requirements, which are manufacturer-only and apply from 11 Dec 2027. So under the current
determination this is **not a compliance gap**. It is a distribution and trust problem — downloads
trip OS gatekeepers — and it would become a conformity question on monetisation.

**SBOM.** Annex I requires manufacturers to identify and document components, including an SBOM in
a commonly used machine-readable format. No SBOM tooling exists in the repo today. Under the
current determination this is **not owed**. Two reasons to build it anyway: it is the single
largest piece of manufacturer readiness, and it is already planned as a publicly newsworthy
milestone. Doing it early converts a future obligation into present marketing.

## Re-assessment trigger

**Re-run this assessment when any of the following becomes true. Each moves Lunos toward
manufacturer, where the full regime and the already-live Article 14 reporting duty apply.**

1. **Any monetisation of Lunos itself** — paid hosting, paid support, a commercial licence, paid
   priority features. This is the decisive one; the whole determination rests on "not monetised".
2. **The hosted offering deferred by XCOD-55 becoming near-term** — that ticket is the upstream
   dependency, and its reversal is this document's trigger.
3. **Commercial distribution by ITService EOOD into the EU market** in any form that constitutes
   placing a product on the market.
4. **A Commission guidance or enforcement position narrowing the "not monetised" carve-out** — most
   plausibly around donations, sponsorship, or dual-licensing, none of which Lunos currently has.

Absent any of these, re-check at the **11 December 2027** general application date.

## Open questions for counsel

1. Does **paid support or a hosted offering** monetise _the product_ for CRA purposes, or only the
   service? Section 3 of the Commission's 27 July 2026 practical guidance addresses commercial
   activity and should be read before engaging counsel.
2. Does **sponsorship or donation income** defeat "not monetised"? Not currently applicable, but it
   is the most likely way the position erodes accidentally.
3. Is the reading above correct that **Article 24 applies from 11 Dec 2027**, not 11 Sep 2026?
4. Would publishing a `SECURITY.md` and a disclosure policy — sensible regardless — be read as
   evidence of steward status, and does that matter given stewards are fine-exempt?

## Sources

- Regulation (EU) 2024/2847 — https://eur-lex.europa.eu/eli/reg/2024/2847/oj/eng
- Cyber Resilience Act, European Commission — https://digital-strategy.ec.europa.eu/en/policies/cyber-resilience-act
- CRA and open source, European Commission — https://digital-strategy.ec.europa.eu/en/policies/cra-open-source
- Article 71 (entry into force and application) — https://www.european-cyber-resilience-act.com/Cyber_Resilience_Act_Article_71.html
- Article 24 (obligations of open-source software stewards) — https://www.european-cyber-resilience-act.com/Cyber_Resilience_Act_Article_24.html
