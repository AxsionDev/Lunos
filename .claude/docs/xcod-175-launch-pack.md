# Public launch pack (XCOD-175): DRAFTS, UNPUBLISHED

> [!CAUTION]
> **Petar publishes these posts.** Drafted 2026-10-07 on the PO's go-ahead, for review. Nothing here
> has been posted anywhere. A Show HN can't be redone, so read it twice.

## Gate check (GTM plan §10), as of 2026-10-07

| Condition                                                    | State                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Phase 0 exited (XCOD-15)                                     | ✅ Done                                                                                            |
| Clean-machine install verified (XCOD-20)                     | ✅ Done. Re-run the install command on a clean machine **on the day**                              |
| One real Phase 1 differentiator live                         | ✅ Data-residency controls with an egress audit log, released (v1.18.39 onwards; current v1.18.44) |
| Name decision (XCOD-178)                                     | ✅ "Keep Lunos", cleared by ITService's in-house counsel                                           |
| Release the posts link to (XCOD-171) and docs URL (XCOD-173) | ✅ Done. **Check docs.lunos.tech doesn't ask for a client certificate (XCOD-216) before posting**  |

**Every claim below is about v1.18.44, the current release.** Work merged to `dev` but not yet
released (blocked-by-policy tags in the model picker, Recommended filters, `/settings` → Agents,
driving Claude Code from Lunos) is left out. Add it only once it ships.

### Claim discipline

Checked against the wording rules in `.claude/docs/xcod-55-infrastructure-sovereignty-decision.md`:

- ✅ Uses "EU-sovereign, self-hostable" and "EU-incorporated vendor". Never "sovereign cloud" or
  "EU-sovereign infrastructure": there is no Lunos-operated hosting.
- ✅ No CRA, EUCS or other certification is claimed. The SBOM is described as what ships, not as
  compliance.
- ✅ The residency claim is scoped to what exists: control over **which provider may be used**, and
  **a record of what left**.
- ✅ States the limits: binaries aren't code-signed, and feature parity with upstream isn't claimed.
- ✅ MIT licence and non-affiliation stated in the text.

### Placeholders to fill before posting

- `[VIDEO]`: the walkthrough URL (lunos.tech and YouTube). The script is below. The recorded
  demos from XCOD-152–154, 162 and 163 aren't in git or on the tickets, so only Petar can link them.
- `[DAY]`: the planned day. Tuesday–Thursday, around 15:00 CET, suits HN's US morning.
- `[CONTACT]`: the design-partner contact route, for example a mailbox on lunos.tech.
- `[PETAR: …]`: personal facts and anecdotes. Only you can write these. The drafts don't invent
  any.

---

## 1. Show HN

**Title** (≤ 80 characters):

> Show HN: Lunos – an open-source coding agent that can refuse non-EU model providers

**Text:**

> I'm Petar. [PETAR: one sentence on your own work, in your words, e.g. who you build software
> > for.] In European organisations, the question that stops an AI coding agent is rarely "is it
> good?" but "where does our code go, and can you prove it?"
>
> Lunos is a fork of opencode (MIT, like upstream) that adds controls for that question:
>
> - A data-residency policy: `"residency": { "allow": ["eu"] }` refuses any model provider that
>   doesn't process in the EU before a connection is made. That covers the US APIs, gateways that
>   route onward, and "configurable" clouds such as Azure or Bedrock until you say you've checked
>   the region. It looks at the endpoint, not only the provider name.
> - An egress audit log, a hash-chained JSON Lines record of every model call and every refusal:
>   provider, region and host, never the content.
> - Offline mode and an air-gapped guide (Ollama or vLLM on an isolated network), plus sandboxed
>   runs in Docker or Podman.
> - EU providers out of the box: Mistral, Scaleway, OVHcloud, Hetzner.
>
> The vendor is an EU-incorporated company (ITService EOOD, Bulgaria). Self-hosting is the only way
> it ships: there's no Lunos-hosted service.
>
> What it isn't yet: the binaries aren't code-signed, so Gatekeeper and SmartScreen will warn. I
> don't claim feature parity with upstream. Each release ships an SBOM, but that's groundwork, not
> a CRA compliance claim.
>
> Install: `npm i -g lunos-ai@latest --allow-scripts=lunos-ai` (or
> `curl -fsSL https://raw.githubusercontent.com/AxsionDev/Lunos/dev/install | bash`).
> Repo: https://github.com/AxsionDev/Lunos · Docs: https://docs.lunos.tech · 4-minute walkthrough:
> [VIDEO]
>
> Not affiliated with or endorsed by the opencode project or any model provider. I'd especially
> like to hear from anyone who has had to get an AI tool past a European procurement or DPO review:
> what did they ask for that nothing on the market could answer?

**On the day:** reply to every top-level comment for the first 3–4 hours. Answer criticism of
the fork plainly and link the FAQ (`xcod-27-fork-faq-draft.md`, published first or the same day).
Don't argue about upstream.

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
> that doesn't process in the EU, before a single request is sent, and keeps an audit log of every
> call that left and every one it refused. It runs on infrastructure you control, including fully
> offline.
>
> MIT-licensed, built by an EU-incorporated company, and self-hosted only.
>
> ▶ 4-minute walkthrough: [VIDEO]
> ⭐ https://github.com/AxsionDev/Lunos
>
> If your organisation is evaluating AI coding tools under GDPR, NIS2 or procurement rules, we're
> looking for a few design partners: [CONTACT]
>
> #opensource #AI #softwaredevelopment #dataprotection #EU

## 3. LinkedIn, Petar's own post

> [PETAR: your own opening, a real moment when an AI coding tool was blocked or questioned
> > because of where the code would go. Don't post an anecdote that didn't happen. If there isn't one,
> > open with the question instead:]
>
> "Where does our code go?" is the question that stops AI coding tools in European organisations.
> Usually the honest answer is "to a US company, and we can't stop it or prove otherwise." I wanted
> one where the answer is a setting.
>
> Lunos is out today. It's an open-source fork of opencode with one opinion added: you decide which
> jurisdictions your code may be sent to, Lunos refuses everything else before a request is made,
> and you get an audit log to show your DPO.
>
> It's early. The binaries aren't signed yet, and there's plenty upstream does that we haven't
> touched. But the part that matters for European teams works, and it's MIT-licensed.
>
> Walkthrough: [VIDEO] · Code: https://github.com/AxsionDev/Lunos
>
> If you've ever had an AI tool blocked by a DPO or a procurement review, I'd really like to hear
> what they asked for.

---

## 4. EU developer channels

The GTM plan's priority order is GitHub, then Reddit as build-in-public updates, then EU Mastodon,
then the Digital SME Alliance. Fosstodon is invite-only, so use **mastodon.social**, which is run by
a German GmbH. The ticket asks for at least two channels; three are drafted.

### 4a. Digital SME Alliance (newsletter or members' channel)

Lead with the regulatory angle, which is what this audience opens for.

> **An open-source coding agent with an EU data-residency switch**
>
> European SMEs adopting AI coding tools face a question most tools can't answer: where does the
> source code go? **Lunos**, from Bulgarian SME ITService, is an MIT-licensed coding agent that can
> refuse model providers outside the EU before any data is sent, and that keeps an audit log of
> every model call and every refusal. It runs on the company's own machines, or fully offline.
>
> Each release ships a software bill of materials, which helps SMEs map their own Cyber Resilience
> Act and NIS2 obligations. It isn't a certification, and none is claimed.
>
> https://github.com/AxsionDev/Lunos · https://docs.lunos.tech

### 4b. r/selfhosted (build-in-public update, not an announcement)

**Title:**

> I forked opencode to add a data-residency policy: the agent refuses model providers outside a
> region you choose, and logs every call

**Body:**

> Self-hosting the agent is easy. Knowing where your code goes once the agent calls a model is the
> hard part. That's what I added:
>
> - `"residency": { "allow": ["eu"] }`. Providers that don't process in the allowed regions are
>   refused before a connection is made. A provider's built-in claim only counts at its own API
>   host, so pointing a client at some other URL doesn't pass the check.
> - Your own endpoints (vLLM, Ollama on another box) get a declared region in
>   `residency.endpoints`. The audit log records them as _declared_, so nobody mistakes your word
>   for a verified fact.
> - `LUNOS_OFFLINE=1` stops every outbound call Lunos makes on its own behalf. The air-gapped guide
>   covers Ollama and vLLM on an isolated network.
> - Sandboxed runs in Docker or Podman.
> - The audit log is hash-chained JSON Lines, with host and region, never content.
>
> Not code-signed yet. MIT, and not affiliated with upstream. Feedback on the residency model
> especially welcome: what would you need it to cover that it doesn't?
>
> https://github.com/AxsionDev/Lunos

### 4c. mastodon.social thread

> 1/ I've released Lunos: an open-source AI coding agent for teams that need to control where
> their code goes. Built in Bulgaria, MIT-licensed, self-hosted only. 🧵
>
> 2/ The core idea: `"residency": {"allow": ["eu"]}` and Lunos refuses any model provider outside
> the EU, before a request is sent. US APIs, gateways that route onward, and unverified "regional"
> clouds are all refused.
>
> 3/ Every model call and every refusal goes to a hash-chained audit log, with provider, region and
> host, never the content. That's something you can show a DPO.
>
> 4/ EU providers work out of the box: Mistral, Scaleway, OVHcloud, Hetzner. Or run everything
> locally with Ollama or vLLM, fully offline.
>
> 5/ It's early: no code signing yet, and no parity claims with opencode, which it's forked from.
> Walkthrough: [VIDEO] · https://github.com/AxsionDev/Lunos #opensource #EU #DigitalSovereignty

---

## 5. Walkthrough video script (≤ 5 min)

The ticket asks for install, first task, sandboxed fleet and approval gate. Record in a clean VM
or container, on a terminal of 120×36 or more. Use an EU provider key, Mistral for example.

| Time | Scene            | On screen                                                                                                    | Say                                                                                           |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 0:00 | Problem          | Title card                                                                                                   | "Your AI coding agent sends your code somewhere. Lunos lets you decide where, and proves it." |
| 0:15 | Install          | `npm i -g lunos-ai@latest --allow-scripts=lunos-ai`, then `lunos --version`                                  | "One command. MIT-licensed, nothing to sign up for."                                          |
| 0:40 | Residency policy | `opencode.json` with `"residency": {"allow": ["eu"]}`, then `lunos models`                                   | "Allow only the EU."                                                                          |
| 1:10 | Refusal          | `lunos run -m anthropic/… "hi"` refused with the reason, then `tail` of the audit log showing `model.denied` | "A US provider is refused before any request, and the refusal is in the audit log."           |
| 1:40 | First task       | `lunos` TUI on a small repo with Mistral: "add input validation to parse.ts and a test"                      | "An EU provider works normally."                                                              |
| 2:40 | Sandboxed fleet  | `lunos run --sandbox` with two background subagents in `/tasks` (XCOD-162 demo); cancel one                  | "Long jobs run in a container, several at once, and you watch them in `/tasks`."              |
| 3:40 | Approval gate    | dev-cycle mode pausing at an approval gate until signed off (XCOD-163 demo)                                  | "Nothing ships until a person approves it."                                                   |
| 4:30 | Close            | Repo URL, docs.lunos.tech, "MIT · EU-incorporated vendor · self-hosted"                                      | "It's early, and we'd like to hear what your DPO asks."                                       |

Reuse the XCOD-162 and XCOD-163 recordings for the sandboxed-fleet and approval-gate scenes. The
XCOD-152 guardrails demo can stand in for the refusal scene if it runs short.

---

## 6. Launch-week watch (AC3)

- [ ] For 7 days from `[DAY]`, triage GitHub Issues within 24 hours: label each one, reply, and
      file every bug in XCOD with the issue link.
- [ ] Each day, answer HN, Reddit and Mastodon replies within working hours. File every bug report
      from them in XCOD too.
- [ ] Day 0: before posting, run the install command on a clean machine, then check
      docs.lunos.tech links and that no certificate prompt appears (XCOD-216).
- [ ] Day 1 and Day 7: record the numbers below.

## 7. Launch report template (AC4, after day 7)

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
