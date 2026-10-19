# XCOD-26 — Social/community handles: claim pack

**Status:** **AC-1 done** (as amended) · AC-2/3/4 outstanding · **Date:** 2026-09-18
**Epic:** XCOD-21 · **Depends on:** XCOD-22 (name frozen as Lunos) · **Relates to:** XCOD-28

> [!IMPORTANT]
> This document does not itself satisfy any acceptance criterion — XCOD-26's ACs require real
> accounts to exist. Account creation, org creation, and billing-attached actions have no API
> surface and need a human in a browser. The ticket stays open until the remaining accounts are
> live.

> [!TIP]
> **Executed 2026-09-18 (steps 1–2):** `lunoshq` org created; `pminev1` added to `AxsionDev` as
> admin; **`pminev1/Lunos` transferred to `AxsionDev/Lunos`**. All five `APPLE_*` Actions secrets
> **survived** the transfer (verified by before/after `gh secret list` — identical names and
> timestamps). Default branch `dev` preserved, old path redirects, local `origin` re-pointed.
> Steps 3–5 remain.

## Why this isn't a lifecycle ticket

XCOD-26 arrived typed as _Story_, so `/jira-feature` would have routed it through Discovery → User
Journeys → multi-dev Implementation → four review gates. There is no code deliverable — the ACs are
"Fosstodon account created", "LinkedIn company page created". The lifecycle's completion template
also demands "5 phases completed" plus Security/Performance/Architecture/Quality verdicts; asserting
those over a set of signups would be false reporting. `xcod-sprint-closeout-assessment.md` already
flags this ticket as owner-only.

What an agent _can_ contribute is the research below: what is actually available, what is actually
blocked, and the order to claim things in.

## Two findings that changed the ticket as written

_Both were established **before** the transfer. Finding 1 has since been acted on; finding 2 has not._

### 1. AC-1 was never met by XCOD-28 — _finding, pre-transfer_

XCOD-28 renamed the **repo**, not the owner. At the time, `pminev1` was a personal **User** account
and the repo sat directly under it:

```
gh api users/pminev1 --jq .type   → "User"
```

So "GitHub org confirmed under the final name" had never been satisfied, despite XCOD-28 being
marked Done. **Resolved by the transfer** — see the claim sequence below.

The squatting problem remains. `github.com/Lunos` is a dormant **User** account created 2013-02-26,
last active 2019-12-20, 2 public repos, 0 followers. GitHub's only _documented_ route to a held name
is its trademark policy — we found no inactivity-release request process — and per XCOD-22 trademark
clearance has **not** been performed. Treat that door as closed until clearance says otherwise.
_(Not verified against GitHub support this session; the account-state figures above are.)_

Checked 2026-09-18:

| GitHub name                                                                                       | Status                                              |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `lunos`                                                                                           | **taken** — dormant User, 2013, inactive since 2019 |
| `lunosdev`                                                                                        | **taken** — User, active 2026-09                    |
| `lunosai`                                                                                         | **taken**                                           |
| `lunos-dev`, `getlunos`, `lunoscode`, `lunos-code`, `uselunos`, `lunos-ai`, `lunoshq`, `lunos-hq` | free                                                |

### 2. AC-2 is not executable as written — Fosstodon is closed

The ticket and GTM §9.4 both name Fosstodon specifically. **Its registrations are closed**
(invite-only). The AC cannot be met there without an invite.

`lunos` is free on every instance checked. Method: webfinger lookup, validated against controls —
`Gargron@mastodon.social` and `kev@fosstodon.org` both return 200, a nonsense handle returns 404, so
a 404 is a genuine negative rather than a blocked probe.

| Instance                                                       | Registrations      | Active/mo | Note                                          |
| -------------------------------------------------------------- | ------------------ | --------- | --------------------------------------------- |
| `fosstodon.org`                                                | **closed**         | 7,284     | what the ticket names                         |
| `floss.social`, `mas.to`, `chaos.social`, `social.linux.pizza` | **closed**         | 620–7,639 | all invite-only                               |
| `mastodon.social`                                              | open, no approval  | 266,510   | operated by **Mastodon GmbH** (German entity) |
| `eupolicy.social`                                              | open, **approval** | 190       | EU policy discussion space                    |
| `hachyderm.io`                                                 | open, **approval** | 7,648     | tech-focused                                  |
| `indieweb.social`                                              | open, **approval** | 1,004     | open-web focused                              |

There is a positioning point buried in that table. Lunos's pitch is "EU-sovereign by design," and
the instance the GTM plan names (Fosstodon) is UK-operated, while `mastodon.social` is run by a
German GmbH. The named instance is **less** aligned with the positioning than the flagship it was
implicitly chosen over. Worth deciding deliberately rather than inheriting.

## Org decisions taken 2026-09-18

Confirmed by the product owner in session:

- **`AxsionDev` owns the code.** `pminev1/Lunos` → `AxsionDev/Lunos`. _Executed 2026-09-18._
- **`lunoshq` is registered under the product name**, to anchor the brand and block squatting.
  _Created 2026-09-18._

That split is coherent — the company org carries the code, the product org carries the brand — and it
means two orgs to administer.

> [!NOTE]
> **This splits AC-1 rather than satisfying it as written.** The AC says "GitHub org confirmed under
> the final name," which reads as _the project lives in an org named for the product_. Under this
> decision the product-named org (`lunoshq`) exists but holds no code, and the code lives in
> `AxsionDev`. That is a normal pattern (`vercel/next.js`), but it works there because the company
> brand is publicly known and carries the product — `AxsionDev` has two forked repos and no public
> members, so it is not yet doing that work.
>
> **This is an AC amendment and needs the owner to acknowledge it as one.** It is not a technicality:
> the anti-squatting purpose of the ticket _is_ met by `lunoshq`; the "org confirmed under the final
> name" wording is what no longer describes reality.

## Claim sequence

**Steps 1–2 were executed 2026-09-18. Steps 3–5 remain, and all three need a human in a browser.**

### 1. Create the `lunoshq` org — AC-1 (as amended) ✅ DONE

`github.com/lunoshq` created 2026-09-18T15:13:54Z, Free tier. `pminev1` is a **member** (not an
owner) there; promote if it needs to administer the org later.

### 2. Add `pminev1` to `AxsionDev`, then transfer ✅ DONE

`pminev1` is now **admin** on `AxsionDev`, and the repo moved:

```
gh api -X POST repos/pminev1/Lunos/transfer -f new_owner=AxsionDev
→ AxsionDev/Lunos   (fork of anomalyco/opencode, public, admin:true)
```

The membership step was unavoidable on any path: a transfer is initiated by the **repo admin**, and
only `pminev1` held admin on the repo — an org owner cannot pull a repo across from the org side.
The same command run before membership existed failed cleanly with
`422 "You don't have the permission to create public repositories on AxsionDev"`, leaving no partial
state.

**Post-transfer verification — all green:**

| Check             | Result                                                                     |
| ----------------- | -------------------------------------------------------------------------- |
| Actions secrets   | **survived** — all five `APPLE_*` present, identical names and timestamps  |
| Actions variables | none before, none after                                                    |
| Default branch    | `dev`, preserved                                                           |
| Old path          | `pminev1/Lunos` → redirects to `AxsionDev/Lunos`                           |
| Local `origin`    | re-pointed to `https://github.com/AxsionDev/Lunos.git`; `git ls-remote` OK |

The secret **values** remain unreadable via API, so this before/after name comparison is the
strongest available evidence — it confirms the entries exist, not that they decrypt correctly. A
real signed build (XCOD-49) is what would prove that.

### 3. Mastodon — AC-2 · _decision needed at execution_

Fosstodon is closed, so pick one:

- **`mastodon.social`** — open now, no approval wait, 266k active, operated by Mastodon GmbH (a
  German entity). Best reach, and the operator jurisdiction fits the positioning better than
  Fosstodon's. **Recommended** unless the niche signal matters more.
- **`eupolicy.social`** — on-message for the EU-sovereignty story, but 190 active users and an
  approval queue.

Claim `@lunos` — confirmed free on both.

### 4. LinkedIn company page — AC-3 · _decision needed at execution_

https://www.linkedin.com/company/setup/new/

A LinkedIn company page is bound to a legal entity. Per XCOD-17 the legal person is **ITService
EOOD** (UIC 201069485, Sofia), and "Axsion" is a **trade name**, not the registered entity. This is
the exact distinction that already forced one correction on XCOD-17 — decide deliberately which name
fronts the page and which appears in the legal/company-details fields.

### 5. X/Twitter — AC-4, optional

Defensive claim only. The ticket marks it lower priority and the GTM plan ranks Mastodon above X for
this audience.

> LinkedIn and X cannot be probed programmatically — both are bot-blocked. Availability for those
> two is confirmed at signup, not in advance.

## Claiming is not launching

§10 of the GTM plan holds Show HN, press, and paid channels until **both** Phase 0 exits
(XCOD-15 / XCOD-20) **and** one real Phase 1 differentiator is live.

Claiming handles is anti-squatting and is **not** gated. **Posting from them is.** Accounts going
live must not be read as the launch moment — per XCOD-31, the launch moment is the Phase 0 exit
post, already drafted and staged at `xcod-31-phase-0-launch-post-draft.md`.

## Adjacent exposure, not in these ACs

**The npm name `lunos` is unclaimed** (`registry.npmjs.org/lunos` → 404) while `packages/cli` already
ships a `lunos` bin. That is the same squatting risk this ticket exists to prevent, on a registry
where the project has a concrete dependency. Candidate follow-up ticket.

## Known cost, deferred by owner decision

The transfer **has moved** the repo to `AxsionDev/Lunos`, leaving 61 hardcoded `pminev1` references. GitHub
redirects cover git remotes and web, but not these. Owner decision 2026-09-18: **fix in a future
story, out of scope here.** They are now live staleness, not a forecast.

- **Must change (28):** `install` (8), `packages/opencode/script/publish.ts` (9),
  `.github/workflows/publish.yml` (6), `package.json` (2), `README.md` (2), `marketplace.json` (1)
- **Will turn CI red (33):** `test/cli/marketplace.test.ts` (23), `test/marketplace/shared.test.ts`
  (8), `test/cli/plugin.test.ts` (2)
- **Leave alone:** the four `.claude/docs/xcod-*.md` and `CHANGELOG.md` — dated records. Per the
  XCOD-4 convention these describe what was true at the time; rewriting them falsifies the record.

Unrelated but overlapping: `install` is **already** broken on asset naming (wants `lunos-*`, CI
uploads `opencode-*` — XCOD-50). Do not read a post-transfer install failure as caused by the
transfer.

## Acceptance criteria

- [x] **AC-1** GitHub org confirmed under the final name — _**met as amended, 2026-09-18.** `lunos`
      is squatted, so the product-name org is **`lunoshq`**; the code lives in **`AxsionDev/Lunos`**.
      The amendment is that the product-named org holds the brand, not the code — see the note under
      "Org decisions" above._
- [ ] **AC-2** Fosstodon account created — _blocked: Fosstodon registrations are closed. Needs an
      instance decision (`mastodon.social` recommended), which amends the AC._
- [ ] **AC-3** LinkedIn company page created — _needs the ITService EOOD vs Axsion decision._
- [ ] **AC-4** (Optional) X/Twitter handle claimed.

**1 of 4 met.** AC-1 is done as amended; AC-2/3/4 need accounts that only the owner can create, so
the ticket stays **To Do** and does not move to Done or In Review on the strength of this document.

## Open items carried forward

- `pminev1/lunos-web` (private) — **still under `pminev1`.** Move to `AxsionDev` too, or leave?
  Unanswered as of 2026-09-18, and now the only piece left on the old account.
- The **61 hardcoded `pminev1` references** are now genuinely stale, not hypothetical. GitHub's
  redirect keeps git and web working, but the test suite is unaffected by redirects — expect red
  builds until a follow-up story lands. See "Known cost" below.
- `lunoshq` holds no repos and `pminev1` is only a **member** there, not an owner. Fine while it is
  purely a name claim; promote before it needs to administer anything.
- Trademark clearance for "Lunos" remains unperformed (XCOD-22 residual risk). It is the only route
  to the squatted `github.com/Lunos` name, and it gates any defensible claim to the brand.

## Revisit trigger

If trademark clearance is performed and clears, revisit whether to pursue `github.com/Lunos` and
`@lunos` on the closed instances via GitHub's trademark policy and instance-admin contact. Until
then, the `lunoshq` claim stands as the product-name anchor.
