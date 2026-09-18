# Lunos marketing & GTM plan

**Status:** v0.2 — **reconstructed 2026-09-18**
**Supersedes:** `claude/lunos-marketing-gtm-plan.md` v0.1

---

> ## ⚠️ Read this before citing this document
>
> **This is a reconstruction, not the original.** The v0.1 plan lived in the Claude project
> "AXCODE" (referenced throughout the XCOD epic as `claude/lunos-marketing-gtm-plan.md`) — that was
> a Claude-project file path, never a path in this git repository, which is why it does not exist
> here and could not be recovered.
>
> This document was rebuilt on 2026-09-18 from the XCOD tickets that quote v0.1 at length:
> XCOD-21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31. Where those tickets quote the plan verbatim, the
> wording is preserved and marked. Where they only summarise it, this reconstruction says so.
>
> **Section numbering is inferred** from the tickets' own "Reference: Sections N" lines and is
> therefore approximate. Do not treat a section number here as authoritative for a claim about v0.1.
>
> Content the tickets never quoted is **lost** and is marked `[GAP]` rather than invented.

---

## 1. Current-state assessment

_Source: XCOD-21 background, close paraphrase._

The plan's v0.1 review of the project found:

- The repo is still an essentially **unmodified `opencode` clone**, with no public Lunos-branded
  asset anywhere.
- The product has been **renamed three times in three days**: AXCODE → Ratio → Lunos.
- There is **no landing page, social presence, changelog, or public "why this exists" statement**
  that a stranger could find.

**The plan's central thesis, quoted:**

> Right now there is nothing to market, so the next 4-6 weeks of "marketing" work is building the
> assets and the narrative, not running campaigns — and publishing loudly on an unstable name or an
> unmodified fork would burn the one good launch moment this project gets.

## 2. Naming — "Priority Zero"

_Source: XCOD-22. Resolved; see below._

v0.1 flagged naming as **Priority Zero**. The collision risk recorded against "Lunos":

| Collision         | Nature                                              |
| ----------------- | --------------------------------------------------- |
| `lunos.ai`        | Active, funded AI-agents startup (~$5M pre-seed)    |
| `lunosrouter.com` | An LLM router                                       |
| `lunos.de`        | German company shipping its own AI product, "LUISA" |

None is a CLI coding agent directly, but each competes for search, HN and word-of-mouth attention.
"Ratio" had no direct collisions found and was noted as arguably safer on pure marketing clearance.

The decision criteria v0.1 demanded: domain availability, npm package availability,
App/marketplace listing conflicts, and search confusability — explicitly _not_ just "no other
coding agent uses this name."

**Resolved (XCOD-22, Done):** the name is **frozen as Lunos**. Trademark clearance remains
outstanding as a separate concern. See `.claude/docs/xcod-4-lunos-rename-decisions.md`.

## 3. Positioning

_Source: XCOD-23, quoted verbatim from v0.1 §3._

The one-liner:

> **Lunos is the EU-sovereign, self-hostable AI coding agent — opencode's infrastructure plus
> Claude Code's platform features, built so a public-sector procurement officer can actually
> approve it.**

**Rules attached to the positioning:**

- **Lead with sovereignty and compliance, not feature-parity.** Parity framing invites an
  unfavourable comparison before there is parity to show.
- State the **licence explicitly** on public surfaces, not just in a `LICENSE` file — MIT-style
  forks read as safer to enterprises than anything ambiguous.
- Carry a **non-affiliation clause** (also required by XCOD-1/XCOD-4 acceptance criteria).

XCOD-25 requires the landing page to reproduce this positioning **verbatim**.

## 4. Assets

_Source: XCOD-23, 25, 26, 27 (all cite §4)._

**The README is the single highest-leverage marketing asset for a dev tool** — v0.1's phrasing.
Required elements:

- The §3 one-liner, leading
- A working install command, verified end-to-end
- A terminal GIF or screenshot of Lunos actually running
- The parity table drafted in `product-vision-roadmap.md`, linked or embedded
- A link to the roadmap
- The non-affiliation clause

Supporting assets: a one-page landing site with email capture (§9.3), claimed social handles
(§9.4), and a "why we forked opencode" FAQ (§9.5).

## 5. Design partners — the highest-value channel

_Source: XCOD-29, XCOD-31._

Private outreach to **3-5 warm ECRIS/euLISA-adjacent and Axsion-network contacts**, characterised
in v0.1 as **"likely worth more than any public post at this stage."**

This is BD/PO-owned, not engineering; it is private outreach rather than a public post, and can
start immediately, independent of whether any public asset is ready.

## 6-7. Channel sequencing

_Source: XCOD-31, close paraphrase._

Once a first public post is ready, in priority order:

1. **GitHub itself** — README, roadmap, `good-first-issue` labels. Free and compounding.
2. **Reddit** — r/opensource, r/selfhosted, r/programming, r/LocalLLaMA. As _build-in-public
   updates_, not announcements.
3. **Fosstodon / EU Mastodon** — flagged as mattering more than X for this audience.
4. **The Digital SME Alliance relationship** — leveraging Petar's own CRA compliance guide
   co-authorship. Called out as **the cheapest, warmest distribution available.**
5. **opencode's own community / `ecosystem.mdx` page.**
6. **FOSDEM** (Brussels, early February) and **local Sofia meetups** — lower-cost rehearsal venues.

## 8. Metrics

_Source: XCOD-30._

Tracked from day one:

- GitHub stars and forks
- **Unique contributors** — a better OSS-credibility signal than stars alone
- CLI install counts
- README / landing-page → email-capture conversion
- **Design-partner conversations opened and signed reference deployments** — called out as _the
  metric that actually matters for this business model_

**Explicitly deprioritised as vanity metrics:** follower counts, post likes.

A manual proxy for install counts is acceptable if no telemetry exists yet.

## 9. Punch list

| §   | Action                                                                | Ticket          | Status  |
| --- | --------------------------------------------------------------------- | --------------- | ------- |
| 9.1 | Freeze the name                                                       | XCOD-22         | ✅ Done |
| 9.2 | Rebrand README; resolve 21 translated READMEs; rename GitHub org/repo | XCOD-23, 24, 28 | ✅ Done |
| 9.3 | One-page landing site with email capture                              | XCOD-25         | ✅ Done |
| 9.4 | Claim social/community handles                                        | XCOD-26         | ⬜ Open |
| 9.5 | "Why we forked opencode" FAQ                                          | XCOD-27         | ✅ Done |
| 9.6 | Private design-partner outreach                                       | XCOD-29         | ⬜ Open |
| 9.7 | Build-in-public publishing cadence                                    | XCOD-31         | 🔄 In Review |
| —   | GTM metrics tracking                                                  | XCOD-30         | ⬜ Open |

### 9.7 — cadence detail

_Source: XCOD-31._

**Delivered 2026-09-18.** The cadence is specified in
`.claude/docs/xcod-31-build-in-public-cadence.md` (triggers, format, channel-sequencing checklist),
seeded with a first real note at `.claude/docs/notes/2026-09-18-sprint-01.md`, and the Phase 0 exit
post is drafted and staged at `.claude/docs/xcod-31-phase-0-launch-post-draft.md`.

One implementation decision departs from v0.1's wording: **there is no root `CHANGELOG.md`.** The
release pipeline already generates per-release notes (`script/version.ts` → `script/changelog.ts` →
`gh release create --notes-file`), so a hand-maintained root changelog would duplicate it and add
an upstream merge surface. Notes live under `.claude/docs/notes/` instead, and answer *why* rather
than *what changed* — the half no generator produces.

A public CHANGELOG or "Lunos Weekly/Monthly Notes" habit — low effort, high compounding trust
signal. Milestone posts already identified:

- **Phase 0 exit** — "why we're forking opencode, EU-sovereign by design". **This is the actual
  launch moment, not before.**
- **Each Phase 1 milestone** — EU model routing live, self-hosted deployment guide, CRA/SBOM
  mapping. The CRA angle is flagged as genuinely newsworthy given the **May 2026 deadline**.
- **The marketplace epic (XCOD-7)** once shipped — demo-able, screenshot/GIF-friendly.

## 10. What not to do yet — an explicit gate

_Source: XCOD-21 and XCOD-31, both quoting v0.1's "what not to do yet" section._

**Hold Show HN, press outreach, and any paid channel** until **both**:

1. Phase 0 exits (XCOD-15 / XCOD-20), **and**
2. one real Phase 1 differentiator is live.

> A premature Show HN on an unmodified fork reads as vaporware and can't be redone.

This is described in the tickets as **an explicit gate, not a task** — nothing "completes" it; it
either holds or it is violated.

---

## Known gaps in this reconstruction

- `[GAP]` **§1's fuller competitive/market analysis** — only the current-state findings were quoted.
- `[GAP]` **§3 beyond the one-liner** — audience segmentation, messaging pillars, and objection
  handling are referenced by implication but never quoted.
- `[GAP]` **§6 vs §7 boundary** — XCOD-31 cites "Sections 5, 6, 7 & 9.7" as one block; which
  material sat in §6 versus §7 is unknown, so they are merged above.
- `[GAP]` **Any budget, timeline, or owner assignments** — never quoted in any ticket.
- `[GAP]` **§9.5's FAQ content** — XCOD-27 gives the two questions but not v0.1's model answers.

## Downstream effect on open tickets

Restoring this document cleared the **dangling-reference** blocker on XCOD-30 and XCOD-31 — their
acceptance criteria can now be read against a real source.

- **XCOD-30** still requires an actual tracked view (spreadsheet or dashboard) plus a decision on
  the install-count mechanism. **Still open.**
- **XCOD-31** — **delivered 2026-09-18, in review.** Cadence habit established and seeded, Phase 0
  exit post drafted and staged behind the §10 gate, channel sequencing documented as an operational
  checklist. See §9.7 above.
