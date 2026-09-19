# XCOD-52 — Contributor licensing posture: **DCO** (RECOMMENDED — awaiting owner confirmation)

**Status:** recommended, not yet decided · **Date:** 2026-09-19 · **Recommended by:** analysis, for
Petar Minev (product owner) to confirm
**Epic:** XCOD-15 · **Follow-up from:** XCOD-17 · **Sibling:** [xcod-17-legal-entity-decision.md](./xcod-17-legal-entity-decision.md)

> **This document is analysis, not legal advice.** No counsel was engaged in producing it. Confirm
> with a qualified Bulgarian/EU practitioner before the first commercial contract.

## The recommendation

**Adopt the DCO** (Developer Certificate of Origin 1.1) — require `Signed-off-by` on commits, state
it in `CONTRIBUTING.md`, and **defer bot enforcement** until a named trigger fires.

Not a CLA. Not "neither."

## The fact that decides it: there is nothing to migrate

An audit of authorship since the fork began (2026-09-12):

| Author                         | Commits | Nature                                 |
| ------------------------------ | ------- | -------------------------------------- |
| `pminev1`                      | 137     | the owner — all Lunos-specific work    |
| `opencode-agent[bot]`, CI bots | 15      | automation, no human authorship        |
| `jack@anoma.ly` and 5 others   | 10      | **upstream commits arrived via merge** |

Those ten are not Lunos contributors. They are upstream opencode PRs (#49353, #49036, #49336 …)
that entered the tree through the XCOD-16 upstream merge, already licensed MIT by upstream. The
repo has 1,034 distinct authors all-time; every one of them is upstream's, under upstream's terms.

**Lunos has received zero direct external contributions.** So:

- The retroactivity AC answers itself: **nothing to apply retroactively.** No contributor must be
  chased for a signature, and no merged work sits under an uncertain grant. This is the cheapest
  moment this decision will ever have, exactly as the ticket anticipated.
- Adoption friction today is _zero_ contributors inconvenienced. Adoption friction after a public
  launch is every contributor, forever.

## Why not a CLA

A CLA's headline benefit is the right to **relicense** contributions — to dual-license, to move to
a commercial license later, or to grant a buyer terms other than the project's own.

**Lunos cannot exercise that benefit over the bulk of its own codebase.** The tree is overwhelmingly
upstream opencode code under upstream's MIT licence. ITService EOOD has no authority to relicense
it, CLA or not. A CLA would therefore buy relicensing rights over only the thin Lunos-specific
layer — while imposing the full community cost on every future contributor.

That is a poor trade, and it gets worse in this project's specific context:

- **A CLA requires a signing workflow** — a bot, a signature store, an identity record per
  contributor. That store is **personal data**. Running one is a GDPR processing activity requiring
  a lawful basis, a retention policy and a controller, which sits awkwardly on a project whose
  differentiator is EU data sovereignty. Avoidable overhead.
- **CLAs deter contributors.** Well documented across OSS; the cost is borne permanently in
  exchange for a benefit largely unavailable here.

A CLA would be the right call if Lunos intended to offer a proprietary or dual-licensed edition
built on contributor code. **If that is on the roadmap, this recommendation should be revisited** —
it is the one scenario that flips the answer.

## Why not "neither"

Defensible for an ordinary dev tool, and honest: inbound=outbound under MIT is the widely accepted
default. But it is weak against this project's stated positioning.

The buyers named in XCOD-17 — ECRIS integrators, municipal platforms, utilities — run supplier due
diligence. "Our contributors never asserted anything; we rely on convention" is a materially worse
answer than "every commit carries a signed assertion of right to contribute, and here is the audit
trail." The DCO produces that trail as a side effect of normal git usage.

The ticket also notes the CRA assessment is open (XCOD-54). Whatever CRA status lands, documented
provenance of inbound code is an asset, not a liability.

## Why the DCO specifically

- **No copyright transfer.** Contributors keep their copyright; they assert only that they have the
  right to submit. This is why it carries little community friction — it asks for honesty, not
  ownership.
- **It lives in git, not a database.** `Signed-off-by` is a commit trailer. No signature store, so
  no new personal-data processing beyond what git already records.
- **It is the recognised standard** where provenance matters — the Linux kernel's mechanism, and
  the norm across CNCF projects. Naming a known instrument beats inventing bespoke wording.
- **Reversible.** Adopting a CLA later remains possible; the DCO does not foreclose it.

## Enforcement: deferred, with a named trigger

State the requirement in `CONTRIBUTING.md` now; do **not** wire up a bot yet.

Rationale: with zero external contributors, a bot would gate only the owner's own commits — pure
friction, no provenance gained. The requirement is what matters; the check is an optimisation.

**Named trigger — configure enforcement when either occurs, whichever is first:**

1. **The first external pull request is opened** against `AxsionDev/Lunos`, or
2. **the repository is made public / the launch post ships** (XCOD-31's publication gate).

At that point add the DCO check (GitHub's DCO App, or a `dco` job). Note it must be a GitHub App or
a normal workflow — per the fork's CI history, anything depending on upstream's Blacksmith runners
or GitHub App credentials will not run here.

## Scope note — this does not fix the contractor gap

XCOD-17 flagged that **contractor work generally does not vest with the client absent an express
written assignment.** That is a contracts problem, not a repo problem. The DCO does not solve it: a
contractor signing off certifies their right to submit, not that ITService EOOD owns the result.

If anyone other than the owner has been paid to write Lunos code, that needs a written IP
assignment independent of this decision. Out of scope here; worth its own ticket if it applies.

## Acceptance criteria status

- [x] Decision recorded with reasoning, in the XCOD-17/22 decision-doc format
- [ ] `CONTRIBUTING.md` updated to state the requirement — _pending owner confirmation_
- [x] Enforcement explicitly deferred with a named trigger (above)
- [x] Retroactivity addressed — **not applicable**, zero direct external contributions to date;
      all non-owner commits are upstream's and already MIT-licensed by upstream

## Open question for the owner

Is a **proprietary or dual-licensed Lunos edition** on the roadmap? That is the single fact that
would flip this recommendation from DCO to CLA. Everything above assumes MIT-only.
