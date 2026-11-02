# "Why we forked opencode" — FAQ (DRAFT, UNPUBLISHED)

> [!IMPORTANT]
> **Status: drafted, deliberately unpublished.**
> Per XCOD-27, this is held back until **Phase 0 exit** (XCOD-15 / XCOD-20). Do not publish to the
> README, landing site, launch post, or any public channel before then.
>
> Two further gates apply:
>
> - **XCOD-22 (name freeze)** is unresolved. Every "Lunos" below becomes wrong if the name reverts
>   to Ratio. Re-read this document after that decision, don't just find-and-replace it — some
>   answers lean on what the name _signals_.
> - The install command and any parity claim must be true at publication time. Both are asserted
>   here as positioning, and neither is verified yet.

## Purpose

Two objections are entirely predictable in HN comments, a PR thread, or a procurement review.
Answering them badly once is expensive; answering them in advance, in the project's own words,
keeps the launch conversation on the actual product. Written now while the reasoning is fresh.

**Audience:** a skeptical developer or reviewer who suspects this is a vanity fork.
**Tone rule:** never disparage upstream. The fork exists because upstream is good enough to build
on. A fork that opens by attacking its parent reads as insecure and invites the community to take
the parent's side.

---

## Q1. Why fork opencode instead of building from scratch?

Because the hard, unglamorous 80% of an AI coding agent is already solved, and solved well, in
opencode — and none of it is where Lunos differentiates.

A terminal coding agent needs a provider-agnostic model layer, streaming tool-call orchestration,
session and context management, an LSP bridge, a permission model, a TUI that survives real
terminal emulators, and a release pipeline that ships signed binaries to macOS, Linux, and Windows.
That is years of work in which Lunos would have no opinion different from upstream's. Rebuilding it
would mean spending our entire first year re-earning parity we could have started from — and
arriving with a less mature product than the one we declined to use.

What we _do_ have an opinion about is jurisdiction: where the code goes, whose law governs the
processor, who can be compelled to hand over what, and whether an organisation with a
data-protection obligation can actually deploy the thing. That is a question about hosting,
deployment topology, data flow, and auditability — not about how to render a diff in a terminal.
Forking puts 100% of our effort on the part that is actually ours.

The second reason is honesty about the counterfactual. A from-scratch agent in 2026 would converge
on approximately opencode's architecture anyway, because the problem constrains the solution.
Writing it again to be able to say we wrote it is engineering vanity, not engineering.

opencode is open source precisely so this is allowed. We take that seriously in both directions:
Lunos carries a clear non-affiliation notice, does not present itself as endorsed by the opencode
team, and intends to contribute genuinely general improvements back upstream rather than hoarding
them. Where we diverge, we diverge because of the sovereignty thesis, not to create lock-in.

**The short version:** we forked so that our scarce engineering time goes into EU sovereignty and
the platform layer, not into re-implementing a terminal agent that already exists and works.

---

## Q2. Why isn't Lunos just "Claude Code with EU hosting"?

Because "with EU hosting" is doing far more work in that sentence than it sounds like, and because
hosting is only one of the three things that have to be true.

**First: it isn't ours to host.** Claude Code is a proprietary, closed-source product. There is no
version of it you can self-host, audit line by line, run inside your own VPC, or keep running if
the vendor changes terms. "Claude Code with EU hosting" is not a product anyone but Anthropic could
ship. Lunos is self-hostable and open, which is a structurally different offer — not the same
product in a different data centre.

**Second: sovereignty is not a server location.** Procurement reviewers and DPOs do not ask "which
region is this in." They ask who the controller and processor are, which jurisdiction's law can
compel disclosure, whether a non-EU parent company brings extraterritorial reach with it, what the
sub-processor chain looks like, what is logged and retained and for how long, and whether any of it
can be verified rather than promised. A region toggle answers none of those. Running EU-side on
infrastructure you control, with an auditable data path and a choice of model provider — including
EU-hosted and self-hosted models — answers all of them. That is an architectural property, not a
deployment setting.

**Third: model choice is the point, not a feature.** Lunos is provider-agnostic by inheritance from
opencode. An organisation that cannot send code to a US-headquartered provider at all still has a
working agent; one that can, keeps the frontier models. A single-vendor product cannot offer that
by construction, because the vendor is the product.

So the accurate framing is the inverse of the question. Lunos is not Claude Code relocated. It is
opencode's open, self-hostable, provider-agnostic foundation, plus the platform features that make
an agent usable by a team rather than an individual, assembled so that the deployment can survive a
procurement review instead of dying in one.

**What we are not claiming.** Lunos is not at feature parity with Claude Code today, and we will
not pretend otherwise — the roadmap is public precisely so the gap is legible. The claim is about
what each product _can_ structurally offer. A closed single-vendor product cannot become
self-hostable and provider-agnostic without ceasing to be itself. An open fork can close a feature
gap. Those are very different kinds of distance.

---

## Publication checklist (before this goes live)

- [ ] Phase 0 declared exited (XCOD-15 / XCOD-20)
- [ ] XCOD-22 name decision applied and the whole document re-read, not just find-and-replaced
- [ ] Every factual claim re-verified at publication time (self-hostability, provider-agnosticism,
      non-affiliation wording, roadmap link)
- [ ] Reviewed against the non-affiliation requirement from XCOD-1 / XCOD-4
- [ ] Decide the surface: README section, landing-site FAQ, or launch-post appendix (XCOD-23 /
      XCOD-25 / XCOD-31)

## Source note

The ticket references `claude/lunos-marketing-gtm-plan.md` Sections 4 & 9.5 as the source. **That
file does not exist anywhere in this repository** (checked at every path, including the secondary
working directory, which resolves to the same tree). This draft is therefore written from the
positioning captured in the XCOD tickets themselves — principally XCOD-22, XCOD-23's verbatim
one-liner, and the non-affiliation clause already live in `README.md`. If the GTM plan resurfaces,
reconcile this draft against Sections 4 and 9.5 before publishing; the arguments should hold, but
the emphasis and wording may need to match the plan's.
