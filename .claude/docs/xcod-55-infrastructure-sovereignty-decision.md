# XCOD-55 — Infrastructure sovereignty: **hosted offering deferred, claim scoped to self-hosted** (DECIDED)

**Status:** decided · **Date:** 2026-09-19 · **Decided by:** Petar Minev (product owner)
**Epic:** XCOD-15 · **Follow-up from:** XCOD-17 · **Overlaps:** XCOD-18, XCOD-19 · **Unblocks:** XCOD-54

> **This document is analysis, not legal advice.** No counsel was engaged in producing it.

## The decision

**A hosted Lunos offering is on the roadmap eventually, but not near-term.** Until it is, the public
sovereignty claim stays scoped to what is true today: **self-hosted distribution by an
EU-incorporated vendor.**

The provider evaluation is **deliberately deferred** — see the named trigger below. Nothing is
pitched, sold, or claimed on the basis of hosted infrastructure until that evaluation is done.

## Why this is defensible today

The asymmetry the ticket identified is real and it works in our favour right now:

- **Self-hosted distribution sidesteps infrastructure sovereignty entirely.** The buyer supplies the
  infrastructure. There is no Lunos-side processing, so there is no Lunos-side jurisdiction to
  interrogate. The claim reduces to a property we demonstrably have — an EU-incorporated vendor
  (ITService EOOD, Bulgaria, per XCOD-17) shipping software the buyer runs themselves.
- **A hosted offering does not.** The moment Lunos processes a customer's code on infrastructure
  Lunos chose, the provider's jurisdiction becomes Lunos's problem, and a careful buyer will ask.

So the risk is not present-tense; it is a **claim-discipline** risk. The danger is marketing copy
written for the hosted future being published in the self-hosted present.

## The claim, stated precisely

This section exists so external copy can be checked against something. **Anything published about
sovereignty should be verifiable against this table.**

| Claim                                                          | True today?             | Basis                                                                                                                    |
| -------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| The vendor is EU-incorporated                                  | **Yes**                 | ITService EOOD, Bulgaria, UIC 201069485 (XCOD-17)                                                                        |
| The vendor is outside non-EU compulsory-disclosure reach       | **Yes**                 | Bulgarian legal person; not a US-parented subsidiary                                                                     |
| Lunos can be run entirely on infrastructure the buyer controls | **Yes**                 | self-hosted is the shipping distribution model                                                                           |
| Lunos is provider-agnostic for model routing                   | **Yes**                 | inherited from opencode                                                                                                  |
| _Lunos-operated_ infrastructure is EU-sovereign                | **N/A**                 | there is no Lunos-operated production infrastructure for customers                                                       |
| EU-specific functionality exists in the build                  | **Yes** (since Phase 1) | provider jurisdiction metadata (XCOD-61) and enforceable data-residency controls (XCOD-62); see `docs/data-residency.md` |

> **Amendment 2026-09-21 (XCOD-63).** The last row was **No** when this was decided. Phase 1
> shipped provider jurisdiction metadata (XCOD-61) and enforceable, audit-logged data-residency
> controls (XCOD-62), so it is now **Yes**. This is a claim _increase_ and is therefore scoped
> tightly: what exists is control over **which provider may be used and a record of what left** —
> it is **not** EU-operated infrastructure, and the `N/A` row above is unchanged. `CHANGELOG.md`'s
> "no EU-specific functionality exists yet" line was corrected in the same change. No other row
> has changed, and the wording rules below are unamended.

**The load-bearing distinction:** _entity_ sovereignty is established; _infrastructure_ sovereignty
is **not claimed** because there is no customer-facing Lunos infrastructure to claim it about.
`CHANGELOG.md:38` already draws this line correctly, and `README.md:33` is careful — it sells
self-hostability as an _architectural_ property rather than asserting a sovereign hosted service.

### Wording rules

- ✅ "EU-sovereign, self-hostable" — accurate; the two words qualify each other.
- ✅ "EU-incorporated vendor" — a fact about the entity.
- ❌ "EU-sovereign infrastructure" / "sovereign cloud" — implies Lunos-operated hosting. Not true.
- ❌ Any claim of CRA, EUCS or similar certification. None held. See XCOD-54.
- ⚠️ "EU-sovereign" _unqualified_ in a hosted context would be an overclaim the day a hosted
  offering exists. Re-read this document before writing that copy.

## Known gap: our own deployment is US-region

`deploy.yml:34` deploys console/web via SST to AWS **`us-east-1`**, with Cloudflare alongside
(`deploy.yml:39`). That is not merely a US-owned provider in an EU region — it is a US region.

This does **not** invalidate anything above: that workflow deploys _our_ console/web property, not
customer workloads, and XCOD-19 already defers it as non-running on this fork. But it is an
uncomfortable fact for a project that leads on EU sovereignty, and it should be fixed before that
workflow is ever un-deferred.

**Filed as its own ticket** rather than fixed here — `deploy.yml` is currently deferred and untested
on this fork, so changing the region is unverifiable today and would land as an unreviewable diff.

## EU-sovereign options — preliminary, not an evaluation

Recorded so the deferred evaluation does not start from zero. **None of this is a recommendation**;
it is a shortlist to assess when the trigger fires.

| Option                           | Jurisdiction    | Note                                                          |
| -------------------------------- | --------------- | ------------------------------------------------------------- |
| Hetzner                          | Germany/Finland | Cheapest credible EU option; no managed-edge equivalent       |
| OVHcloud                         | France          | SecNumCloud-qualified tiers exist; broadest EU-native surface |
| Scaleway                         | France          | Closest to a modern managed-services feel among EU natives    |
| Exoscale                         | Switzerland     | Note: Switzerland is **not** EU — adequacy, not membership    |
| Stay on AWS/Cloudflare EU region | US-controlled   | Simplest; does **not** satisfy a sovereignty-sensitive buyer  |

The real cost is not compute — it is the **managed-services and edge gap**. The current stack leans
on SST/AWS primitives and Cloudflare edge; EU-native providers do not offer drop-in equivalents, so
a migration is an architecture change, not a provider swap. That is the number the evaluation needs
to produce.

## Named trigger for the deferred evaluation

Run the full EU-sovereign infrastructure evaluation when **any** of these first occurs:

1. **A hosted Lunos offering moves from "eventually" to planned work** — i.e. it enters a sprint, or
2. **any external copy, pitch or procurement response claims hosted/managed Lunos**, or
3. **`deploy.yml` is un-deferred** and begins deploying a customer-facing property (XCOD-19).

Whichever fires, re-read the claim table above _before_ writing copy, not after.

## Interaction with XCOD-54 (CRA)

This decision **partially unblocks** XCOD-54. That ticket's role determination follows monetisation:
free self-hosted points toward the lighter _open-source steward_ regime; a paid hosted offering
points toward _manufacturer_, with conformity assessment, CE marking and incident reporting.

"Eventually, not near-term" means **steward is the working assumption today**, with a foreseeable
move to manufacturer. XCOD-54 remains gated on its own CRA/SBOM milestone, but it can now record the
current-model answer rather than treating the branch as unknown.

## Acceptance criteria status

- [x] Decision recorded on whether a hosted offering is planned — **eventually, not near-term**
- [x] EU-sovereign options — preliminary shortlist recorded; full evaluation deferred with a named
      trigger, per the owner's instruction to scope the claim now and defer the provider work
- [x] Precise scope of the public "EU-sovereign" claim written down, distinguishing entity from
      infrastructure sovereignty, in a form external copy can be checked against
- [x] `deploy.yml`'s status in XCOD-19's triage table updated to reflect this outcome
