# XCOD-53 — Lunos trademark: **preliminary risk signal — NOT a clearance search**

**Status:** preliminary risk assessment · **Date:** 2026-09-19 · **Prepared by:** desk research
**Epic:** XCOD-15 · **Follow-up from:** XCOD-17, XCOD-22 · **Ticket status:** remains To Do, blocked

> **This is not a trademark clearance and must not be relied on as one.** No register was
> authoritatively searched (see "What could not be verified"). No counsel was engaged. This document
> raises a risk signal and proposes how to resolve it — nothing more.

## The finding

**The senior user of the identical word mark is an EU company that is already active in Class 9 —
the class a software product files in.**

`LUNOS Lüftungstechnik GmbH & Co. KG für Raumluftsysteme` — Berlin, founded 1959, market leader in
decentralised residential ventilation, selling in 35+ countries. Registered at Amtsgericht
Charlottenburg HRA 59773.

The hard evidence:

| Field          | Value                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| US serial      | **79386509**                                                                                                                |
| Mark           | E²                                                                                                                          |
| Owner          | LUNOS Lüftungstechnik GmbH & Co. KG für Raumluftsysteme                                                                     |
| Filed          | 2023-09-05                                                                                                                  |
| Goods          | "Electric equipment and instruments namely, switches, time delays, interval and inverse circuits for heating, ventilating…" |
| Prefix meaning | `79`-series = **Madrid Protocol extension** — a German or EU basic mark sits behind it                                      |

Three things follow:

1. **They file internationally and recently.** A 2023 Madrid extension into the US is active brand
   protection, not a dormant 1959 registration.
2. **A basic mark exists in DE or EU.** That is what a Madrid extension extends _from_. It was not
   located (see below), but it exists.
3. **Their goods are electrical apparatus — Class 9.** Switches, timers and circuits sit in the same
   Nice class as downloadable software. The collision is not confined to Class 11 ventilation goods.

## Why this changes the picture

`xcod-22-name-freeze-decision.md` recorded trademark clearance as an open risk and reasoned that the
known name collisions did not occupy the EU-sovereignty positioning. That reasoning was about
_market_ overlap. This is a different axis: **register** overlap.

An identical word mark, held by an EU proprietor, with activity in Class 9, is a materially worse
starting position than "a German fan company happens to share the name." It does not make the name
unusable — but it makes the question real rather than theoretical, and it raises the value of asking
it before, not after, the name is expensive to change.

**It does not block shipping.** XCOD-22's freeze stands and its trigger — _before the first paid
pilot_ — is still the right gate. This sharpens the risk inside that gate; it does not move it.

## Secondary observation

**LUNO** (Luno Pte. Ltd., US serial 87198185) — near-identical mark, registered in **Class 36**
(currency exchange, digital-currency trading). Different class and sector, so lower relevance, but
worth listing since a US examiner assesses likelihood of confusion on sound and appearance, and
`LUNO`/`LUNOS` differ by one character.

## What could not be verified, and why

**Authoritative register searching is not performable from this environment.** Six attempts across
six sources, all blocked:

| Source                     | Attempt                     | Result                                |
| -------------------------- | --------------------------- | ------------------------------------- |
| USPTO `tmsearch.uspto.gov` | documented search API, POST | `MethodNotAllowed`                    |
| WIPO Global Brand Database | search API                  | altcha anti-bot challenge             |
| TMview (`tmdn.org`)        | search API, POST            | empty response                        |
| EUIPO eSearch              | direct URL                  | JS-only shell, no server-side results |
| DPMA register              | expert search URL           | JS-only shell, `noindex, nofollow`    |
| Justia Trademarks          | owner + search pages        | HTTP 403                              |
| `uspto.report`             | search page                 | HTTP 403                              |

Listed so nobody repeats the six attempts. These are deliberate protections, not transient failures.

**Therefore unknown:** whether any `LUNOS` EUTM exists in Class 9 or 42; the number and scope of the
basic mark behind US 79386509; whether any party holds `LUNOS` for software specifically; the status
(live/dead) of anything above.

## Recommended clearance plan

Sequenced cheapest-first, because step 1 may make step 3 much cheaper to ask.

**Step 1 — manual register searches (free, ~1 hour, a human with a browser).**

- **EUIPO eSearch plus** — `LUNOS`, filtered to Nice **Class 9** and **Class 42**; then again by
  owner name `LUNOS` to see the full portfolio.
- **TMview** — same query; covers EU national registers, so it catches German marks EUIPO alone
  misses.
- **WIPO Madrid Monitor** — look up international registration behind **US 79386509** to identify
  the basic mark, its office of origin, and its class list.
- **USPTO Trademark Search** — `LUNOS` and `LUNO`, Classes 9 and 42, live marks only.

Capture screenshots. Beyond informing the decision, register printouts are the kind of artefact a
procurement due-diligence file wants.

**Step 2 — assess.** If Class 9/42 is clear of `LUNOS` in both registers, risk drops sharply and the
question becomes a cheap confirmatory one. If a Class 9 `LUNOS` EUTM exists, step 3 becomes urgent
rather than prudent.

**Step 3 — counsel.** A Bulgarian/EU trade mark attorney, with step 1's results in hand. Ask
specifically: (a) is adoption of `Lunos` for Class 9/42 software defensible against the ventilation
proprietor; (b) is a Class 9/42 EUTM application likely to survive opposition; (c) does their Class 9
activity create a genuine likelihood-of-confusion problem or merely a coexistence question.

## Why the agent cannot close this

Every remaining step requires either a human-operated browser against an anti-bot-protected register,
or professional legal judgement. Neither is automatable. The ticket stays **To Do** rather than moving
to in Review, because its acceptance criteria call for actual register results and there are none.

## Open question for the owner

Given the Class 9 finding: run the free manual searches first (step 1), or go straight to counsel?
The finding strengthens the case for counsel, but step 1 costs nothing and makes counsel cheaper.
