# XCOD-22 — Product name freeze: **Lunos** (FROZEN)

**Status:** decided · **Date:** 2026-09-18 · **Decided by:** Petar Minev (product owner)
**Epic:** XCOD-21 · **Unblocks:** XCOD-23, XCOD-25, XCOD-26, XCOD-28

## The decision

**The product name is frozen as "Lunos." XCOD-4's rename (Ratio → Lunos) stands and will not be
reverted.** No follow-up ticket to undo XCOD-4 is required. All public-facing work — README,
landing site, social handles, GitHub org rename — may now proceed under this name.

What this decision actually was: XCOD-4 already renamed the product to Lunos and shipped; every
asset in the repo says Lunos. XCOD-22 therefore asked whether to **reverse** that, not which name
to pick from scratch. The answer is no. The collision risk from `lunos.ai` is real and accepted
with eyes open, because the checkable evidence runs against the alternative on every axis measured
and reverting would cost a fourth rename in a fortnight.

## Collision factors weighed

Checked 2026-09-18. Marketing clearance was the explicit deciding lens, per the ticket.

**npm availability** — decisive, and the opposite of what the ticket assumed:

| Package                                            | Lunos                  | Ratio                      |
| -------------------------------------------------- | ---------------------- | -------------------------- |
| bare name                                          | `lunos` **available**  | `ratio` **TAKEN** (v0.0.1) |
| `-ai` suffix (upstream's `opencode-ai` convention) | `lunos-ai` available   | `ratio-ai` available       |
| `-code` suffix                                     | `lunos-code` available | `ratio-code` available     |

**Domains** — measured by DNS A-record resolution:

- Lunos: `.ai`, `.dev`, `.eu`, `.io`, `.com`, `.de` all in use; `getlunos.com` in use; `lunos.sh`
  appears unregistered.
- Ratio: `.ai`, `.dev`, `.eu` all in use.

**Every short TLD is occupied for both names.** Domain scarcity is a constant, not a variable, and
was therefore dropped as a deciding factor. Either name requires a qualified launch domain.

**Search confusability** — the axis that actually separates them, and where the ticket's intuition
inverted the truth. The ticket treated collision risk as _counting competitors_, which favours
Ratio. But "ratio" is an ordinary English word and a core mathematical term: "ratio AI coding
agent" competes against every use of the word and is effectively un-rankable. "Lunos" is a rare
coined token whose collisions — `lunos.ai`, `lunosrouter.com`, `lunos.de` — are a **finite,
enumerable set that can be out-ranked**. A dictionary word cannot be.

**Cost of reverting** — AXCODE → Ratio → Lunos is already three renames in three days. A fourth
would invalidate XCOD-4 (Done), the 21 README notices from XCOD-24, the XCOD-27 FAQ draft, and
every branded asset tracked by XCOD-45, while buying a name that is worse on npm and on search.

## Accepted risk

`lunos.ai` is an active, funded (~$5M pre-seed) AI-agents startup, competing for attention in
adjacent space. `lunosrouter.com` (an LLM router) is nearer still in category. **This risk is
accepted, not dismissed.** It is a marketing/SEO cost to be managed through positioning — the
EU-sovereignty angle is a genuine differentiator none of the three collisions occupy — not a
blocker on shipping.

## Residual risk: trademark clearance NOT performed

**Not checked:** EUIPO and USPTO trademark registers.

This is outside XCOD-22's acceptance criteria (which ask only for domain and npm availability) and
cannot be performed from the repo — it needs a registry search and, realistically, counsel. It is
recorded here as an open risk rather than silently omitted, because a name intended to survive
public-sector procurement carries more trademark exposure than a typical dev tool.

**Revisit trigger:** resolve alongside **XCOD-17** (legal/entity ownership), which is already
scoped to accept a provisional answer with a named trigger — or, at the latest, **before the first
paid pilot**. A name freeze is not a trademark clearance, and nothing here should be read as one.

Also unchecked, and deliberately deferred to the stories that own them: App Store / VS Code
Marketplace / Open VSX listing conflicts (both publish workflows are deferred by XCOD-19), GitHub
org availability (XCOD-28), and social handles (XCOD-26).

## Acceptance criteria

- [x] A paragraph recording the final name decision and the collision-risk factors weighed
- [x] Domain and key npm package availability confirmed for the chosen name — `lunos` and
      `lunos-ai` both available on npm; domain situation measured and judged non-discriminating
- [x] Downstream stories unblocked. Not reverting, so **no follow-up ticket to undo XCOD-4 is
      needed** — the conditional branch of this criterion does not apply.

## Downstream status after this freeze

| Story                     | Gate removed | Still blocked by                                                      |
| ------------------------- | ------------ | --------------------------------------------------------------------- |
| XCOD-23 README rebrand    | ✅           | terminal GIF/screenshot; parity table source doc missing              |
| XCOD-25 landing site      | ✅           | email-capture service account (note: `lunos-web` repo already exists) |
| XCOD-26 social handles    | ✅           | account creation — human action                                       |
| XCOD-28 GitHub org rename | ✅           | org-level permissions; outward-facing, owner-executed                 |
