# Skills: parity audit vs Claude Code

Gap audit for XCOD-67, child of XCOD-66 (Phase 2 — Core parity). Grounded against
`origin/dev` at `52600611b4` (2026-09-22).

## Why this is an audit and not a build

`product-vision-roadmap.md` (written 2026-09-12) says "opencode has none today" about
Skills. That was already false ten days later. But the situation is more particular than
"skills exist": **there are two parallel skill implementations**, and which one you ask
about changes the parity answer. Establishing that is the main result of this audit.

### v1 — `packages/opencode/src/skill/`

Wired to the **product surfaces**.

| Surface         | Evidence                                                                        |
| --------------- | ------------------------------------------------------------------------------- |
| HTTP API        | `GET /skill` → `server/routes/instance/httpapi/groups/instance.ts:159-166`      |
| Slash commands  | `command/index.ts:134-152` promotes every skill to a command, `source: "skill"` |
| TUI             | `cli/cmd/run/footer.{prompt,view,command}.tsx` filter on `source === "skill"`   |
| ACP             | `acp/service.ts:783`                                                            |
| Command palette | `app/src/components/prompt-input/slash-popover.tsx` renders a "skill" badge     |

Its `Info` is `name`, `description?`, `location`, `content` — **no `slash` field**.

### v2 — `packages/core/src/skill.ts` (`SkillV2`)

Wired to the **v2 agent loop**, and to nothing else.

| File                                       | Responsibility                                                 |
| ------------------------------------------ | -------------------------------------------------------------- |
| `packages/schema/src/skill.ts`             | `Info` + three `Source` variants (directory, url, embedded)    |
| `packages/core/src/skill.ts`               | Service, frontmatter parse, source loading, name dedupe, cache |
| `packages/core/src/skill/discovery.ts`     | URL-source pull: `index.json`, version pinning, atomic refresh |
| `packages/core/src/skill/guidance.ts`      | Injects the available-skills list into system context          |
| `packages/core/src/tool/skill.ts`          | The `skill` tool the model calls to load one                   |
| `packages/core/src/config/plugin/skill.ts` | Registers config-derived sources (dirs + `skills` entries)     |
| `packages/core/src/plugin/skill.ts`        | Registers the builtin `customize-opencode` embedded skill      |

Its `Info` adds `slash?: boolean`. It has **no** command, TUI, HTTP, or ACP integration.

**This split is the finding that matters most.** v2 is the better-built subsystem
(richer sources, permission gating, safe remote pull) but is invisible to every user-facing
surface. v1 is the one users actually see. Any XCOD-71 port has to know which it targets.

## What works today (v2 agent loop)

**Model-invoked discovery works.** The most important parity question, and the answer is
yes. `skill/guidance.ts` renders every permitted skill's name and description into an
`<available_skills>` block in system context, with a `baseline`/`update`/`removed`
lifecycle so the model is told when the list changes mid-session. The model then calls the
`skill` tool by name. Skills are not slash-only.

**Progressive disclosure works, and is the right shape.** `tool/skill.ts`'s
`toModelOutput` returns the `SKILL.md` body, the skill's base directory, and a list of
sibling files — it does not inline them. The model reads what it needs with normal file
tools. This matches Claude Code's `SKILL.md` + `references/` pattern.

**Permission gating is real and two-layered.** `SkillV2.available` filters the advertised
list via `PermissionV2.evaluate("skill", name, ...)`, and `tool/skill.ts` independently
re-asserts permission at load time. Filtering the advertisement is not mistaken for
enforcement.

**Remote distribution works, and is carefully written.** `skill/discovery.ts` pulls an
`index.json`, validates every path segment against traversal (`isSafeSegment`,
`isSafeRelativePath`, `FSUtil.contains`), pins downloads to the manifest's origin, and
does version-gated refresh via staging dir + atomic rename with rollback.

**Nested skill directories work.** The glob is `{*.md,**/SKILL.md}`, so
`skills/foo/SKILL.md` resolves at any depth.

## Feature-by-feature vs Claude Code

Split by implementation, because the answers differ.

| Capability                    | v1 (product surfaces)                 | v2 (agent loop)                  | Verdict    |
| ----------------------------- | ------------------------------------- | -------------------------------- | ---------- |
| Model-invoked discovery       | n/a                                   | Yes — `guidance.ts` advertises   | fine-as-is |
| `SKILL.md` + supporting files | Base dir appended to template         | Base dir + sampled file list     | rough      |
| Nested skill directories      | Yes                                   | Yes — `**/SKILL.md`              | fine-as-is |
| Skill chaining                | n/a                                   | Implicit; no dedicated mechanism | fine-as-is |
| Per-skill availability        | **No gating**                         | Yes — `PermissionV2` by name     | rough      |
| Per-skill tool restrictions   | No                                    | No — no `allowed-tools` anywhere | missing    |
| Slash invocation              | Yes, but **unconditional**            | **No** — `slash` field unread    | rough      |
| Hot reload                    | Instance-scoped cache                 | **No** — cache never invalidated | missing    |
| Marketplace distribution      | **No** — marketplace is plugins-only  | Own parallel `index.json` pull   | missing    |
| TUI surface                   | Yes — footer + palette, "skill" badge | **No**                           | rough      |

## The marketplace question (named acceptance criterion)

**Answer: no. Skills do not ride the existing plugin marketplace, and the two mechanisms
share no code.**

Evidence, with a positive control so the zero is meaningful: `packages/core/src/marketplace.ts`
(54 lines), `packages/opencode/src/cli/cmd/marketplace.ts` (360 lines) and
`packages/opencode/src/marketplace/shared.ts` (276 lines) match "plugin" 1 and 8 times
respectively, and match "skill" **0 times** across all three. The manifest spec
(`marketplace-manifest.md`) defines a single `plugins` array with exactly two source
types, `npm` and `github` — there is no component-type dimension a skill could occupy.

Skills instead have a **parallel, skill-specific** remote mechanism: a `url` source
pointing at a directory containing `index.json`, handled entirely inside
`skill/discovery.ts` and registered from config's `skills` array.

**Why this matters for XCOD-69 (MCP discovery).** XCOD-69 assumes it should extend the
plugin marketplace rather than build a parallel system. This audit shows the repo has
_already_ grown one parallel distribution system for skills. So XCOD-69 faces a three-way
choice, not a two-way one:

1. Extend the marketplace manifest with a component-type dimension (plugins / skills /
   MCP servers) and migrate skills onto it — most unifying, largest blast radius.
2. Extend the marketplace for MCP only, leaving skills parallel — accepts two systems
   permanently and makes it three.
3. Give MCP its own `index.json`-style registry mirroring `skill/discovery.ts` — cheapest,
   worsens fragmentation.

Option 1 matches XCOD-69's stated intent but is materially bigger than that ticket assumes,
and it would touch skills — during an unfinished v1→v2 migration. **Flagging, not deciding:
this belongs to XCOD-69's design step, with this audit in hand.**

## Gap list

### Missing

**G1 — v2 skills have no command/slash integration, and its `slash` field is inert.**
`SkillV2.Info` declares `slash?: boolean`, `skill.ts:98` parses and stores it, and no
consumer reads it. Meanwhile v1 has no `slash` field at all and promotes **every** skill to
a slash command unconditionally (`command/index.ts:134-152`) with no opt-out. So the two
halves fail in opposite directions: v2 offers a control that does nothing, v1 offers no
control at all. The `slash` boolean is best read as the intended design for v1's missing
opt-out, written in v2 but never wired up.
_Size: S to document the intent, M to wire v2 into the command layer._

**G2 — No hot reload; the v2 content cache is permanently stale.** `skill.ts:109` holds
`const cache = new Map<string, Info[]>()`, keyed by source, populated on first `list()` and
**never invalidated**. It is a plain closure variable outside `State`, so `state.reload`
re-materializes the source _list_ without clearing loaded _content_. Editing a `SKILL.md`
has no effect until process restart. The code carries an unanswered `QUESTION(Dax)` at
`skill.ts:107-108` asking exactly this, and no test in the repo asserts invalidation.
This is the gap that hurts most when authoring a skill, because the edit/test loop is a
full restart.
_Size: S for an explicit invalidation hook, M for filesystem-watch invalidation._

**G3 — No per-skill tool restrictions.** Claude Code skills can declare `allowed-tools`.
Neither implementation has an equivalent — `allowed-tools`/`allowedTools` appears nowhere
in `core/src` or `schema/src`. Permissions gate _whether a skill loads_, not _what it may
then do_.
_Size: M._

### Rough

**G4 — v2 skills are invisible to every user-facing surface.** v1 skills appear in the TUI
footer, the command palette (with a dedicated "skill" badge), the HTTP API and ACP. v2
skills appear in none of them. A skill registered only through a v2 source is reachable by
the model but cannot be seen or invoked by the user.

_Two corrections, 2026-09-22._

_First: an earlier draft claimed skills have no TUI surface at all, from a grep over
`*.go`. There are zero `.go` files in the repo — the TUI is TypeScript under
`packages/opencode/src/cli/cmd/run/` and `packages/app/`. Vacuously true, substantively
wrong._

_Second, and more important: **this gap is about v2 in isolation, not about the product.**
An earlier version of this section was read as meaning users cannot invoke skills as
commands and that enabling it would be "a substantial build." That is wrong. v1 is the live
runtime for the CLI and TUI, and it already does both things: `command/index.ts:134-152`
promotes every skill to a slash command, and `session/system.ts:107-117` injects the skill
list into the model's system prompt. Skills are user-invocable and model-visible today. The
v2 gap only matters at the v1→v2 cutover, when these two behaviours must not be silently
dropped — which is an argument for a regression test, not a build._
_Size: M, and not currently user-facing._

**G5 — the command surface bypasses the permission gating the model surface respects.**

_Corrected 2026-09-22. The original G5 claimed "v1 has no per-skill availability gating."
That is false: `skill/index.ts:310-315` exposes `Skill.available(agent)`, which filters via
`Permission.evaluate("skill", …)`. v1 gates. The claim came from reading v2 in isolation and
inferring a property of v1._

The real defect is narrower and more serious. Two consumers read the skill list differently:

- `session/system.ts:110` builds the model's system prompt from `skill.available(agent)` —
  **permission-gated**.
- `command/index.ts:134` builds the slash-command table from `skill.all()` —
  **ungated**.

So a skill denied to an agent by permission is correctly withheld from the model, and still
appears as a typeable slash command. The two surfaces disagree about what the user may
invoke. This is security-relevant.

_Sizing corrected 2026-09-22: this is **not** a one-line swap to `available(agent)`._ The
command table is built once per instance by `Command.state(ctx)`, and `ctx` carries no
agent — commands are agent-independent by construction, while permissions are per-agent. So
there are two real options, and picking between them is a design decision:

1. **Enforce at invocation**, not at listing: leave the command table as-is and check
   `Permission.evaluate("skill", name, agent.permission)` when a skill command actually
   runs. Smaller, and consistent with the principle this audit already credits v2 for —
   filtering the advertisement is not enforcement, so enforcement belongs at the boundary.
2. **Build the command table per agent**, so a denied skill never appears. Better UX, but it
   changes the lifetime and shape of `Command.state`.

Recommendation: option 1 for the fix, option 2 only if the listing itself is considered
sensitive. _Size: S for option 1, M for option 2._

**G6 — Silent file-list truncation (v2).** `tool/skill.ts` sets `FILE_LIMIT = 10` and
slices the glob result, emitting `Note: file list is sampled.` A skill with more than ten
supporting files has the rest silently invisible to the model, with no count of what was
omitted. Multi-file skills are precisely the case this limit breaks.
_Size: S — report the omitted count, prefer manifest or depth-ordered selection._

**G7 — Description-less skills are invisible but loadable (v2).** `guidance.ts:52-56` drops
any skill whose `description` is undefined from the advertised list. Such a skill still
loads if named, but the model is never told it exists. `description` is optional in the
schema, making this easy to hit.
_Size: S — warn at load, or make `description` required._

**G8 — Name collisions resolve silently (v2).** `skill.ts:116` does
`skills.set(skill.name, ...)` across all sources, so a later source silently shadows an
earlier one. With directory, URL and embedded sources in play, collisions are plausible and
produce no diagnostic. v1 has the inverse convention — `command/index.ts:135` skips on
collision, first-wins — so the two halves also disagree about precedence.
_Size: S._

**G9 — The builtin skill is still opencode-branded.** Both implementations register
`customize-opencode`, whose description names `opencode.json`, `.opencode/` and
`~/.config/opencode/`. Under the rebrand this is user-visible text that still says
opencode. Discovered in passing; belongs to the XCOD-44 rebrand family, not parity — and
the config paths themselves may legitimately still be `.opencode`, which needs checking
before any rename.
_Size: S, contingent on verifying the paths._

### Found by running it, not by reading it

Added 2026-09-22, after exercising `lunos debug skill` against the live v1 runtime. Neither
of these is visible from source review, and both outrank most of the list above.

**G10 — skill discovery is non-deterministic and usually incomplete.** Nine invocations of
`debug skill` on an unchanged working tree returned **7, 16, 16, 17, 17, 17, 18 and 38**
skills. The set is not stable between runs, so a skill the model can use in one session is
silently absent from the next — no error, no warning, nothing in stderr.

The 38-skill run is almost certainly the correct answer: it is the only one that found this
repo's seven project skills plus two from `.opencode/`. So the common case is not merely
unstable, it is **under-reporting by more than half**.

Where to look: `loadSkills` applies `Effect.forEach(…, { concurrency: "unbounded" })` over a
shared mutable `state.skills`, and `discoverSkills` builds `state.matches` through several
sequential scans. A discovery step whose result lands after `all()` reads would produce
exactly this. Note the scan error path is asymmetric — `scan()` only logs when
`opts.scope` is set and otherwise calls `Effect.die`, so a silently swallowed failure in
the config-directory scans is worth ruling in or out early.

_Size: M. This is the most serious finding in the audit — silent, intermittent, and it
undermines every other skill behaviour, including anything XCOD-71 tries to prove._

**G11 — project-level `.claude/skills/` are usually missing.** _Folded into G10 on
2026-09-22: this is a symptom, not a separate defect._ This repository has seven valid
skills in `.claude/skills/`. Most runs discover **zero** of them; one run discovered all
seven (alongside two from `.opencode/`, for 38 total). Since a single run does find them,
the path, glob and frontmatter are all correct — the cause is whatever makes G10 return
incomplete sets.

Ruled out by direct testing, so the next investigator doesn't repeat it:

- The glob is fine — `new Bun.Glob("skills/**/SKILL.md").scanSync({ cwd: "<repo>/.claude" })`
  returns all seven.
- The frontmatter is fine — every file has a string `name:`, so `isSkillFrontmatter` passes.
- `FSUtil.up` **is** inclusive of `stop` (`fs-util.ts:171-180` tests `current` before
  breaking), so a start equal to the worktree root still scans that root.
- Not cold-cache warm-up — counts stay unstable after many runs.

**This blocks XCOD-71**, whose candidate pool is exactly these seven skills. It is the
practical reason G10 matters rather than a separate item.

### Fine as-is

Model-invoked discovery, nested directories, progressive-disclosure shape, v2 permission
gating, and the URL-source security handling all meet or exceed the bar. Skill chaining
needs no dedicated mechanism — the model can call the `skill` tool repeatedly, and Claude
Code has no distinct chaining primitive either.

## Recommendation on what to close

XCOD-67's AC says to close only gaps load-bearing for XCOD-71 (porting a real, currently-in-use
instruction set) or a clearly stated user need, and to avoid speculative parity.

**Owner decision, 2026-09-22: XCOD-71 targets v2.** This was the prior question, since
several gaps exist on only one side of the split. It is now settled, and the list below is
scoped accordingly — v1-only gaps drop out.

The same decision also dropped the story's original "Cowork instruction set" framing, whose
named candidates had no grounding in project memory or the repo. The verified candidate pool
is now the seven in-use instruction sets at `.claude/skills/` — the agent fleet that builds
Lunos itself, which makes the exit criterion a dogfooding exercise.

**Close now:**

- **G2 (hot reload)** — load-bearing for _authoring_ any skill, which XCOD-71 requires.
  Highest-value fix in the list, and v2-specific.
- **G7, G8** — small, diagnostic-only, both v2-specific, both failure modes an author hits
  blind.

**Hold pending the instruction-set choice:**

- **G6** — only matters if the ported skill carries more than ten supporting files.
- **G3** — only matters if the ported workflow needs per-skill tool constraints.

**Now load-bearing only under one condition:**

- **G1, G4** — v2 skills are model-invoked only. If the ported workflow is triggered by
  describing the task and letting the model select the skill, these stay deferred. If it
  must be invoked by a user _typing_ something, both become blocking, and wiring v2 into the
  command layer is a substantial build rather than a tweak. Settle this before starting the
  port.

**Defer / reassign:**

- **G5** — v1-only; out of scope given the v2 decision, unless v1 remains user-facing
  indefinitely.
- **G9** — rebrand family, not parity.
- The marketplace decision — belongs to XCOD-69, informed by the answer above.

## Verification

Docs-only; no code changed. Test baseline captured on this branch with
`bun turbo test --continue`: **8 of 10 tasks successful, `@opencode-ai/app#test` and
`opencode#test` failing** — the known pre-existing failure set, unchanged by this story.
