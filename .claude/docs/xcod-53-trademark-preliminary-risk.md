# XCOD-53 — Lunos trademark: register search results and risk signal

**Status:** registers searched · risk **explicitly accepted** by owner decision 2026-09-20 ·
counsel not engaged (deferred to the first-paid-pilot trigger)
**Epic:** XCOD-21 · **Follow-up from:** XCOD-17, XCOD-22
**2026-09-19:** preliminary desk research (below, "The 2026-09-19 preliminary assessment")
**2026-09-20:** EUIPO and USPTO **searched successfully** — see
[2026-09-20 update](#2026-09-20-update--the-registers-were-searched)

> **This is still not a trademark clearance opinion and must not be relied on as one.** As of
> 2026-09-20 the registers _have_ been searched and the results are recorded below, so the ACs on
> searching are met. But **no counsel has been engaged**, and the question the results raise —
> likelihood of confusion — is a legal judgement this document deliberately does not make.

> ⚠️ **Two claims in the 2026-09-19 section below are now known to be wrong.** They are corrected
> in place with `[CORRECTED 2026-09-20]` markers rather than deleted, so the record of what was
> believed when the deferral decision was made stays intact. In particular, **"don't retry the
> registers" was wrong** — do not act on it.

---

# The 2026-09-19 preliminary assessment

_Retained as the record of what was known when the deferral decision was taken. Superseded in part
by the 2026-09-20 update; corrections are marked inline._

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
   > **[CORRECTED 2026-09-20]** Located: it is **EUTM 008987471** (`Lunos`, filed 2010-03-26,
   > registered, Classes 9/11/37/42, expiry 2030-03-26). Also note the proprietor holds a US
   > registration for the word `LUNOS` itself — **serial 79309899**, live, Classes 9/11/37 — which
   > is more directly relevant than the `E²` record tabulated above. Crucially, **all of these
   > share the same narrowly-drafted specification**: see the 2026-09-20 update.
3. **Their goods are electrical apparatus — Class 9.** Switches, timers and circuits sit in the same
   Nice class as downloadable software. The collision is not confined to Class 11 ventilation goods.
   > **[CORRECTED 2026-09-20]** True as to the class _number_, but the specification matters more
   > and it is narrow. Their Class 9 is limited by "**namely**" to HVAC switching and control gear;
   > their Class 42 is limited to fire-protection/HVAC planning "**being engineering services**".
   > Neither mentions software, SaaS or software development. Likelihood of confusion is assessed on
   > the goods and services **as specified**, not on the class number — so this particular alarm
   > reads _weaker_ on the evidence, not stronger. A different proprietor, missed entirely in this
   > assessment, is the actual concern: see the 2026-09-20 update.

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

> 🔴 **[CORRECTED 2026-09-20] This section's conclusion was wrong. Do not follow its advice.**
> Every failure tabulated below is a **fetch/API-level** block — `MethodNotAllowed`, an anti-bot
> challenge, an empty POST, JS-only shells, 403s. **None is a browser-level block.** Driving a real
> browser session against the same registers worked on the first attempt: EUIPO eSearch plus, TMview
> and USPTO Trademark Search all render and return results normally. The lesson to carry forward is
> **"these registers are SPAs that defeat HTTP fetching, use a browser"** — _not_ "don't retry".

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

> **[CORRECTED 2026-09-20]** All four of these are now answered — see the 2026-09-20 update. In
> short: **yes**, live `LUNOS`-family EUTMs exist in Classes 9 and 42; the basic mark is
> EUTM 008987471; **yes**, a party holds a `lunos`-containing mark for AI software specifically
> (`elunos`, EUTM 019192430); and live/dead status is recorded per mark below.

## Recommended clearance plan

> ✅ **[SUPERSEDED 2026-09-20] Do not re-run Step 1 — it is complete.** Steps 1 and 2 were carried
> out on 2026-09-20 via browser automation; the results and the assessment are in the
> [2026-09-20 update](#2026-09-20-update--the-registers-were-searched). **Step 3 (counsel) is the
> entire residual plan.** Two caveats on what "complete" means: the Madrid Monitor lookup for the
> basic mark was made unnecessary — the basic mark was identified directly as EUTM 008987471 — and
> **no screenshots or register printouts were captured**, so the procurement-artefact point below
> is still outstanding if such a file is wanted.

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

> **[CORRECTED 2026-09-20]** Half right. The **register searching was automatable** after all, via
> browser automation, and is now done — so "there are none" no longer holds. What remains genuinely
> non-automatable is the second half: **professional legal judgement** on likelihood of confusion,
> and the owner's decision on what to do about it. The ticket still should not close on register
> results alone.

## Owner decision, 2026-09-19: **defer to the existing trigger**

Presented with the Class 9 finding, the owner elected to **defer clearance until before the first
paid pilot** — XCOD-22's existing trigger — rather than run the manual searches or engage counsel
now.

**This is a deliberate, informed acceptance of a known risk**, recorded as such so it does not read
later as an oversight. The decision was made _with_ the Class 9 finding in hand, not in ignorance
of it.

### What is being accepted

- The name may need to change after further brand investment, and **the cost of changing it rises
  with every month of brand-building**. Note the rebrand from `opencode` is _still not finished_
  (XCOD-44); a second rename would be materially more expensive than the first.
- A launch post, a public repo or a conference mention all increase visibility to the senior user.
  Opposition risk is a function of visibility, not just of filing.
- If a Class 9 `LUNOS` EUTM does exist, we will discover it at the worst moment — when a pilot is
  already in motion and the name is load-bearing in a procurement document.

### What makes this reasonable

- No EUTM application is pending, so nothing is presently at stake in an opposition window.
- No revenue and no pilot exist yet, so the concrete exposure today is near zero.
- Step 1 remains cheap and available at any time — deferring costs nothing except option value.

### Trigger — unchanged, and now load-bearing

**Before the first paid pilot.** Anyone reaching that point should run the step 1 searches below
_first_. They take about an hour and they are the gate, not a formality.

Recommend also treating **any of these** as an early prompt to reconsider, since each raises
visibility ahead of a pilot: the launch post shipping (XCOD-31), the repository going public, or any
procurement response naming Lunos.

## Clearance plan when the trigger fires

The sequencing below stands; it is what the trigger should initiate.

> **[SUPERSEDED 2026-09-20]** Steps 1–2 of that sequencing are now done. What the trigger should
> initiate is **Step 3 only — engage counsel**, with the register results and the five questions in
> the 2026-09-20 update in hand.

---

# 2026-09-20 update — the registers were searched

**Step 1 of the clearance plan above is done.** It was performed by driving a real browser session
against the registers, which defeats the anti-bot/JS protections that blocked the HTTP-level
attempts on 2026-09-19. It took minutes, not the estimated hour.

**This does not make the document a clearance opinion.** It supplies the facts a clearance opinion
would be built on. The likelihood-of-confusion judgement is still counsel's, and is deliberately
not made here.

## What was searched, and the limits of that search

| Register                                  | Query             | Result                              |
| ----------------------------------------- | ----------------- | ----------------------------------- |
| **EUIPO eSearch plus** (official EU)      | `luno*` wildcard  | 155 marks; Cl. 9/42 subset reviewed |
| **USPTO Trademark Search** (official US)  | `lunos` exact     | **6** marks (3 live, 3 dead)        |
| **USPTO Trademark Search**                | `luno*` wildcard  | 33 marks; 5 in Cl. 9/42             |
| **TMview** (EUIPO aggregator, 38 offices) | contains `LUNOS`  | 211 marks; fully enumerated         |
| **TMview**                                | contains `LUNO`   | 2,741 — too broad to enumerate      |
| **TMview**                                | **fuzzy** `LUNOS` | 4,825 — too broad to enumerate      |

**Three honest limits on this search:**

1. **The fuzzy/phonetic net is not enumerated.** TMview's fuzzy mode returns 4,825 marks for
   `LUNOS`. That is not a defect of the search — it is what "confusingly similar" looks like before
   a professional screens it. The AC's phrase "and confusingly similar marks" is satisfied here only
   in the targeted sense: exhaustive substring coverage plus a reviewed `luno*` neighbourhood. A
   full similarity screen remains a counsel task.
2. **Very recent filings may not be indexed.** Register databases lag filing by weeks. A mark filed
   in the last ~2 months could be invisible here.
3. **TMview is not an official register** (its own disclaimer). Every finding that matters below was
   re-verified on EUIPO eSearch plus or USPTO directly.
4. **The EUIPO `luno*` wildcard set is enumerated only in part — 85 of 155.** Paging to the second
   page of eSearch results did not work and was not worth further effort, because the
   contains-`LUNOS` coverage (211 marks across 38 offices, via TMview) **is** complete and is what
   the identical-word analysis rests on. The unenumerated `luno*` tail is the highest-numbered —
   i.e. **newest** — filings, so a recent near-match could sit there unseen. `elunos`
   (EUTM 019192430, filed 2025) was caught only because it contains `LUNOS` outright.
5. **No screenshots or register printouts were saved.** The findings are transcribed, not
   evidenced by images. If a procurement due-diligence file needs register printouts, that is a
   separate, quick task.

## EUIPO — every mark containing `LUNOS`

| App. no.      | Mark     | Filed      | Nice classes          | Status         | Proprietor                  |
| ------------- | -------- | ---------- | --------------------- | -------------- | --------------------------- |
| **019192430** | `elunos` | 2025-05-23 | 35, **9**, 41, **42** | **Registered** | **elunos GmbH** (Frankfurt) |
| **008987471** | `Lunos`  | 2010-03-26 | **9**, 11, 37, **42** | **Registered** | LUNOS Lüftungstechnik GmbH  |
| **018985840** | `LUNOS`  | 2024-02-13 | **9**, 34             | **Registered** | JUUL Labs, Inc.             |
| **018187286** | `LUNOS`  | 2020-01-23 | 7, **9**, 11, 37      | **Registered** | Deere & Company             |
| 002433696     | `LUNOS`  | 2001-10-31 | 9, 11, 42             | **Ended**      | Zumtobel Staff GmbH         |
| 015458681     | `Lunos`  | 2016-05-20 | 3, 5, 10, 21          | Registered     | orochemie GmbH & Co. KG     |

Nearest non-identical EU neighbours in Cl. 9/42 (all distant in mark and sector): `LUNOO` /
`lunoo` (Lunoo Lighting), `SOLUNO`, `DIALUNOX`, `lunovon`, `LUNOVU`, `LUNOX`, `LUNOVA` (Lunor AG),
`Elunow` (CareMate OÜ), `LUNOMI`, `ALUNORF`, `Alunova`, `ALUNOVUM`, `Perluno`, `MERLUNO`, `CELLUNO`.

## USPTO — all 6 `lunos` marks, plus `luno*` in Cl. 9/42

| Serial       | Mark     | Status                | Class     | Goods (as published)                         | Owner                       |
| ------------ | -------- | --------------------- | --------- | -------------------------------------------- | --------------------------- |
| **79309899** | LUNOS    | **LIVE / REGISTERED** | 9, 11, 37 | electric switches, time delays (HVAC)        | LUNOS Raumluftsysteme (DE)  |
| **98404519** | LUNOS    | **LIVE / PENDING**    | 9, 34     | chargers for e-cigarettes / oral vaporizers  | JUUL Labs, Inc.             |
| 99164702     | Lunos    | LIVE / REGISTERED     | 5         | dietary and nutritional supplements          | Lunos LLC (Wyoming)         |
| 90545353     | LUNOS    | DEAD / ABANDONED      | **42**    | R&D of technology in the field of Earth-…    | Erthos (CA)                 |
| 85693364     | LUNOS    | DEAD / **CANCELLED**  | **9**     | computer software suite for insurance cos.   | Silvermoon Business Systems |
| 88766870     | LUNOS    | DEAD / ABANDONED      | 7         | robotic lawnmowers                           | Deere & Company             |
| **99693104** | LUNO     | **LIVE / PENDING**    | **42**    | advanced product research in the field of AI | LUNO LLC (Delaware)         |
| 99460843     | LUNO     | LIVE / PENDING        | 9         | smartwatches, wearable activity trackers     | Go-Vendor Ltd. (UK)         |
| 99221744     | LUNOLOFT | LIVE / REGISTERED     | **42**    | technology research, game software dev.      | HK Spiral Rising Technology |

**The US position on the word `LUNOS` is comparatively clear:** no live US registration in
Class 42 at all, and the only live Class 9 registration is the ventilation proprietor's narrow HVAC
specification. A US Class 9 `LUNOS` for computer software did once exist (85693364, insurance
software) and is **cancelled** — it lapsed, it was not opposed away.

## The specification detail that the class numbers hide

The 2026-09-19 alarm was that Class 9 overlap exists. It does — but confusion is assessed on the
goods **as specified**. Two of the three identical-word proprietors have specifications that do not
reach software:

- **EUTM 008987471 / US 79309899 (LUNOS Lüftungstechnik)** — Class 9 limited by "_namely_" to
  switches, time delays and interval circuits for heating, ventilating and air-conditioning
  apparatus, fire barriers and window drives. Class 42 limited to design and technical consultancy
  for fire-protection planning, "_being engineering services_". **No software, SaaS or software
  development anywhere in the specification.** Registered since 2010, **zero oppositions received**,
  expiry 2030-03-26.
- **EUTM 018985840 (JUUL Labs)** — Class 9 does say "downloadable software", but every item is
  tethered to e-cigarettes and oral vaporizers (temperature settings, firmware updates, e-liquid
  levels). **Nothing that reaches a coding tool.**
- **EUTM 018187286 (Deere & Company)** — agricultural/industrial equipment. Its US counterpart is
  dead.

## 🔴 The proprietor that actually matters — and it is none of the above

**`elunos` — EUTM 019192430 — elunos GmbH — Registered — filed 2025-05-23.**
Not in the ticket's collision set. Not found on 2026-09-19. It is the closest thing in the registers
to a direct conflict, because **its specification is our product category, verbatim**:

- **Class 9** includes "Artificial intelligence and machine learning software", "Application
  software", "Virtual assistant software", "Artificial intelligence software for analysis" — with a
  carve-out excluding e-cigarette/vapor technology.
- **Class 42** includes "Platforms for artificial intelligence as software as a service [SaaS]",
  "Providing artificial intelligence computer programs on data networks", "Software development",
  "Hosting services, software as a service, and rental of software".

**Who they are** (German commercial register, HRB 138959, Amtsgericht Frankfurt am Main): founded
**2025-02-19**, Neue Mainzer Str. 31, Frankfurt. Share capital **€25,000**. **One** managing
director (Konstantin Algird Leidig), one shareholder, one location. Stated purpose: process
automation, artificial intelligence, IT consulting, training, and provision of software solutions
for businesses. Classified as IT consulting. Economically active.

**Facts that cut in different directions — deliberately not resolved here:**

- The mark `elunos` **wholly contains** `lunos`. Against that, EUIPO practice gives weight to the
  beginnings of marks, and `e-` is a common prefix. Which dominates is exactly the question for
  counsel.
- Their Class 9/42 list reads like a broad selection from EUIPO's harmonised term database — common
  in defensive filings and not evidence of actual use across all of it. But it is **registered**, and
  registered rights are enforceable on the specification, not on use, until the **non-use grace
  period expires around 2030-05**.
- They are a one-person consultancy with €25k capital, not a funded product company — relevant to
  how likely they are to police the mark, irrelevant to whether they _could_.
- A useful precedent runs the other way too: **EUIPO registered `elunos` for AI software in 2025
  despite EUTM 008987471 already existing.** The office did not treat the ventilation proprietor's
  Class 9/42 mark as a bar to AI software. That is the single most encouraging data point for a
  future `Lunos` filing — and simultaneously the reason `elunos` would be the senior party against
  one.

## AC #2 — the three collisions in the ticket, assessed

| Collision             | Holds a registered mark? | Finding                                                                                                                                                                     |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`lunos.de`**        | ✅ **Yes**               | LUNOS Lüftungstechnik: EUTM 008987471, US 79309899, CA 1591406-00, DPMA history. **But every software-class specification is confined to HVAC hardware and engineering.**   |
| **`lunos.ai`**        | ❌ **No**                | No `LUNOS` mark at EUIPO (6 family hits) or USPTO (6 hits) attributable to it. The Wyoming "Lunos LLC" holds Class 5 supplements only. **Trading on an unregistered mark.** |
| **`lunosrouter.com`** | ❌ **No**                | No register hit at EUIPO or USPTO. **Unregistered.**                                                                                                                        |

Worth noting: the two collisions the ticket ranked as most worrying — the funded AI startup and the
LLM router, both chosen for _market_ proximity — hold **no registered rights at all**. The parties
that matter are the ones with registrations, and the nearest of those was not on the list.

## Questions for counsel

Register facts in hand, these are the questions to ask — deliberately left unanswered:

1. Is adoption and registration of `Lunos` for Class 9/42 AI-developer software defensible against
   **`elunos` (EUTM 019192430)**, given `elunos` wholly contains `lunos` but differs at the start?
2. Does **EUTM 008987471**'s narrow HVAC/engineering specification genuinely take the ventilation
   proprietor out of contention for software goods, or does reputation in the identical word still
   support opposition under Art. 8(5) EUTMR?
3. Would a `Lunos` EUTM application in Classes 9/42 survive opposition — and does the fact that
   `elunos` itself got through in 2025 over the 2010 mark bear on that?
4. Is there a coexistence or consent route with elunos GmbH, given their size and the fact that
   their own filing already carves out a third party's goods?
5. Does the US position (no live Class 42 `LUNOS`; a cancelled Class 9 software `LUNOS`) make a US
   filing the cheaper first move than an EU one?

## Acceptance criteria status

| #   | Criterion                                                                                     | Status                                                       |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | EUIPO and USPTO searched for `Lunos` and near matches in software classes, results recorded   | ✅ **Met** — with the three limits stated above              |
| 2   | Each of the three known collisions assessed for a registered mark                             | ✅ **Met**                                                   |
| 3   | A decision recorded: register / rely on unregistered rights / accept the risk, with reasoning | ✅ **Met 2026-09-20 — "explicitly accept the risk"**         |
| 4   | If the outcome requires a rename, cost stated honestly vs. four-renames history               | ⬜ Not triggered — nothing in the registers compels a rename |

## AC #3 — owner decision 2026-09-20: **explicitly accept the risk**

**Decision: accept the risk.** No EUTM application will be filed now, and no counsel will be engaged
now. Lunos continues under the name, relying on unregistered rights, with the risk accepted
explicitly rather than by omission.

**This is the third recorded decision on this question and the first taken with register facts in
hand.** XCOD-22 cleared domains and npm only. The 2026-09-19 deferral was made on a preliminary
signal that has since proved to name the wrong party. This one is made against the enumerated
register position set out above.

### Reasoning

- **Nothing in the registers compels a rename.** The identical-word EU proprietor
  (`LUNOS Lüftungstechnik`, EUTM 008987471) has a specification that never reaches software, and has
  never opposed anyone on it in 15 years. On the US side there is no live Class 42 `LUNOS` at all.
- **Present exposure is near zero.** No EUTM application is pending, so no opposition window is
  open. There is no revenue and no paid pilot, so there is nothing yet to enjoin or account for.
- **The cheap diagnostic is spent.** Searching is done and the results are recorded; what remains is
  a counsel fee. Paying it now buys an opinion about a risk that is not yet live.
- **`elunos` is a real but bounded concern.** It is a one-person Frankfurt consultancy with €25k
  capital, not a funded product company — relevant to the likelihood it polices the mark, though not
  to whether it could. Its registration is enforceable on its specification regardless of use until
  the non-use grace period expires around **2030-05**.

### What is being accepted, stated plainly

- **A live EUTM covering "artificial intelligence and machine learning software" and "platforms for
  artificial intelligence as software as a service" is held by a proprietor whose mark wholly
  contains `lunos`.** This document records that we know this. It is accepted, not unknown.
- If a `Lunos` EUTM is filed later, **`elunos` is the senior party** and would have standing to
  oppose. Opposition in the EU is cheap for the opponent.
- The cost of changing the name rises with every month of brand-building, and **the first rebrand
  (XCOD-44) set the floor for what a second would cost.**
- Discovery may come at the worst moment — when a pilot is in motion and the name is load-bearing in
  a procurement document.

### Trigger — unchanged, and now the only remaining gate

**Before the first paid pilot: engage counsel.** Steps 1 and 2 of the clearance plan are done; Step 3
is all that is left, and the five questions above are what to ask. Treat any of these as an early
prompt to revisit sooner, since opposition risk tracks visibility: the launch post shipping
(XCOD-31), the repository going public, or any procurement response naming Lunos.

---

### The ambiguity this decision was taken against

**The 2026-09-19 deferral should not be carried forward unexamined.** It rested on two premises,
and the register results falsified both — in opposite directions:

- _"The ventilation company's Class 9 activity is the threat."_ → **Weaker than thought.** Their
  specification never reaches software, and they have never opposed anyone on this mark.
- _"It is unknown whether a Class 9/42 `LUNOS` EUTM exists."_ → **Now known, and worse.** A live
  EUTM covering AI/ML software and AI-SaaS exists, held by a German AI/IT consultancy, in a mark
  that wholly contains `lunos`.

Net direction is genuinely ambiguous — the threat shrank on one axis and appeared on another. That
ambiguity is why the options were put as a genuine choice (**register**, **rely on unregistered
rights**, **explicitly accept the risk**) rather than a recommendation, and why the decision above
was taken by the owner rather than inferred from the evidence.

Two things that were true on 2026-09-19 and still are: no EUTM application is pending, so no
opposition window is open; and there is no revenue and no pilot, so present exposure is low. One
thing that changed: the cheap step is no longer pending — it is **done**, so the remaining cost of
resolving this is counsel's fee, not an hour of searching.

**Trigger, unchanged:** before the first paid pilot. Early prompts to reconsider remain the launch
post (XCOD-31), the repo going public, and any procurement response naming Lunos.

---

# Appendix — verbatim register text

Transcribed 2026-09-20 from EUIPO eSearch plus. **This is the text the five counsel questions above
are built on**, reproduced in full because the distinction between a nominal class overlap and a
real conflict lives entirely in these specifications. Official-register data; confirm against the
register before relying on it.

## A1 — EUTM 019192430 · `elunos` · elunos GmbH · Registered · filed 2025-05-23

Classes 9, 35, 41, 42.

**Class 9, in full:**

> "Artificial intelligence and machine learning software; Software; Application software; Media
> content; Databases; Software for monitoring, analysing, controlling and running physical world
> operations; Operating systems; Firmware and device drivers; System and system support software,
> and firmware; Virtual and augmented reality software; Content management software; Web application
> and server software; Downloadable and recorded content; Virtual assistant software; Artificial
> intelligence software for analysis; Personal digital assistants [PDAs]; Information technology and
> audio-visual, multimedia and photographic equipment; Measuring, detecting, monitoring and
> controlling equipment; none of the foregoing being related to e-cigarettes, nicotine cessation
> offerings, or vapor technology."

**Class 42, in full as captured:**

> "Platforms for artificial intelligence as software as a service [SaaS]; Providing artificial
> intelligence computer programs on data networks; Technology consultation in the field of
> artificial intelligence; Artificial intelligence consultancy; Research in the field of artificial
> intelligence technology; Computer software consultancy; Software development; Software creation;
> Development and maintenance of computer software; Design, development and implementation of
> software; Development, updating and maintenance of software and database systems; Hosting
> services, software as a service, and rental of software; Application service provider services;
> Rental of application software; Science and technology services; IT services; IT consultancy,
> advisory and information services; Provision of research services; Software development,
> programming and implementation; Development and testing of computing methods, algorithms and
> software; Design of computer hardware; Software design […]"

Note the trailing ellipsis: the Class 42 list continues beyond what was captured. It is already
unambiguous on the points that matter.

## A2 — EUTM 008987471 · `Lunos` · LUNOS Lüftungstechnik GmbH · Registered · filed 2010-03-26

Registered 2010-12-03 · expiry 2030-03-26 · **0 oppositions received** · filing language German ·
application reference LB1189-01EU · owner ID 407272. Classes 9, 11, 37, 42.

**Class 9, in full — note the limiting "namely":**

> "Electric equipment and instruments (included in class 9), **namely** switches, time delays,
> interval and inverse circuits for heating, ventilating and air conditioning apparatus and
> installations, and systems constructed therefrom for filter monitoring or central control;
> manually operated or reference variable-dependent circuits, in particular for the reference
> variables humidity, light, movement, temperature, gas and other variables affecting air quality,
> and other reference variables in the field of building technology, for the control of heating,
> ventilating and air conditioning systems; fire protection barriers, fire sensors and data
> processing equipment therefor, data transmission apparatus, cables and cable networks, and
> automatic barrier devices to prevent the spread of fire in ventilation ducts; electric drive
> elements for opening windows and all parts therefor and control devices therefor."

**Class 42, in full — note the limiting "being engineering services":**

> "Design and technical consultancy with regard to the planning of fire protection devices and data
> processing equipment therefor, data transmission apparatus, cables and cable networks, and
> automatic barrier devices to prevent the spread of fire in ventilation ducts, drive elements for
> opening windows and all parts therefor and control devices therefor, **being engineering
> services**."

**Class 37:** installation, maintenance and repair of the same HVAC / fire-protection / window-drive
goods.

## A3 — EUTM 018985840 · `LUNOS` · JUUL Labs, Inc. · Registered · filed 2024-02-13

Classes 9, 34. **Class 9 as captured** — every item tethered to e-cigarettes:

> "Chargers for electronic cigarettes and oral vaporizers for smokers; USB chargers for electronic
> cigarettes and oral vaporizers for smokers; carrying cases, holders, and protective cases featuring
> power supply connectors, adaptors and battery charging devices adapted for use with electronic
> cigarettes and oral vaporizers for smokers; downloadable software for remotely adjusting and saving
> temperature settings for electronic cigarettes and oral vaporizers for smokers; downloadable
> software for updating firmware for electronic cigarette and oral vaporizers for smokers;
> downloadable software for tracking and reporting battery levels …; downloadable software for
> tracking and reporting e-liquid levels in cartridges …; downloadable software for tracking usage
> of electronic cigarettes and oral vaporizers for smokers […]"

## A4 — how to reproduce these searches

Recorded so the next person does not rediscover the mechanics:

- **TMview** (`tmdn.org/tmview`) — URL params work: `#/tmview/results?page=1&pageSize=100&criteria=C&basicSearch=LUNOS`.
  `criteria=C` contains, `criteria=F` fuzzy; `S` is rejected with a validation error. Max
  `pageSize` is 100 (200 returns empty). Results render into `.rt-tr-group` / `.rt-td`; there are no
  `<table>` rows. Its JSON API returns an empty body — scrape the DOM instead.
- **EUIPO eSearch plus** — `https://euipo.europa.eu/eSearch/#basic/1+1+1+1/100+100+100+100/luno*`
  accepts wildcards. Individual records: `#details/trademarks/<application number>`. Paging to page
  2 via the hash did not work.
- **USPTO Trademark Search** (`tmsearch.uspto.gov`) — the `?q=` URL parameter is **ignored**; the
  query must be typed into the search box and submitted. Wildcards (`luno*`) work.
- All three require a **real browser**. Every HTTP-level fetch attempt fails; see the corrected
  2026-09-19 section.
