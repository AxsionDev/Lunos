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

## B. In Progress

| Key     | State                                                                                 |
| ------- | ------------------------------------------------------------------------------------- |
| XCOD-44 | TUI half complete (`b5861ac517`, `12c61309b4`, both on `dev`). Desktop + docs remain. |

XCOD-44's AC-1 now holds: `grep -rn "OpenCode" packages/tui/src` returns only Zen/Go
references. Terminal title verified by reading the OSC sequence from a pty capture.
`packages/cli/src` swept and confirmed clean (0 matches, both exact-case and lowercase
invocation forms).

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
