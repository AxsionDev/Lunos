# XCOD-17 — Legal/entity ownership: **ITService EOOD** (PROVISIONAL)

**Status:** decided, provisional · **Date:** 2026-09-18 · **Decided by:** Petar Minev (product owner)
**Epic:** XCOD-15 · **Resolves:** AXC-9 · **Partially unblocks:** XCOD-19 — settles _which entity
owns the cloud accounts_; leaves _whether US-controlled providers are acceptable_ open

> **This document is analysis, not legal advice.** No counsel was engaged in producing it. Confirm
> with a qualified Bulgarian/EU practitioner before the first commercial contract, and before
> relying on any liability statement here.

## The decision

**Lunos operates under the existing entity trading as Axsion.** No new entity is formed at this
stage. The registered legal person — the string that binds in a copyright line, a contract, or a
procurement submission — is:

| Field              | Value                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Registered name    | **ITService EOOD** (ИТСървиз ЕООД)                                                               |
| Legal form         | EOOD — _еднолично дружество с ограничена отговорност_, a single-member limited liability company |
| UIC (ЕИК)          | **201069485**                                                                                    |
| Registered address | ул. Акад. Г. Бончев 6, БАН бл. 13, гр. София 1113, Република България                            |
| Jurisdiction       | Bulgaria — EU member state                                                                       |
| Trading as         | Axsion                                                                                           |

**"Axsion" is a trading name, not the legal person.** Everywhere below, "Axsion" is used as
readable shorthand; **ITService EOOD** is what any binding instrument must name. Conflating the two
is the specific error this table exists to prevent — a contract or copyright notice naming "Axsion"
alone names nobody.

This is **provisional by design**, which the ticket explicitly permits. It is a reversible choice:
moving Lunos into a dedicated vehicle later is a straightforward IP assignment from one entity you
control to another, and nothing in this decision makes that harder.

## Why the existing entity rather than a new EU entity

**The EU-incorporation requirement is already satisfied.** Bulgaria has been an EU member state
since 2007, so Axsion is an EU-incorporated entity today. A new entity would buy no additional
EU-sovereignty credibility — it would only duplicate a property Axsion already has.

**Procurement financial standing runs the opposite way to intuition.** Public-sector and regulated
buyers routinely require evidence of financial standing and years trading as a qualification
condition — turnover thresholds, filed accounts, sometimes professional indemnity cover. An
established entity with trading history **passes** these; a freshly incorporated single-product
company with no accounts **fails** them. For a project whose stated target buyers are ECRIS
integrators, municipal platforms and utilities, forming a new entity would have made the first
procurement conversation harder, not easier.

**Cost and overhead are real and premature.** Incorporation, separate accounting, filings and a
second set of statutory obligations are recurring costs against zero Lunos revenue.

**The case for a new entity is genuine but not yet live.** Ring-fencing Lunos' deployment liability
away from Axsion's other business, and holding Lunos IP in a clean vehicle for investment, sale or
donation to a foundation, are the real arguments for Option B. None of them binds before there is
revenue or an investor. They are the substance of the revisit trigger below.

## Implications for IP ownership

**Upstream copyright is unchanged and stays unchanged.** `LICENSE` carries
`Copyright (c) 2025 opencode` under MIT. Lunos is an MIT-licensed derivative; upstream's copyright
line and attribution are **not** ours to alter, now or later.

**Lunos-specific code is owned by ITService EOOD** under this decision — but "owned by" needs care, because
employees and contractors are not the same case and the default runs opposite ways:

- **Employees:** work created in the course of employment broadly vests with the employer, subject
  to the employment terms and Bulgarian copyright rules.
- **Contractors and freelancers:** the default is generally the **reverse** — absent an express
  written assignment, the contractor retains copyright in their contribution in many EU
  jurisdictions. Any contractor work in Lunos therefore needs an explicit assignment clause;
  choosing Option A does not create one.

That distinction is the practical work item behind this decision, not a footnote to it.

**Two gaps this decision exposes rather than closes:**

| Gap                                                                                                                                                             | Current state                                                                                                                                                                                        | Consequence |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **No `ITService EOOD` copyright line exists.** `LICENSE` names only `opencode`. Nothing in the repo asserts the entity's authorship of the Lunos-specific work. | An MIT-derivative convention is to add a second copyright line alongside — never replacing — upstream's. Needs a follow-up ticket.                                                                   |
| **No CLA and no DCO.** `CONTRIBUTING.md` (278 lines) contains neither.                                                                                          | Inbound external contributions rest on the implicit inbound=outbound convention only, with no express grant or sign-off. Thin for a procurement-facing project that may later need clean provenance. |

**The copyright line, when added, must read `ITService EOOD` — not "Axsion".** The registered
details are in the table at the top. The same applies to every contract, procurement submission and
imprint.

## Implications for liability

**The legal form supplies limited liability.** EOOD is a single-member limited liability company, so
the corporate veil this decision relies on genuinely exists: liability is in principle confined to
ITService EOOD rather than reaching its owner personally. That is the structural reason Option C
(personal ownership) was rejected, and it is worth stating because the whole "an entity stands
behind Lunos" answer is only as good as the form's liability shield.

**The current posture disclaims on the wrong party's behalf.** `LICENSE` lines 15–21 carry MIT's
"AS IS" warranty disclaimer — and it names _opencode_ as the disclaiming author/copyright holder,
not ITService EOOD. For a self-hosted Lunos deployment going wrong today, there is no Lunos-side
disclaimer of record. Adding the `ITService EOOD` copyright line (above) is what puts the entity
inside the clause that protects it.

**MIT is not a commercial contract.** For the free, self-hosted, open-source distribution, the MIT
disclaimer is the intended and adequate posture. But the moment a paid pilot exists, liability is
governed by that pilot's contract — warranties, caps, indemnities, SLAs — not by the repository
licence. Do not assume MIT carries into a paid engagement.

**Accepted coupling risk.** Operating Lunos under the existing entity means a Lunos deployment
failure reaches ITService EOOD's balance sheet and its existing client relationships — the shield
protects the owner personally, not the company's other business. This is accepted, not overlooked: it
is the price of the procurement and cost advantages above, and it is the specific exposure the
revisit trigger is watching.

**EU Cyber Resilience Act.** CRA obligations differ sharply depending on whether an entity is a
_manufacturer_ placing a product on the market or an _open-source steward_ — a lighter regime. Which
one ITService EOOD is depends on how Lunos is distributed and monetised, so this decision does not
settle it. It becomes live at the CRA/SBOM milestone tracked in
`.claude/docs/xcod-31-build-in-public-cadence.md`, and should be assessed there with counsel.

## Does the entity's jurisdiction need to be EU-based for the "EU-sovereign" claim?

The ticket asks this directly. **Yes — and it now is, at the entity level.**

The claim being made to public-sector buyers is not merely "our servers are in Europe." It is that
the counterparty is not reachable by non-EU compulsory-disclosure regimes. A Bulgarian entity with
no US establishment is outside the reach of the US CLOUD Act in a way a US-owned vendor's EU
subsidiary is not — that is the substance behind the positioning, and ITService EOOD's Bulgarian
incorporation supplies the jurisdictional half of it. **The "no US establishment" half is assumed,
not verified here, and should be confirmed** before the claim is made to a buyer in writing.

**One honest caveat: entity sovereignty is not infrastructure sovereignty.** The two are separable
and Lunos currently only has the first. `.claude/docs/xcod-19-ci-workflow-triage.md` records that
`deploy.yml` targets **AWS and Cloudflare** — US-controlled providers. A fully defensible
EU-sovereignty claim for any _hosted_ Lunos offering needs the infrastructure question answered too;
the self-hosted distribution sidesteps it, because the buyer supplies their own infrastructure. Be
precise about which of the two is being claimed in any given conversation.

## Revisit trigger

**Revisit this decision at the earlier of:**

1. **Before the first paid pilot** — the point at which contractual liability, warranties and
   insurance become real rather than theoretical; or
2. **The first external investment or acquisition conversation** — the point at which a clean,
   single-purpose IP-holding vehicle starts to carry real value.

The CRA/SBOM milestone is a third, softer prompt: it forces the manufacturer-vs-steward question,
which may independently argue for restructuring.

## Open items carried forward, not closed

- **Trademark clearance (EUIPO / USPTO) — still not performed.**
  `.claude/docs/xcod-22-name-freeze-decision.md` named XCOD-17 as its revisit trigger. **Re-deferred
  here, deliberately:** entity choice and name clearance are separable questions, and clearance
  needs a registry search plus counsel, neither of which this decision required. **New trigger:
  before the first paid pilot** — the same gate as above, so the two travel together. The name
  freeze is still not a trademark clearance.
- **Counsel not engaged.** Everything above is reasoning from the repository and from general
  procurement practice.
- **`ITService EOOD` copyright line missing from `LICENSE`** — needs a follow-up ticket.
- **No CLA/DCO in `CONTRIBUTING.md`** — needs a decision of its own, not necessarily a CLA.
- **"No US establishment" is assumed, not verified** — confirm before the CLOUD Act argument is put
  to a buyer in writing.
- **`phase0-backlog.md` / AXC-9 is unavailable** — the source doc was lost with the planning set
  that lived outside git. XCOD-17's own ticket body carried the full substance, so nothing is
  missing from this decision.

## Acceptance criteria

- [x] **A decision is recorded (even if explicitly provisional) naming the legal entity behind
      Lunos** — **ITService EOOD**, UIC 201069485, Sofia, Bulgaria, trading as Axsion; provisional.
      The registered legal person is named, not just the trade name.
- [x] **The decision's implications for IP ownership and liability are noted, not just the entity
      name** — IP ownership and the employee/contractor split, the missing `ITService EOOD`
      copyright line, the absent CLA/DCO, EOOD's limited-liability shield, the MIT "AS IS"
      disclaimer naming the wrong party, the MIT-is-not-a-commercial-contract boundary, the accepted
      coupling risk, and CRA manufacturer-vs-steward exposure.
- [x] **If provisional, a revisit trigger/point is named** — first paid pilot, or first
      investment/acquisition conversation, whichever comes first.

## Candidate follow-up tickets

| Subject                                                               | Why it is separate from XCOD-17                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Add `ITService EOOD` copyright line to `LICENSE` alongside upstream's | A repo change with a rebrand-exclusion constraint                 |
| Decide contributor licensing posture (DCO, CLA, or neither)           | A governance decision with community cost, not an entity decision |
| Trademark clearance, EUIPO + USPTO                                    | Needs registry search and counsel; gated on first paid pilot      |
| CRA manufacturer-vs-open-source-steward assessment                    | Gated on the CRA/SBOM milestone and on how Lunos is monetised     |
| Infrastructure sovereignty for any hosted offering (AWS/Cloudflare)   | Overlaps XCOD-19's `deploy.yml` infra ownership question          |
