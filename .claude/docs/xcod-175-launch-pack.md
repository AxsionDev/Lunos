# Public launch pack (XCOD-175, refreshed for v1.18.46 by XCOD-228): DRAFTS, UNPUBLISHED

> [!CAUTION]
> **Petar publishes these posts.** First drafted 2026-10-07 for v1.18.44 (XCOD-175), refreshed
> 2026-10-12 for v1.18.46 (XCOD-228). Nothing here has been posted anywhere. A Show HN can't be
> redone, so read it twice.

## Changes since the v1.18.44 draft

- **Release:** every claim is now about v1.18.46 (npm `latest`, published 2026-10-09). The note
  that left unreleased work out is gone, because that work shipped in v1.18.46.
- **New, in the posts:** agents you can edit, share as one file, and run unattended or on a
  schedule (XCOD-209, 210, 211); Claude Code and Codex CLI from Lunos, refused under an EU-only
  policy (XCOD-204); the model picker that tags and refuses models your policy blocks, plus
  Recommended and size filters (XCOD-212, 213); the XCOD-221 security fix, disclosed plainly.
- **Install:** posts point at npm or the install script only. The release archives aren't linked,
  because macOS kills a browser-downloaded archive (see the FAQ). "Gatekeeper will warn" is
  corrected to what actually happens.
- **Links:** every site link is `https://lunos.tech` (never `www.`, which has a certificate bug,
  XCOD-220). Docs stay at `https://docs.lunos.tech`.
- **Order:** the channel sections now follow the posting order in the ticket (§0).
- **Added:** "Gates before posting", a comment-watch FAQ (§6), and walkthrough scenes for the
  policy-aware picker and agents.
- **Removed:** the walkthrough's approval-gate (dev-cycle) scene and the `/tasks` sandboxed-fleet
  scene, because neither is in a released CHANGELOG section; the "sandboxed runs in Docker or
  Podman" bullets in Show HN and r/selfhosted, replaced by the unattended-agent sandbox claim
  (XCOD-211); "Gatekeeper and SmartScreen will warn", replaced by the install advice.
- **Not mentioned anywhere:** Lunos Cloud (groundwork only, not live), and XCOD-208 beyond what
  the CHANGELOG says.

## Gates before posting

All must hold on the day. Tick them in this order.

- [ ] **XCOD-227 merged:** CHANGELOG has the `## [1.18.46]` section, README no longer says "no
      documentation site yet", the docs Intro screenshot is fixed, and the GitHub social preview
      is uploaded.
- [ ] **XCOD-220 fixed** (`www.lunos.tech` serves the right certificate), **or** every link in
      every post uses `https://lunos.tech`. The drafts below already do; re-check any edits.
- [ ] **Clean-machine install of the current release on the day:**
      `npm i -g lunos-ai@latest --allow-scripts=lunos-ai`, then `lunos --version` shows the
      version npm reports as `latest`. Also run the install script once.
- [ ] docs.lunos.tech opens without a client-certificate prompt (XCOD-216).
- [ ] `[VIDEO]`, `[DAY]`, `[CONTACT]` and every `[PETAR: …]` line are filled.

## Gate check (GTM plan §10), as of 2026-10-12

| Condition                                                    | State                                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 exited (XCOD-15)                                     | ✅ Done                                                                                                                     |
| Clean-machine install verified (XCOD-20)                     | ✅ Done. Re-run on a clean machine **on the day** (gate above)                                                              |
| One real Phase 1 differentiator live                         | ✅ Data-residency controls with an egress audit log, enforced from v1.18.39; current v1.18.46                               |
| Name decision (XCOD-178)                                     | ✅ "Keep Lunos", cleared by ITService's in-house counsel                                                                    |
| Release the posts link to (XCOD-171) and docs URL (XCOD-173) | ✅ Done. v1.18.46 is npm `latest`. **Check docs.lunos.tech doesn't ask for a client certificate (XCOD-216) before posting** |

**Every claim below is about v1.18.46, the current release,** and traces to its CHANGELOG section
or an earlier released one.

### Claim discipline

Checked against the wording rules in `.claude/docs/xcod-55-infrastructure-sovereignty-decision.md`,
the claim table in `docs/deployment/self-hosted.md` §2, the GTM plan §3, and the say/don't-say table
and stated limits in "Lunos — Marketing Handover (Sprint 10, next release)" (Claude Doc, 9 Oct).
The 10 Oct v1.18.46 plan (`claude/lunos-v1.18.46-marketing-plan.md`) wasn't available when this was
refreshed; re-check against it before posting.

- ✅ Recommended is "a short list Lunos curates", never "best", "evaluated" or "benchmarked".
- ✅ Agent runs have "hard limits on time, spend and steps", never "can't overspend": the step
  that crosses the spend limit can go slightly over.
- ✅ Claude Code and Codex: "your own install and login", never "integrated with", "official" or
  "partnered with". Counsel's check (XCOD-204 AC6) was signed off on 9 Oct.

- ✅ Uses "EU-sovereign, self-hostable" and "EU-incorporated vendor". Never "sovereign cloud",
  "EU-sovereign infrastructure" or "EU-hosted" about Lunos: there is no Lunos-operated hosting.
- ✅ Leads with sovereignty and control. Claude Code and Codex are a feature, never the headline,
  and never "parity", "replacement" or "better than". Every post that names them says Lunos isn't
  affiliated with Anthropic or OpenAI.
- ✅ No CRA, EUCS, GDPR or other certification is claimed. The SBOM is described as what ships.
- ✅ The residency claim is scoped to what exists: control over **which provider may be used**,
  and **a record of what left**. EU-only is a policy you switch on, not the default.
- ✅ States the limits: binaries aren't code-signed, and feature parity with upstream isn't
  claimed. The XCOD-221 fix is disclosed, not hidden.
- ✅ No customers, pilots or Lunos-hosted service implied. Lunos Cloud isn't mentioned.
- ✅ MIT licence and non-affiliation stated in the text.

### Placeholders to fill before posting

- `[VIDEO]`: the walkthrough URL (lunos.tech and YouTube). The script is in §5. The older demo
  recordings (XCOD-152 and others) aren't in git or on the tickets, so only Petar can link them.
  They show v1.18.44 or older; AC2 asks for a recording on the released build.
- `[DAY]`: the planned day. Tuesday–Thursday, around 15:00–16:00 Sofia time, suits HN's US
  morning. Keep the afternoon free.
- `[CONTACT]`: the design-partner contact route, for example a mailbox on lunos.tech.
- `[PETAR: …]`: personal facts and anecdotes. Only you can write these. The drafts don't invent
  any.

---

## 0. Posting order

One day, in this order. Each step starts once the previous one is up.

1. Show HN (§1)
2. LinkedIn, company page (§2)
3. LinkedIn, Petar's own post (§3)
4. mastodon.social thread (§4a)
5. r/selfhosted (§4b)
6. Digital SME Alliance (§4c)

---

## 1. Show HN

**Title** (≤ 80 characters):

> Show HN: Lunos – an open-source coding agent that can refuse non-EU model providers

**Text:**

> I'm Petar. [PETAR: one sentence on your own work, in your words, e.g. who you build software for.]
>
> In European organisations, the question that stops an AI coding agent is rarely "is it good?" but
> "where does our code go, and can you prove it?"
>
> Lunos is a fork of opencode (MIT, like upstream) that adds controls for that question:
>
> - A data-residency policy: `"residency": { "allow": ["eu"] }` refuses any model provider that
>   doesn't process in the EU before a connection is made. That covers the US APIs, gateways that
>   route onward, and "configurable" clouds such as Azure or Bedrock until you say you've checked
>   the region. It looks at the endpoint, not only the provider name.
> - The model picker shows the policy: models it blocks are tagged "blocked by policy" and can't
>   be chosen. A Recommended filter shows a short list Lunos curates, EU and local models with a
>   one-line reason each. It's curated, not benchmarked.
> - An egress audit log, a hash-chained JSON Lines record of every model call and every refusal:
>   provider, region and host, never the content.
> - Agents you can edit, export as one file and import with a preview of what they may do, and
>   run unattended or on a cron schedule, in a Docker sandbox by default, with hard limits on time,
>   spend and steps. Unattended runs refuse every permission prompt and report it.
> - If you also use Claude Code or Codex CLI, Lunos can drive them with your own install and
>   login, and never stores or proxies those credentials. An EU-only policy refuses to start them,
>   and every session goes in the audit log.
> - Offline mode and an air-gapped guide (Ollama or vLLM on an isolated network). EU providers
>   out of the box: Mistral, Scaleway, OVHcloud, Hetzner.
>
> The vendor is an EU-incorporated company (ITService EOOD, Bulgaria). Self-hosting is the only way
> it ships: there's no Lunos-hosted service.
>
> One fix to call out: up to v1.18.44, with no provider key set, a first `lunos run` could send the
> prompt to opencode.ai, upstream's hosted free tier, outside the EU. v1.18.46 removes that
> fallback. If you tried an earlier version, please update.
>
> What it isn't yet: the binaries aren't code-signed, so on macOS install with npm or the script
> below rather than a downloaded archive. I don't claim feature parity with upstream. Each release
> ships an SBOM, but that's groundwork, not a CRA compliance claim.
>
> Install: `npm i -g lunos-ai@latest --allow-scripts=lunos-ai` (or
> `curl -fsSL https://raw.githubusercontent.com/AxsionDev/Lunos/dev/install | bash`).
> Site: https://lunos.tech · Repo: https://github.com/AxsionDev/Lunos · Docs:
> https://docs.lunos.tech · 4-minute walkthrough: [VIDEO]
>
> Not affiliated with or endorsed by the opencode project, Anthropic, OpenAI or any other model
> provider. I'd especially like to hear from anyone who has had to get an AI tool past a European
> procurement or DPO review: what did they ask for that nothing on the market could answer?

**On the day:** reply to every top-level comment for the first 3–4 hours. Use the FAQ in §6.
Answer criticism of the fork plainly and link the fork FAQ (`xcod-27-fork-faq-draft.md`, published
first or the same day). Don't argue about upstream.

---

## 2. LinkedIn, company page (Axsion / ITService)

> We've released **Lunos**, an open-source AI coding agent built for European organisations that
> have to know where their code goes.
>
> Most AI coding tools send source code to model providers outside the EU, with no way to stop it
> and no record of it. For hospitals, ministries and their suppliers, that ends the conversation
> before features are discussed.
>
> Lunos lets you set a residency policy. Under `"allow": ["eu"]`, it refuses any model provider
> that doesn't process in the EU, before a single request is sent. The model picker marks the
> models the policy blocks, and an audit log records every call that left and every one it
> refused. It runs on infrastructure you control, including fully offline.
>
> The latest release adds agents a team can share as one file and run on a schedule, in a sandbox
> and within set limits on time and spend. An organisation can lock permissions so no project or
> agent can loosen them.
>
> MIT-licensed, built by an EU-incorporated company, and self-hosted only.
>
> ▶ 4-minute walkthrough: [VIDEO]
> 🌐 https://lunos.tech
> ⭐ https://github.com/AxsionDev/Lunos
>
> If your organisation is evaluating AI coding tools under GDPR, NIS2 or procurement rules, we're
> looking for a few design partners: [CONTACT]
>
> #opensource #AI #softwaredevelopment #dataprotection #EU

## 3. LinkedIn, Petar's own post

> [PETAR: your own opening, a real moment when an AI coding tool was blocked or questioned because of where the code would go. Don't post an anecdote that didn't happen. If there isn't one, open with the question instead.]
>
> "Where does our code go?" is the question that stops AI coding tools in European organisations.
> Usually the honest answer is "to a US company, and we can't stop it or prove otherwise." I wanted
> one where the answer is a setting.
>
> Lunos is out today. It's an open-source fork of opencode with one opinion added: you decide which
> jurisdictions your code may be sent to, Lunos refuses everything else before a request is made,
> and you get an audit log to show your DPO. Agents can now be shared as one file and run on a
> schedule inside a sandbox, within limits you set.
>
> It's early. The binaries aren't signed yet, and there's plenty upstream does that we haven't
> touched. But the part that matters for European teams works, and it's MIT-licensed.
>
> Walkthrough: [VIDEO] · https://lunos.tech · Code: https://github.com/AxsionDev/Lunos
>
> If you've ever had an AI tool blocked by a DPO or a procurement review, I'd really like to hear
> what they asked for.

---

## 4. EU developer channels

Post in this order, after the LinkedIn posts. Fosstodon is invite-only, so use **mastodon.social**,
which is run by a German GmbH.

### 4a. mastodon.social thread

> 1/ I've released Lunos: an open-source AI coding agent for teams that need to control where
> their code goes. Built in Bulgaria, MIT-licensed, self-hosted only. 🧵
>
> 2/ The core idea: `"residency": {"allow": ["eu"]}` and Lunos refuses any model provider outside
> the EU, before a request is sent. US APIs, gateways that route onward, and unverified "regional"
> clouds are all refused. The model picker tags them "blocked by policy".
>
> 3/ Every model call and every refusal goes to a hash-chained audit log, with provider, region and
> host, never the content. That's something you can show a DPO.
>
> 4/ EU providers work out of the box: Mistral, Scaleway, OVHcloud, Hetzner. Or run everything
> locally with Ollama or vLLM, fully offline.
>
> 5/ New in this release: agents you can share as one file and run on a schedule, sandboxed, with
> limits on time and spend. And a fix: up to v1.18.44, with no key set, a first run could reach
> upstream's hosted free tier outside the EU. Please update.
>
> 6/ It's early: no code signing yet, and no parity claims with opencode, which it's forked from.
> Install with npm or the install script in the README.
> Walkthrough: [VIDEO] · https://lunos.tech · https://github.com/AxsionDev/Lunos #opensource #EU
> #DigitalSovereignty

### 4b. r/selfhosted (build-in-public update, not an announcement)

**Title:**

> I forked opencode to add a data-residency policy: the agent refuses model providers outside a
> region you choose, and logs every call

**Body:**

> Self-hosting the agent is easy. Knowing where your code goes once the agent calls a model is the
> hard part. That's what I added:
>
> - `"residency": { "allow": ["eu"] }`. Providers that don't process in the allowed regions are
>   refused before a connection is made, and the model picker tags them "blocked by policy". A
>   provider's built-in claim only counts at its own API host, so pointing a client at some other
>   URL doesn't pass the check.
> - Your own endpoints (vLLM, Ollama on another box) get a declared region in
>   `residency.endpoints`. The audit log records them as _declared_, so nobody mistakes your word
>   for a verified fact.
> - The audit log is hash-chained JSON Lines, with host and region, never content. It can now be
>   forwarded off the machine under an EU-only policy, once you declare where the destination
>   processes data (`audit.forward.region`).
> - `LUNOS_OFFLINE=1` stops every outbound call Lunos makes on its own behalf. The air-gapped guide
>   covers Ollama and vLLM on an isolated network.
> - Agents can run unattended or on a cron schedule (launchd, systemd or Task Scheduler), in the
>   Docker sandbox by default, with hard limits on time, spend and steps. Nobody approves anything
>   mid-run: every permission prompt is refused and reported.
> - Fixed in this release: up to v1.18.44, with no provider key set, a first `lunos run` could
>   send the prompt to opencode.ai, upstream's hosted free tier. That fallback is gone.
>
> Install: `npm i -g lunos-ai@latest --allow-scripts=lunos-ai` or the install script in the README.
> Not code-signed yet. MIT, and not affiliated with upstream. Feedback on the residency model
> especially welcome: what would you need it to cover that it doesn't?
>
> https://github.com/AxsionDev/Lunos · https://lunos.tech

### 4c. Digital SME Alliance (newsletter or members' channel)

Lead with the regulatory angle, which is what this audience opens for.

> **An open-source coding agent with an EU data-residency switch**
>
> European SMEs adopting AI coding tools face a question most tools can't answer: where does the
> source code go? **Lunos**, from Bulgarian SME ITService, is an MIT-licensed coding agent that can
> refuse model providers outside the EU before any data is sent, and that keeps an audit log of
> every model call and every refusal. It runs on the company's own machines, or fully offline.
>
> An organisation can lock permissions centrally, so no project or agent can loosen them, and can
> turn off importing agents from outside.
>
> Each release ships a software bill of materials, which helps SMEs map their own Cyber Resilience
> Act and NIS2 obligations. It isn't a certification, and none is claimed.
>
> https://lunos.tech · https://github.com/AxsionDev/Lunos · https://docs.lunos.tech

---

## 5. Walkthrough video script (≤ 5 min)

Record on the released build (v1.18.46 or later) in a clean VM or container, on a terminal of
120×36 or more. Use an EU provider key, Mistral for example. Install with npm, not a downloaded
archive (see the macOS answer in §6).

| Time | Scene            | On screen                                                                                                    | Say                                                                                           |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 0:00 | Problem          | Title card                                                                                                   | "Your AI coding agent sends your code somewhere. Lunos lets you decide where, and proves it." |
| 0:15 | Install          | `npm i -g lunos-ai@latest --allow-scripts=lunos-ai`, then `lunos --version` (1.18.46 or later)               | "One command. MIT-licensed, nothing to sign up for."                                          |
| 0:35 | Residency policy | `opencode.json` with `"residency": {"allow": ["eu"]}`, then `lunos models` showing "blocked by policy"       | "Allow only the EU. Everything else is marked blocked."                                       |
| 0:55 | Picker           | TUI model picker: blocked models listed last; pick one, the reason shows; `ctrl+l` to Recommended            | "You can't pick a blocked model, and Recommended shows EU and local options."                 |
| 1:20 | Refusal          | `lunos run -m anthropic/… "hi"` refused with the reason, then `tail` of the audit log showing `model.denied` | "A US provider is refused before any request, and the refusal is in the audit log."           |
| 1:45 | First task       | `lunos` TUI on a small repo with Mistral: "add input validation to parse.ts and a test"                      | "An EU provider works normally."                                                              |
| 2:40 | Agents           | `lunos agent export reviewer`, then `lunos agent import reviewer.lunos-agent` showing the preview            | "Share an agent as one file. Before anything is written, you see what it may do."             |
| 3:20 | Unattended       | `lunos agent run reviewer --prompt "…" ` in the sandbox with limits, then the report; `--schedule` mentioned | "Run it unattended or on a schedule, sandboxed, with limits on time and spend."               |
| 4:30 | Close            | https://lunos.tech, repo URL, docs.lunos.tech, "MIT · EU-incorporated vendor · self-hosted"                  | "It's early, and we'd like to hear what your DPO asks."                                       |

The approval-gate scene from the v1.18.44 draft is dropped: it isn't in any released CHANGELOG
section, and the agent scenes are what's new. The XCOD-152 guardrails demo can stand in for the refusal scene if it runs short. Claude
Code and Codex are left out of the video on purpose: they'd need a vendor login on screen, and the
video leads with sovereignty.

---

## 6. Launch-week watch (AC4)

- [ ] For 7 days from `[DAY]`, triage GitHub Issues within 24 hours: label each one, reply, and
      file every bug in XCOD with the issue link.
- [ ] Each day, answer HN, Reddit and Mastodon replies within working hours, using the FAQ below.
      File every bug report from them in XCOD too. Every question gets an answer or a ticket.
- [ ] Day 0: before posting, run every item in "Gates before posting".
- [ ] Day 1 and Day 7: record the numbers in §7.

### Comment-watch FAQ

Short answers to paste or adapt. Keep them factual; link the docs rather than arguing.

**"The macOS download won't open" / "macOS says it's damaged or kills it."**
The binaries aren't code-signed or notarised yet. A release archive downloaded from GitHub in a
browser is quarantined, and macOS Gatekeeper kills the binary. Install with npm
(`npm i -g lunos-ai@latest --allow-scripts=lunos-ai`) or the install script, which aren't affected.
If you already downloaded the archive, remove the quarantine flag first:
`xattr -d com.apple.quarantine ./lunos` (on the extracted binary). We're working on signed macOS
binaries.

**"npm installed it but `lunos` says the postinstall script was not run."**
npm 12 no longer runs install scripts by default. Reinstall with `--allow-scripts=lunos-ai`.

**"Did Lunos send my prompts to opencode's servers?"**
Possibly, if you ran v1.18.44 or earlier with no provider key set: a first `lunos run` could send
the prompt to opencode.ai, upstream's hosted free tier, a non-EU third party, which then refused
it. v1.18.46 removes that fallback; the `opencode` provider loads only when you give it a key. With
no provider set up, Lunos now tells you to run `lunos auth login` or set an API key. Please update.

**"If Lunos runs Claude Code or Codex, does my code go to the US?"**
Yes, to their vendors: those tools talk to Anthropic and OpenAI, with your own install and login.
Lunos never stores, copies or proxies the credentials. That's why a residency policy that doesn't
allow the vendor's region refuses to start them, and every session is in the audit log. An
organisation can switch the feature off. Lunos isn't affiliated with Anthropic or OpenAI.

**"Does every Claude Code / Codex action come to Lunos for approval?"**
Only the approvals those tools ask for. Anything their own configuration already allows (Claude
Code's allow rules or hooks, for example) never reaches Lunos. Codex is driven through
`codex app-server`, which OpenAI marks experimental. See `docs/external-agents.md`.

**"Can a scheduled agent run up a bill?"**
Each run has hard limits on time, spend and steps. Spend is counted when a step finishes, so the
step that crosses the limit can take it slightly over; no step starts after that. On Linux, a
scheduled agent runs only while you're logged in unless `loginctl enable-linger` is set.

**"Is there a hosted service / do I need an account?"**
No. There's no Lunos-hosted service and nothing in Lunos needs an account. Self-hosting is the
only way it ships.

**"Is it GDPR / CRA compliant? Certified?"**
No certification is claimed. Lunos gives you controls (a residency policy, an audit log, locked
organisation settings, offline mode) and each release ships an SBOM. Your compliance is still
yours to assess. There's no May 2026 CRA deadline; see the XCOD-54 assessment if asked for detail.

**"Does it only run EU models?"**
No. It's provider-agnostic. EU-only is a policy you switch on.

**"Why a fork instead of upstream contributions?"**
Link the fork FAQ (`xcod-27-fork-faq-draft.md`). Lunos merges upstream regularly (`/status` shows
`based on opencode 1.18.34`). Don't argue about upstream.

**"Is this a Claude Code replacement?"**
No. It has Claude Code-style skills, hooks and subagents, and Claude Code subagent files import
with a report of the fields that didn't carry over. We don't claim parity with Claude Code or with upstream opencode.

**"Can an imported agent do anything it likes?"**
No. Import shows what the agent may do, what it adds and where its model runs before writing
anything. Imported agents ask before bash, edits and subagents unless you pass `--trust`. An
organisation can turn imports off.

## 7. Launch report template (AC5, after day 7)

| Metric                              | Day 0 | Day 7 | Source                                  |
| ----------------------------------- | ----- | ----- | --------------------------------------- |
| GitHub stars / forks                |       |       | repo Insights                           |
| Unique contributors (issues + PRs)  |       |       | repo Insights                           |
| npm weekly downloads (`lunos-ai`)   |       |       | npmjs.com / `npm view lunos-ai`         |
| Release asset downloads             |       |       | `gh api repos/AxsionDev/Lunos/releases` |
| lunos.tech / docs visits            |       |       | site analytics                          |
| Issues opened / bugs filed in XCOD  |       |       | GitHub / Jira                           |
| Design-partner conversations opened |       |       | Petar                                   |

Then: **the top 3 objections** (quoted), **what we change** because of them, and where each change
is tracked in XCOD.
