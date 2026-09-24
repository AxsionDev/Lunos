# Porting a real instruction set onto Lunos

> **Update 2026-09-24 (XCOD-83):** the lock-file workaround described below is gone. `research-mode` now declares `allowed-tools` in its frontmatter; `.opencode/hooks/research-mode-guard.sh` and its `hooks` entry are deleted. Hooks also receive `LUNOS_AGENT` and `LUNOS_SKILL`. The translation gaps 1 and 2 in this report are closed. See `subagent-parity-audit.md`.

Write-up for XCOD-71, the exit criterion of XCOD-66 (Phase 2 — Core parity): prove that
Skills + Hooks support a real internal workflow, not a synthetic demo.

## What was ported

`research-mode`, one of the seven instruction sets in this repo's `.claude/skills/` that
drive the agent workflow used to build Lunos. It was chosen for being genuinely in use,
single-file and self-contained.

| Artifact                                  | Purpose                                      |
| ----------------------------------------- | -------------------------------------------- |
| `.opencode/skills/research-mode/SKILL.md` | The skill, in Lunos's own convention         |
| `.opencode/hooks/research-mode-guard.sh`  | Vetoes edits while the research lock is held |
| `.opencode/opencode.jsonc`                | Binds the guard to `tool.execute.before`     |

## It works, and here is the evidence

Not "typecheck passes" — the workflow was exercised against a real model
(`gpt-5.6-sol-fast`) through the normal `lunos run` path.

**The skill is discovered.** `debug skill` lists `research-mode` from
`.opencode/skills/research-mode/SKILL.md`, so it reaches both the model's system prompt and
the slash-command table.

**The hook fires and actually blocks.** A matched A/B pair, same file, same prompt, same
directory — only the lock differs:

| Lock     | Result                                                                                      | File after |
| -------- | ------------------------------------------------------------------------------------------- | ---------- |
| held     | `apply_patch` vetoed; guard's stderr surfaced to user _and_ model, which reported `BLOCKED` | unchanged  |
| released | patch applied                                                                               | changed    |

The first attempt at the control was invalid and is worth recording: the edit targeted a
file outside the worktree and was refused by the _external-directory permission_ check, not
by the guard. A blocked result with two possible causes is not evidence. Re-running inside
the worktree isolated the variable.

## Translation gaps

The interesting part, and the reason the exit criterion asked for a real workflow.

**1. Skills cannot restrict their own tools.** The original's central rule is "MUST NOT
modify any files." In Claude Code a skill can declare `allowed-tools`; Lunos has no
equivalent (audit finding G3), so prose is all a skill gets, and prose does not stop an
agent that drifts into fix-mode.

This is precisely the gap Hooks fill, and it is the strongest argument in this port for
Hooks existing at all. The translation is a lock file plus a blocking `tool.execute.before`
hook: the skill takes the lock, the hook enforces it. The enforcement lives beside the
skill rather than inside it — more moving parts than `allowed-tools`, but it works, and it
fails loudly.

**2. A hook has no idea which skill is active.** Hook commands receive `LUNOS_HOOK_EVENT`,
`LUNOS_TOOL`, `LUNOS_FILE` and `LUNOS_SESSION_ID` — nothing about the loaded skill. Hence
the sentinel file. If hooks ever carry skill context, this guard collapses to a one-liner
and the lock disappears.

**3. Matchers are single-valued.** `matcher.tool` is one glob. Guarding several tools means
several entries, or one entry matching broadly and a script that branches on `$LUNOS_TOOL`.
Neither is wrong; it is just more verbose than expected.

**4. Tool names differ, so instructions do not port verbatim.** The original says
"Glob/Grep"; Lunos exposes `glob`, `grep`, and edits go through `apply_patch` rather than
separate Edit/Write tools. Any instruction set naming specific tools needs a pass.

**5. `.claude/skills/` already works — the port is about ownership, not enablement.** Lunos
discovers `.claude/skills/**/SKILL.md` natively, so all seven were already live before this
story. Moving one to `.opencode/skills/` buys platform-native ownership and a place for the
hook to sit, not new capability. Worth saying plainly, because "port your Claude Code
skills" sounds like migration work and mostly is not.

## Two defects this port exposed

Both were in XCOD-68, both shipped to `dev`, and **neither was caught by that story's 18
unit tests** — which tested the hooks plugin in isolation and never checked that config
reaches it. Both surfaced within minutes of trying to use the feature.

**`hooks` never reached the runtime.** The key was added to the v2 `Config.Info`, but the
live path decodes through `ConfigV1.Info`, which strips unknown keys. `debug config` showed
no `hooks` at all, so the plugin received nothing and no hook could ever have fired. Fixed
by declaring `hooks` in the v1 schema too.

**Any partial hooks config was rejected.** The schema was `Schema.Record(Event, …)`, and a
record keyed by a literal union is _exhaustive_ in Effect Schema — declaring one event
failed with `Missing key hooks.session.deleted` and so on for every other event. In other
words the feature could not be used at all. Fixed by declaring the events as optional
struct fields, which keeps the closed key set.

**A third, smaller correction:** XCOD-68's commit message and PR claimed the closed key set
meant "a typo fails at config-decode time instead of silently never firing." False —
decoding uses `onExcessProperty: "ignore"` repo-wide, so a misspelled event is dropped
silently. Now pinned by a test named as a known limitation, and documented in
`docs/hooks.mdx`.

The regression tests added here decode real config shapes rather than asserting on schema
structure, because structure was never the problem.

## Assessment against the exit criterion

Skills and Hooks do support a real internal workflow, demonstrated end to end rather than
asserted. The friction is real but bounded, and the one structural gap — skills cannot
constrain their own tools — has a working, if indirect, answer in Hooks.

The more useful finding is process rather than product: a feature can pass 18 unit tests,
typecheck, a full suite and code review, and still be **completely non-functional**,
because none of that exercised the path a user takes. This port was the first time anyone
ran `hooks` for real, and it failed on the first attempt for two independent reasons.
