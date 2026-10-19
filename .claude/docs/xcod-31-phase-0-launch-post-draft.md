# Phase 0 exit launch post — DRAFT, UNPUBLISHED

> [!CAUTION]
> **DO NOT PUBLISH.** This is the single launch moment for this project and it cannot be redone.
>
> **Release condition — all must be true:**
>
> 1. **XCOD-20** closed — Lunos verified installing end-to-end on a clean machine. The post links
>    an install command; if that command fails for the first stranger who runs it, the launch is
>    spent.
> 2. **XCOD-15** closed — Phase 0 governance, CI, and legal foundation complete.
> 3. **One real Phase 1 differentiator live.** As of this draft, none is. Publishing on an
>    essentially unmodified fork reads as vaporware.
> 4. Every factual claim below re-verified _on the day_, not trusted from this draft.
> 5. `[BRACKETED]` placeholders resolved — each marks a claim that cannot be written truthfully yet.
>
> **Do not** copy this into the README, a GitHub Release body, a Discussion, the landing site, or
> any draft that renders publicly. It lives here, in a fork-owned docs path, on purpose.
>
> Gate source: `.claude/docs/lunos-marketing-gtm-plan.md` §10 · Cadence:
> `.claude/docs/xcod-31-build-in-public-cadence.md`

**Target channels, in order:** GitHub (Release + Discussion) → Digital SME Alliance → Reddit
(r/opensource, r/selfhosted, r/LocalLLaMA) → Fosstodon. See the cadence runbook's Tier list.
**Show HN is a separate decision, held behind an additional differentiator.**

---

## Draft

### Lunos: an EU-sovereign AI coding agent, forked from opencode

There is no shortage of AI coding agents. There is a shortage of AI coding agents that a European
hospital, ministry, or defence supplier can actually deploy.

That gap is not about features. It is about jurisdiction: where the code goes when you ask a
question, whose law governs the processor that answers, who can be compelled to hand over what, and
whether any of it can be demonstrated to an auditor. For a large class of European organisations
these questions are answered before the feature list is ever opened — and they are usually answered
"no".

Lunos exists to answer them "yes".

> **Lunos is the EU-sovereign, self-hostable AI coding agent — opencode's infrastructure plus
> Claude Code's platform features, built so a public-sector procurement officer can actually
> approve it.**

### Why fork instead of build

The unglamorous 80% of a terminal coding agent is already solved, and solved well, in
[opencode](https://github.com/sst/opencode): a provider-agnostic model layer, streaming tool-call
orchestration, session and context management, an LSP bridge, a permission model, a TUI that
survives real terminal emulators, and a release pipeline that ships to macOS, Linux, and Windows.

None of that is where we have a different opinion. Rebuilding it would mean spending our first year
re-earning parity we could have started from, and arriving with a less mature product than the one
we declined to use.

What we do have an opinion about is deployment topology and data flow — which is a question about
hosting, auditability, and jurisdiction, not about how to render a diff in a terminal. Forking puts
all of our effort on the part that is actually ours.

We are not forking because opencode is bad. We are forking because it is good enough to build on,
and because the thing we want to add is not something upstream should be expected to carry.

### What sovereignty means here, concretely

Vague claims about sovereignty are worth nothing, so — specifically:

- **Self-hostable end to end.** [BRACKET: state exactly what can be self-hosted as of publication
  — model routing, session storage, telemetry — and what still requires an external service. Do
  not round up.]
- **EU model routing.** [BRACKET: name the providers and regions actually supported at
  publication. Omit this bullet entirely if XCOD Phase 1 routing is not live.]
- **A CRA and SBOM story.** The EU Cyber Resilience Act obligations land in **May 2026**, and
  "which components are in this tool and who is responsible for them" becomes a question with a
  legal answer attached. [BRACKET: state what SBOM tooling actually ships. Do not promise
  compliance — describe what is provided and let the reader map it to their own obligation.]
- **MIT-licensed**, stated here and not only in a `LICENSE` file.
- **Not affiliated with, or endorsed by, the opencode project or Anthropic.**

### What this is not, yet

[BRACKET: keep this section. It is the reason the rest is credible — a launch post with no
limitations section reads as marketing and gets treated as such. Populate from the current
"still broken or unproven" list at publication time. Candidates: feature parity with upstream,
signing status, which platforms are verified, what Phase 1 has not yet delivered.]

We would rather you find the gaps here than in your first hour with the tool.

### Try it

```
[BRACKET: the verified install command — XCOD-20 must be closed for this line to exist]
```

[BRACKET: terminal GIF or screenshot of Lunos actually running. GTM plan §4 lists this as a
required README element; it is equally required here. Text-only launch posts for terminal tools
underperform badly.]

- Roadmap: [BRACKET: link]
- Why we forked, in more detail: [BRACKET: link the published FAQ — see
  `.claude/docs/xcod-27-fork-faq-draft.md`, which must be published first or simultaneously]
- Good first issues: [BRACKET: link — have real ones labelled before posting, not after]

### If you are a European organisation evaluating this

We are talking to a small number of design partners — organisations with a real
data-protection or procurement constraint that off-the-shelf agents fail. If that is you,
[BRACKET: contact route]. That conversation is more useful to us than a star.

---

## Channel-specific adjustments

| Channel                                  | Adjustment                                                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **GitHub Release / Discussion**          | Publish as-is. This is the canonical version; everything else links here.                                                 |
| **Digital SME Alliance**                 | Lead with the CRA section, not the fork story. This audience cares about the May 2026 deadline first.                     |
| **r/opensource, r/selfhosted**           | Lead with self-hosting specifics. Trim the procurement framing — it reads as enterprise marketing to this audience.       |
| **r/LocalLLaMA**                         | Lead with model routing and what runs locally. The sovereignty framing is secondary; the technical substance is the draw. |
| **Fosstodon / EU Mastodon**              | Thread, not a link drop. Lead with the EU angle — it is the reason this audience is the right one.                        |
| **opencode community / `ecosystem.mdx`** | Shortest form. A respectful listing, no positioning-against. Re-read the tone rules first.                                |

## Pre-publication checklist

- [ ] XCOD-20 closed — clean-machine install verified
- [ ] XCOD-15 closed — Phase 0 exited
- [ ] One real Phase 1 differentiator live and demonstrable
- [ ] Every `[BRACKET]` resolved or its section deleted
- [ ] Install command run on a genuinely clean machine, today
- [ ] "What this is not, yet" section populated honestly
- [ ] FAQ (XCOD-27) published or publishing simultaneously
- [ ] `good-first-issue` labels applied to real issues
- [ ] Terminal GIF captured
- [ ] Non-affiliation clause present
- [ ] Nothing in the post disparages upstream
- [ ] Someone other than the author has read it
