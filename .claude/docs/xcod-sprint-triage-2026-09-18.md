# XCOD sprint triage — 2026-09-18

Sprint goal (as given): complete all tasks; move everything ready for human review to **in Review**.

Board: https://axsion.atlassian.net/jira/software/projects/XCOD/boards/169

13 issues. Triaged by _cost to reach in Review_, not by key.

## A. Already in Review

| Key     | Summary                                                    |
| ------- | ---------------------------------------------------------- |
| XCOD-50 | Release assets named `opencode-*` vs installer's `lunos-*` |

## B. Code landed this session (branches cut from `dev`, not yet pushed)

| Key     | Branch                             | State                                                 |
| ------- | ---------------------------------- | ----------------------------------------------------- |
| XCOD-56 | `xcod-56-home-screen-tips-lunos`   | `e3f90f0d0c` — tsgo clean, verified under a pty       |
| XCOD-51 | `xcod-51-license-entity-copyright` | `b08e47a372` — additive, upstream line byte-identical |

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

## C. Status is stale — code already merged to `dev`

| Key     | Commit on `dev`                                    | Remaining                                         |
| ------- | -------------------------------------------------- | ------------------------------------------------- |
| XCOD-47 | `04d2340ef4` git-committer `GITHUB_TOKEN` fallback | 2 ACs need a real `publish.yml` dispatch          |
| XCOD-44 | `8a8e19145e` publish CLI as `lunos-ai`             | ticket is broader than the commit — needs scoping |
| XCOD-46 | `9368d1089b` install usage examples                | gated on `lunos-ai` actually being published      |

## D. No code deliverable — owner decision or external dependency

| Key     | Summary                                              | Blocked on                                                |
| ------- | ---------------------------------------------------- | --------------------------------------------------------- |
| XCOD-48 | Provision signing/publishing/telemetry credentials   | npm token, Azure Trusted Signing, Tauri keys — human-held |
| XCOD-52 | Contributor licensing posture — DCO, CLA, or neither | owner decision                                            |
| XCOD-53 | Trademark clearance — EUIPO and USPTO                | external search/counsel                                   |
| XCOD-54 | CRA status — manufacturer or open-source steward     | research + owner decision                                 |
| XCOD-55 | Infrastructure sovereignty for hosted Lunos          | owner decision                                            |

Per established process these get the decision asked in chat first, then recorded — they do
not get code.

## E. Large / dependent

| Key     | Summary                                       | Note                                                  |
| ------- | --------------------------------------------- | ----------------------------------------------------- |
| XCOD-14 | Host centralized registry service             | epic XCOD-7; real infra build, not a sprint-tail item |
| XCOD-49 | Inherited code-signing jobs block npm publish | depends on the XCOD-48 credential decision            |

## Findings raised in passing

- `packages/tui/.../tips-view.tsx:277` advertises `ghcr.io/anomalyco/opencode`, but
  `packages/opencode/script/publish.ts:87` builds `ghcr.io/pminev1/lunos`. Tip is stale.
  Left unchanged because the correct registry path is itself unsettled — see next item.
- `publish.ts:87` still says `pminev1`, but the repo moved to `AxsionDev/Lunos` on 2026-09-18.
- `github/action.yml` is wholly un-rebranded: installs from `opencode.ai/install` and pulls
  releases from `anomalyco/opencode`. Plausibly XCOD-44 scope.
