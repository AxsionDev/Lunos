# Running a real feature through dev-cycle mode

Write-up for XCOD-86, the Phase 3 exit criterion: _"a full-SDLC multi-agent run completing end
to end on Lunos."_ It records what happened when a real backlog item was taken through
`dev-cycle` against a real model, with a human opening every gate.

## The run

|            |                                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject    | XCOD-96: the v1 plugin loader logs `level=ERROR` for every valid v2 plugin file. It was found and filed during the same sprint, so it's real backlog, not a demo. |
| Model      | `openai/gpt-5.5` (OAuth), through the normal TUI                                                                                                                  |
| Human      | Petar Minev, who opened every gate on 2026-09-25                                                                                                                  |
| Session    | `ses_f28ebcb2fffeP3wkQxM5ti2Xz1`: 92 messages, 10 subagent tasks, 7 gate questions                                                                                |
| Cycle file | `dev-cycle-exit-report.cycle.md`, next to this report. It's a verbatim copy, because this repo's `.opencode/.gitignore` ignores `dev-cycle/`.                     |
| Result     | The fix merged as part of this change. Verification is below.                                                                                                     |

XCOD-86 suggested XCOD-77 as the subject, but XCOD-77 had already been fixed normally, so it
wasn't available.

## Timeline

| Step | What happened                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | **The first attempt ran in Build mode, not Dev-cycle.** See the finding below. It started two background `explore` subagents, "fixed" the bug, and reported that its new unit tests passed. The bug was still there. |
| 1    | The mode was switched to Dev-cycle and the model was told the fix didn't work. **Discover** started two background `explore` subagents and reproduced the failure through the real loader.                           |
| 2    | **Architect** (subagent) placed the guard in `applyPlugin`, before the legacy fallback, and rejected four alternatives. **Gate 1: approved.**                                                                        |
| 3    | **Plan** (subagent) produced four ordered steps. **Gate 2: approved.**                                                                                                                                               |
| 4    | **Build**, done by the primary, then **Verify** by the `qa` subagent, which reported PASS. **Gate 3: not approved; deliberate rewind.**                                                                              |
| 5    | The human edited the frontmatter back to `phase: architect` / `gate: pending` and asked for a design change: log skipped v2 modules at DEBUG instead of skipping them silently.                                      |
| 6    | The model followed the file rather than its own later position. It revised Architect, added a "Rewind Note" marking Plan, Build and Verify as stale, and **re-presented Gate 1: approved.**                          |
| 7    | A re-plan (**Gate 2: approved**), a re-build, and a fresh `qa` pass (**Gate 3: approved**).                                                                                                                          |

Subagents used: 4 × `explore` (all with `background=true`), 2 × `architect`, 2 × `planner`,
2 × `qa`.

## It works, and here is the evidence

Checked by hand, independently of the model's own verification, through the real loader
(`debug agent build --print-logs --log-level DEBUG`):

| Plugin file               | Before                                                      | After                                                                |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| valid v2 `{ id, setup }`  | `level=ERROR "failed to load plugin"`                       | `level=DEBUG "skipping v2 plugin module in v1 loader" spec=… path=…` |
| malformed `{ id }`        | `level=ERROR … must default export an object with server()` | unchanged: still ERROR                                               |
| valid v1 `{ id, server }` | loads                                                       | still loads and runs                                                 |

The regression test goes through the loader (`Plugin.Service` → `applyPlugin`), not only
through the `readV1Plugin` helper. That distinction is the whole story of step 0.

## What worked

**The rewind.** This is the path `dev-cycle-mode.txt` worries about most. After a rewind,
older reminders in the conversation show a _later_ phase than the file does. The model went
by the file: it returned to architect, revised that section in place, flagged everything
downstream as stale, and re-ran planner, build and QA instead of patching the old build.
Keeping the cursor on disk, where a human can edit it, did its job.

**Gates were never skipped.** All six gates the model reached were put to the human with the
`question` tool, and the model stopped each time. After an accidental Esc dismissed the
revised Gate 1, the model asked it again rather than treating the dismissal as an approval.

**The subagent split paid off.** `qa`, working without the builder's context, ran the
targeted tests, the typecheck, and reproductions of both the v2 and v1 cases.

## Where the agent drifted from the gates

**1. It asked Gate 1 while a background discover subagent was still running.** Discover
started two background `explore` subagents. One of them
(`ses_f28e4948dffeXukP9oyrefv2N2`) was stuck on a permission prompt: its path had the wrong
letter case (XCOD-100, below). It had issued its `grep` at …5309 and didn't finish until …5661. The primary asked
Gate 1 at …5527, so the architecture was written and presented to the human with half the
discovery still outstanding. That subagent's result arrived after Gate 1 was approved. The
design wasn't affected this time, but nothing in the mode stops it. Waiting for background
subagents isn't part of the gate protocol, and the permission prompt appeared in the TUI
next to the gate question, which made it look like the gate was asking for it. The
reminder should say that a gate may only be asked once every background task started in
the phase has reported back.

**2. The architecture and the plan named the same thing differently.** The approved
architecture called the discriminant field `type`; the plan and the code use `_tag`. It
doesn't matter here, but a reviewer comparing the gates would notice that the code follows
the plan rather than the approved architecture.

## Defects this run exposed

| Finding                                                                                                                                                                                                                                                                                | Where                                             | Filed                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------- |
| Every tool step saves another full copy of the dev-cycle or research reminder onto the user message. One turn carried 27 copies (~96 KB). Plan mode has a guard against this; the two newer modes don't. The prompt's "ONLY THE LAST ONE is current" warning exists to cope with this. | `session/reminders.ts`                            | **XCOD-99**             |
| The `external_directory` check compares paths case-sensitively. On macOS, `…/AxCode/…` is treated as outside a project at `…/Axcode/…`, and "Allow always" would save a rule for the wrong-case path.                                                                                  | `project/instance-context.ts` → `FSUtil.contains` | **XCOD-100**            |
| The subject bug itself.                                                                                                                                                                                                                                                                | plugin loaders                                    | **XCOD-96**, fixed here |

Two more things went wrong but aren't product defects:

- **Build mode shipped a fix that didn't work, and its tests passed.** Step 0 happened in
  Build mode because the mode wasn't switched before the first message. The resulting "fix"
  changed a helper, unit-tested only that helper, and reported success; the real loader
  still logged ERROR. It's the same lesson as XCOD-68: tests that don't go through the real
  path prove nothing. That's the strongest argument this run makes _for_ dev-cycle: its
  discover phase reproduced the failure through the real loader before touching code, and
  found the fallthrough straight away.
- **The launch command given to the human was wrong.** Running `bun packages/opencode/src/index.ts`
  from the repo root fails with `Cannot find package 'react'`, because the Solid JSX preload is
  configured in `packages/opencode/bunfig.toml`. The supported way is `bun dev` from the root,
  which sets `--cwd packages/opencode`. The mistake was in the instructions, not in Lunos.

## Assessment against the exit criterion

**Met.** A real backlog bug went from report to merged fix through discover → architect →
plan → build → verify. A human opened every gate, background subagents ran during discover,
fresh-context subagents did the architecture, planning and QA, and a deliberate rewind was
handled correctly. The run also surfaced two real defects (XCOD-99, XCOD-100), and those
weren't visible from unit tests either.

Before recommending dev-cycle to users, there are two caveats:

1. **Gates are advisory.** The mode holds build permissions from the first turn (spec §1).
   Here the model kept to the gates, including after a rewind, but that's one model on one
   run. Finding 1 shows that "stop at the gate" doesn't yet cover work still running in the
   background.
2. **Fix XCOD-99 before long runs.** The duplicated reminders grow with the number of tool
   steps, so the longest and most valuable cycles pay the most for them and get compacted
   soonest.
