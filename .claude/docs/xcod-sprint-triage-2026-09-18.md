# XCOD sprint triage — 2026-09-18

Sprint goal (as given): complete all tasks; move everything ready for human review to **in Review**.

Board: https://axsion.atlassian.net/jira/software/projects/XCOD/boards/169

13 issues. Triaged by _cost to reach in Review_, not by key.

## A. In Review (4)

| Key     | Summary                                                    | How it got there                                     |
| ------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| XCOD-50 | Release assets named `opencode-*` vs installer's `lunos-*` | already there at session start                       |
| XCOD-56 | Home-screen tips name a nonexistent command                | `e3f90f0d0c` → `dev` `394ec88552`, pushed            |
| XCOD-51 | ITService EOOD copyright line in LICENSE                   | `b08e47a372` → `dev` `91dc770085`, pushed            |
| XCOD-47 | setup-git-committer needs upstream's GitHub App            | status was stale — fix `04d2340ef4` already on `dev` |

## B. XCOD-44 — complete, in Review

All three items done: TUI ✅ desktop ✅ docs site ✅.

**TUI** (`b5861ac517`, `12c61309b4`) — AC-1 holds: `grep -rn "OpenCode" packages/tui/src`
returns only Zen/Go. Terminal title verified via the OSC sequence in a pty capture.
`packages/cli/src` swept clean (0 matches, exact-case and lowercase invocation forms).

**Desktop** (`25831fbb92`) — `grep -rn "OpenCode" packages/desktop/src` returns nothing.
62 locale files plus the app name, window titles and `<title>`. Identifiers left alone:
`APP_IDS` (`ai.opencode.desktop*`) keys the **userData path**, electron-builder appId,
Linux `executableName` and `StartupWMClass` — renaming orphans existing installs.
`electron-builder.config.test.ts` asserts those appIds and still passes, which is the
evidence the boundary was drawn right. 21/21 desktop tests pass.

Two grammar fixes a mechanical sweep gets wrong, worth remembering:

- **fr/ca** `d'OpenCode` → `de Lunos` — those languages elide `de`→`d'` only before a
  vowel. "OpenCode" starts with O, "Lunos" with L, so a straight swap yields `d'Lunos`.
- **tk** `OpenCode-iň` → `Lunos-yň` — Turkmen genitive harmonises with the stem; "Lunos"
  is back-vowel and takes `-yň`. (`tr` `Lunos'un` and `az` `Lunos-un` were already correct.)

The XCOD-42 precedent was validated for "no encoding or identifier damage" — which is
**not** the same as grammatical correctness. Check elision and vowel harmony separately.

### Docs site — the locales are already out of scope

`docs-locale-sync.yml` is **deferred** by XCOD-19 because it "directly conflicts with
XCOD-24, which declares the inherited translations stale rather than maintained." English
is the source of truth and locale docs are stale by existing policy — that removes ~5,400
of 5,838 matches without touching anything.

The remaining **413 English `.mdx` matches** were swept (`5ff8b48e44`), sentinel-protecting
`OpenCode Zen`, `OpenCode Go` and upstream repo paths. `enterprise.mdx` was **removed** —
it documented upstream's commercial offering — with its nav entry and inbound link fixed.

**`zen.mdx` was kept, reversing the original plan.** Looking at the file before deleting
showed OpenCode Zen is a _third-party provider Lunos actively supports_: the TUI ships a
`/connect` flow pointing at `opencode.ai/zen` (`dialog-provider.tsx:378`) and provider id
`opencode` is live. Deleting it would have removed docs for a working feature. Only its
client-references were rebranded; attribution to the OpenCode team is intact.

### The lesson: protecting a product name does not protect the sentence around it

The sweep was sentinel-protected for `OpenCode Zen`/`OpenCode Go`, and **still** produced
three misattributions, because the damage was in the surrounding prose:

- `providers.mdx` ×2 — Zen and Go "provided by the **Lunos** team" → restored to OpenCode team
- `zen.mdx` — "provided by Lunos" → restored

Each would have claimed a third-party AI gateway as ours. **Always grep for
`the Lunos team` / `Lunos <ProductName>` after any rebrand sweep.**

Verified with `astro build` (the real check, since a page was deleted and nav edited), not
just greps.

### XCOD-56 notes

Only two string classes were actually wrong. Recorded because a future sweep will be
tempted to "finish the job" and will break things:

- **Changed** — CLI invocations (`opencode run|serve|upgrade|auth|agent|github|debug|--continue`
  → `lunos …`) and standalone product references.
- **Left alone, correct as written** — config paths (`.opencode/`, `opencode.json`,
  `~/.config/opencode/`): the runtime still resolves these, `packages/core/src/global.ts:10`
  sets `const app = "opencode"`.
- **Left alone, externally owned** — GitHub trigger phrases `/opencode` and `/oc`
  (`github/action.yml:30` still defaults to them), and the `OpenCode Zen` provider name.

Verification: rendered the home screen under a pty at 120x45 across 30 launches, 25 distinct
tips observed. Saw `Run lunos serve for headless API access to Lunos` and `Run lunos upgrade …`
live; `Use /connect with OpenCode Zen` unchanged; zero stale `opencode <cmd>` tips.

### XCOD-51 notes

`LICENSE` named only upstream, so the MIT "AS IS" clause at `LICENSE:15-21` — which binds
"THE AUTHORS OR COPYRIGHT HOLDERS" — had no Lunos-side holder of record. Added
`Copyright (c) 2026 ITService EOOD` beneath upstream's unchanged line.

Year 2026 = first XCOD commit, 2026-09-12. Registered string used verbatim, not the
"Axsion" trading name (XCOD-17).

Scope decision (AC-3): **LICENSE alone suffices.** `package.json` has no `author` field and
its `"license": "MIT"` already resolves here (npm metadata is not a legal instrument); no
`NOTICE` exists and MIT requires none, unlike Apache-2.0 §4(d); the 21 READMEs already carry
the XCOD-24 affiliation disclaimer, a different instrument from a copyright assertion.

## C. Still To Do — code on `dev` but genuinely incomplete

| Key     | Commit on `dev`                     | Remaining                                    |
| ------- | ----------------------------------- | -------------------------------------------- |
| XCOD-46 | `9368d1089b` install usage examples | gated on `lunos-ai` actually being published |

## Verification baseline for this session

`bun turbo test` → **715 pass / 9 fail**, matching the documented baseline. All 9 are in
`packages/app/src/components/prompt-input/submit.test.ts` (`local.mode.current` undefined),
a package untouched by this session's changes. No regression introduced.

`bun turbo typecheck --filter=@opencode-ai/tui --force` passes on a forced cache miss.
Note `packages/tui` declares no `test` task, so the pty render is the only runtime check
available for it — which is why XCOD-56 and XCOD-44 were both verified that way.

Do not use `bun test | tail` — it masks the exit code. The real command is `bun turbo test`.

## D. Owner-decision tickets

**Decided 2026-09-19** (research → recommendation → owner ruling → recorded):

| Key     | Decision                                                                      | Artefact                                         |
| ------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| XCOD-52 | **DCO**, not a CLA. Lunos stays MIT-only. Enforcement deferred, trigger named | `xcod-52-contributor-licensing-decision.md`      |
| XCOD-55 | Hosted offering **eventually, not near-term**; claim scoped to self-hosted    | `xcod-55-infrastructure-sovereignty-decision.md` |

Still open:

| Key     | Summary                                            | Blocked on                                                |
| ------- | -------------------------------------------------- | --------------------------------------------------------- |
| XCOD-48 | Provision signing/publishing/telemetry credentials | npm token, Azure Trusted Signing, Tauri keys — human-held |
| XCOD-53 | Trademark clearance — EUIPO and USPTO              | **registers are not machine-searchable** — see below      |
| XCOD-54 | CRA status — manufacturer or open-source steward   | **both its own gates still closed** — see below           |

### XCOD-53 — risk signal recorded, clearance not performable here

Researched 2026-09-19; `xcod-53-trademark-preliminary-risk.md`. **Not moved to in Review** — the ACs
require actual register results.

**The finding:** the senior user of the identical mark, `LUNOS Lüftungstechnik` (Berlin, 1959), is
an active international filer **with Class 9 activity** — US serial **79386509**, a 2023 Madrid
Protocol extension covering "switches, time delays, interval and inverse circuits." Class 9 is where
downloadable software files. So the collision is not confined to Class 11 ventilation goods, and the
risk is higher than XCOD-22 assumed — that doc reasoned about _market_ overlap, not _register_
overlap. Cross-referenced there.

**Why it stops here:** seven sources attempted — USPTO `tmsearch` API, WIPO Global Brand Database,
TMview, EUIPO eSearch, DPMA, Justia, `uspto.report` — all blocked by anti-bot protection, JS-only
interfaces, or 403. These are deliberate protections, not transient failures; **do not repeat the
attempts.** Every remaining step needs a human-operated browser or legal judgement.

### XCOD-54 is gated by its own description

The ticket says _"do not start before either is live"_ for (1) the CRA/SBOM milestone and (2) the
monetisation decision. Verified both are closed: the CRA/SBOM mapping sits in the **Phase 1** row of
`xcod-31-build-in-public-cadence.md:33` and the project is still closing Phase 0; no monetisation
decision doc exists.

Deliberately not started. Drafting an assessment would mean arbitrarily picking the
steward-vs-manufacturer branch and producing a compliance document that reads authoritative while
resting on an assumption — worse than having none.

XCOD-55 narrowed it: "eventually, not near-term" makes **open-source steward the working assumption
today**, with a foreseeable move to manufacturer.

## D2. Process note — what worked

The owner chose "research, then ask with a recommendation" over asking raw. Both tickets resolved in
one round each, and in both cases the deciding factor was a **fact found by looking**, not an
argument:

- XCOD-52 — an authorship audit showed **zero direct external contributions** (all non-owner commits
  arrived via the upstream merge), which made retroactivity moot and adoption cost nil.
- XCOD-55 — `deploy.yml:34` targets AWS **`us-east-1`**, a US region, on an EU-sovereignty project.

Worth repeating for XCOD-48/53: find the load-bearing fact first, then recommend.

## E. Large / dependent

| Key     | Summary                                       | Note                                                  |
| ------- | --------------------------------------------- | ----------------------------------------------------- |
| XCOD-14 | Host centralized registry service             | epic XCOD-7; real infra build, not a sprint-tail item |
| XCOD-49 | Inherited code-signing jobs block npm publish | depends on the XCOD-48 credential decision            |

## Findings raised in passing

- **XCOD-58 filed** (2026-09-19) — `deploy.yml:34` deploys to AWS `us-east-1`, a US region, sitting
  in a public workflow file next to an EU-sovereignty README. Not a live problem (it deploys our own
  console/web, not customer workloads, and XCOD-19 defers it) but region is baked into SST state
  once a stack deploys, so moving later means recreating resources.
- `packages/tui/.../tips-view.tsx:277` advertises `ghcr.io/anomalyco/opencode`, but
  `packages/opencode/script/publish.ts:87` builds `ghcr.io/pminev1/lunos`. Tip is stale.
  Left unchanged because the correct registry path is itself unsettled — see next item.
- `publish.ts:87` still says `pminev1`, but the repo moved to `AxsionDev/Lunos` on 2026-09-18.
- `github/action.yml` is wholly un-rebranded: installs from `opencode.ai/install` and pulls
  releases from `anomalyco/opencode`. Plausibly XCOD-44 scope.

## Realistic sprint outcome

"Complete all tasks" is not reachable by the agent alone, and it is worth saying so plainly rather
than discovering it at sprint end. Of what remains: **XCOD-48** needs credentials only a human
holds; **XCOD-53** needs an external trademark search; **XCOD-54** is gated by its own description;
**XCOD-49** depends on XCOD-48; **XCOD-46** is gated on an actual npm publish; **XCOD-14** is a
multi-day infrastructure build (hosting the registry service), not a sprint-tail item.

Achievable target: every ticket either **in Review** or **blocked with the blocker named and a
recommendation waiting** — no ticket left in an unexamined state.
