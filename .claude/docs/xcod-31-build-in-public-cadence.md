# Build-in-public cadence — runbook (XCOD-31)

> [!IMPORTANT]
> **The habit starts now; publication starts at Phase 0 exit.**
> Notes are written as work lands — that is the point of a cadence, and it cannot be
> back-filled convincingly later. But nothing in `.claude/docs/notes/` goes to a public
> channel until **Phase 0 exits (XCOD-15 / XCOD-20)**. Writing is ungated. Publishing is gated.
> See [The gate](#the-gate) before posting anything anywhere.

**Reference:** `.claude/docs/lunos-marketing-gtm-plan.md` §5, §6-7, §9.7, §10.

---

## Why this exists

A cadence of small public updates compounds trust in a way a single launch moment cannot. The
GTM plan calls it _low effort, high compounding trust signal_ — and it solves the content-calendar
problem permanently, because the roadmap's own phase-exit criteria decide what gets written and
when. Nobody has to invent something to say.

The failure mode this guards against is the opposite of silence: **a loud launch on an unmodified
fork.** That reads as vaporware and cannot be redone.

---

## What triggers a note

A note is written when one of these happens — not on a calendar:

| Trigger                                        | Note type           | Example                                                               |
| ---------------------------------------------- | ------------------- | --------------------------------------------------------------------- |
| A **roadmap phase exits**                      | Milestone post      | Phase 0 exit — the launch moment                                      |
| A **Phase 1 differentiator ships**             | Milestone post      | EU model routing live; self-hosted deployment guide; CRA/SBOM mapping |
| An **epic ships**                              | Milestone post      | The marketplace epic (XCOD-7) — demo-able, screenshot/GIF-friendly    |
| **~2 weeks of merged work** with no milestone  | Sprint note         | The seeded entry below                                                |
| A **decision worth showing the reasoning for** | Sprint note section | Merge-over-rebase (XCOD-16); the name freeze (XCOD-22)                |

If two weeks pass and none of the above fired, that is itself the signal — write nothing rather
than manufacture an update. An honest gap beats filler.

### The CRA angle is time-sensitive

The CRA/SBOM mapping milestone is flagged in the GTM plan as **genuinely newsworthy** given the
**May 2026 deadline**. When that milestone lands it warrants a milestone post, not a line in a
sprint note.

---

## Where notes live

```
.claude/docs/notes/YYYY-MM-DD-<slug>.md
```

Fork-owned, inside the gate, and **deliberately not a root `CHANGELOG.md`**:

- The release pipeline **already generates per-release notes** — `script/version.ts` runs
  `script/changelog.ts` to produce `UPCOMING_CHANGELOG.md` and feeds it to
  `gh release create --notes-file`. A hand-maintained root changelog would duplicate that.
- These are different artifacts. The generated changelog answers _what changed_. A build-in-public
  note answers _why we did it that way_ — the narrative half, which no generator produces.
- A root-level file is a **merge surface against upstream**. The upstream sync policy
  (`.claude/docs/xcod-16-upstream-sync-policy.md`) exists because conflict cost here is real and
  measured. Fork-owned paths under `.claude/` cost nothing to carry.

**This path is a staging area, not the published home.** `.claude/` is internal working space; a
note is _copied out_ to its public channel at publication time and the copy becomes canonical. The
staged file stays as the drafting record. `.claude/docs/notes/` never itself becomes public.

**Publication target once the gate opens:** GitHub Releases (attached to the release the note
covers) and/or GitHub Discussions. That keeps channel #1 — GitHub itself — as the canonical public
home, with every other channel linking back to it.

---

## Format template

```markdown
# Lunos Notes — <period or milestone>

**Date:** YYYY-MM-DD · **Covers:** <ticket range or phase>

## What shipped

<3-6 bullets. Each names the user-visible effect, not the commit.>

## What we decided, and why

<1-3 decisions with the reasoning shown. This is the part people actually read.>

## What is still broken or unproven

<Honest. Named blockers with ticket keys. Never omit this section.>

## Next

<2-3 items. No dates unless they are already committed publicly.>
```

**Tone rules** (inherited from `.claude/docs/xcod-27-fork-faq-draft.md`):

- **Never disparage upstream.** The fork exists because opencode is good enough to build on.
- **Never claim unverified parity or working installs.** Every claim must be true at publication
  time. If it is not yet verified, it goes in _"still broken or unproven"_ instead.
- Lead with sovereignty and compliance, not feature-parity (GTM plan §3).

---

## The gate

**Hold Show HN, press outreach, and any paid channel** until **both**:

1. Phase 0 exits — **XCOD-15** / **XCOD-20**, _and_
2. one real Phase 1 differentiator is live.

This is an explicit gate, not a task. Nothing completes it; it either holds or it is violated.

**Current status — 2026-09-18: the gate HOLDS. XCOD-15 and XCOD-20 are both open.**

Re-check both tickets before any publication. The gate is not satisfied by this document existing.

---

## Channel sequencing — operational checklist

Run top to bottom. **Do not skip ahead**; each tier assumes the one above it is already true.

> [!NOTE]
> **One deliberate reorder from XCOD-31's list.** The ticket enumerates GitHub → Reddit → Fosstodon
> → Digital SME → opencode ecosystem → FOSDEM/Sofia. This checklist keeps GitHub first and the
> venues last, but promotes **Digital SME and design partners above Reddit/Fosstodon** — because
> the GTM plan calls Digital SME _the cheapest, warmest distribution available_ (§6-7) and rates
> design-partner outreach above any public post at this stage (§5), and because both are **ungated**
> while the cold channels are not. Warm before cold; the relative order of the cold channels is
> unchanged from the ticket.

### Tier 0 — before anything is public

- [ ] **Gate check.** XCOD-15 and XCOD-20 both closed? If no, stop. Only Tier 1 items marked
      _(ungated)_ are available.
- [ ] One real Phase 1 differentiator live and demonstrable?
- [ ] Every claim in the note verified true _today_, not "true when drafted"?

### Tier 1 — GitHub itself _(free and compounding; start here always)_

- [ ] README current and leading with the §3 positioning _(ungated — already done, XCOD-23)_
- [ ] Roadmap visible and current _(ungated)_
- [ ] `good-first-issue` labels applied to real, genuinely small issues _(ungated)_
- [ ] Note published to Releases / Discussions

### Tier 2 — warm distribution _(cheapest, highest-trust — do before cold channels)_

- [ ] **Digital SME Alliance** — leverage the CRA compliance guide co-authorship. The GTM plan
      calls this _the cheapest, warmest distribution available_. Strongest fit for the CRA/SBOM
      milestone specifically.
- [ ] **Design partners** — 3-5 warm ECRIS/euLISA-adjacent and Axsion-network contacts (XCOD-29).
      Private outreach, _not_ a public post. **Ungated and can start immediately** — the GTM plan
      rates this above any public post at this stage.

### Tier 3 — community channels

- [ ] **Reddit** — r/opensource, r/selfhosted, r/programming, r/LocalLLaMA.
      As **build-in-public updates, not announcements.** Framing matters more than timing here.
- [ ] **Fosstodon / EU Mastodon** — matters more than X for this audience.
- [ ] **opencode's own community / `ecosystem.mdx`** — a fork listing itself respectfully.
      Read the tone rules above twice before writing this one.

### Tier 4 — venues _(low-cost rehearsal before any high-stakes post)_

- [ ] **FOSDEM** — Brussels, early February.
- [ ] **Local Sofia meetups.**

### Tier 5 — held behind the gate

- [ ] ~~Show HN~~ — **held.** One shot; spend it on a real differentiator.
- [ ] ~~Press outreach~~ — **held.**
- [ ] ~~Any paid channel~~ — **held.**

---

## Metrics to watch

Per GTM plan §8 and XCOD-30 — what a note is _for_, so cadence can be judged:

- GitHub stars and forks; **unique contributors** (a better OSS-credibility signal than stars)
- CLI install counts (a manual proxy is acceptable until telemetry exists)
- README / landing-page → email-capture conversion
- **Design-partner conversations opened and signed reference deployments** — _the metric that
  actually matters for this business model_

**Explicitly vanity, do not optimise for:** follower counts, post likes.

---

## Related

- `.claude/docs/lunos-marketing-gtm-plan.md` — the source plan
- `.claude/docs/xcod-31-phase-0-launch-post-draft.md` — the staged Phase 0 exit post
- `.claude/docs/xcod-27-fork-faq-draft.md` — the FAQ that answers the predictable objections
- `.claude/docs/xcod-16-upstream-sync-policy.md` — why fork-owned paths are preferred
