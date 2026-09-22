# Skills: parity audit vs Claude Code

Gap audit for XCOD-67, child of XCOD-66 (Phase 2 — Core parity). Grounded against
`origin/dev` at `52600611b4` (2026-09-22).

## Why this is an audit and not a build

`product-vision-roadmap.md` (written 2026-09-12) says "opencode has none today" about
Skills. That was already false ten days later. A working skills subsystem exists:

| File                                       | Responsibility                                                  |
| ------------------------------------------ | --------------------------------------------------------------- |
| `packages/schema/src/skill.ts`             | `Info` + the three `Source` variants (directory, url, embedded) |
| `packages/core/src/skill.ts`               | Service, frontmatter parse, source loading, name dedupe, cache  |
| `packages/core/src/skill/discovery.ts`     | URL-source pull: `index.json`, version pinning, atomic refresh  |
| `packages/core/src/skill/guidance.ts`      | Injects the available-skills list into system context           |
| `packages/core/src/tool/skill.ts`          | The `skill` tool the model calls to load one                    |
| `packages/core/src/config/plugin/skill.ts` | Registers config-derived sources (dirs + `skills` entries)      |
| `packages/core/src/plugin/skill.ts`        | Registers the builtin `customize-opencode` embedded skill       |
| `packages/core/src/v1/config/skills.ts`    | v1 config shape: `paths[]`, `urls[]`                            |

So the roadmap's framing is stale for this pillar, exactly as XCOD-66 predicted. What
follows is a feature-by-feature comparison, then a bucketed gap list.

## What works today

**Model-invoked discovery works.** This is the single most important parity question and
the answer is yes. `skill/guidance.ts` renders every permitted skill's name and
description into an `<available_skills>` block in the system context, with a `baseline`/
`update`/`removed` lifecycle so the model is told when the list changes mid-session. The
model then calls the `skill` tool by name. Skills are _not_ slash-only.

**Progressive disclosure works, and is the right shape.** `tool/skill.ts`'s
`toModelOutput` returns the `SKILL.md` body plus the skill's base directory plus a list
of sibling files — it does not inline those files. The model reads what it needs with the
normal file tools. This matches Claude Code's `SKILL.md` + `references/` pattern.

**Permission gating is real and two-layered.** `SkillV2.available` filters the advertised
list via `PermissionV2.evaluate("skill", name, ...)`, and `tool/skill.ts` independently
re-asserts permission at load time. Filtering the advertisement is not mistaken for
enforcement.

**Remote distribution works, and is carefully written.** `skill/discovery.ts` pulls an
`index.json`, validates every path segment against traversal (`isSafeSegment`,
`isSafeRelativePath`, `FSUtil.contains`), pins origin to the manifest's origin, and does
version-gated refresh via staging dir + atomic rename with rollback. This is more robust
than the rest of the subsystem.

**Nested skill directories work.** The glob is `{*.md,**/SKILL.md}`, so
`skills/foo/SKILL.md` resolves at any depth.

## Feature-by-feature vs Claude Code

| Capability                    | Lunos today                                                     | Verdict    |
| ----------------------------- | --------------------------------------------------------------- | ---------- |
| Model-invoked discovery       | Yes — `guidance.ts` advertises, model calls `skill` tool        | fine-as-is |
| `SKILL.md` + supporting files | Yes — base dir + file list, model reads on demand               | rough      |
| Nested skill directories      | Yes — `**/SKILL.md`                                             | fine-as-is |
| Skill chaining                | Implicit — model may call `skill` again; no dedicated mechanism | fine-as-is |
| Per-skill availability        | Yes — `PermissionV2` by skill name                              | fine-as-is |
| Per-skill tool restrictions   | **No** — no `allowed-tools` concept anywhere                    | missing    |
| Slash invocation              | **No** — `slash` frontmatter parsed, then never read            | missing    |
| Hot reload                    | **No** — content cache never invalidated, survives `reload`     | missing    |
| Marketplace distribution      | **No** — marketplace carries plugins only (see below)           | missing    |
| TUI surface                   | **No** — zero skill references in any `.go` file                | missing    |

## The marketplace question (named acceptance criterion)

**Answer: no. Skills do not ride the existing plugin marketplace, and the two mechanisms
share no code.**

Evidence: grepping `packages/core/src/marketplace.ts`,
`packages/opencode/src/marketplace/`, `packages/opencode/src/cli/cmd/marketplace.ts` and
`packages/opencode/specs/marketplace-manifest.md` for "skill" returns zero matches. The
manifest spec defines a single `plugins` array with exactly two source types, `npm` and
`github` — no component-type dimension a skill could occupy.

Skills instead have a **parallel, skill-specific** remote mechanism: a `url` source
pointing at a directory containing `index.json`, handled entirely inside
`skill/discovery.ts` and registered from config's `skills` array.

**Why this matters for XCOD-69 (MCP discovery).** XCOD-69 is written on the assumption
that it should extend the plugin marketplace rather than build a parallel system. This
audit shows the repo has _already_ grown one parallel distribution system for skills. So
XCOD-69 faces a three-way choice, not a two-way one:

1. Extend the marketplace manifest with a component-type dimension (plugins / skills /
   MCP servers) and migrate skills onto it — most unifying, largest blast radius.
2. Extend the marketplace for MCP only, leaving skills parallel — accepts two systems
   permanently and makes it three.
3. Give MCP its own `index.json`-style registry mirroring `skill/discovery.ts` — cheapest,
   makes the fragmentation worse.

Option 1 is the one that matches XCOD-69's stated intent, but it is materially bigger than
that ticket currently assumes, and it would touch skills. **Flagging rather than deciding:
this is a design call that should be made when XCOD-69 starts, with this audit in hand.**

## Gap list

### Missing

**G1 — `slash` frontmatter is a phantom field.** `Skill.Info` declares `slash`,
`skill.ts:98` parses and stores it, and _no consumer anywhere reads it_. Verified by
grepping all `.ts`/`.tsx`/`.go` under `packages/`: the only other "slash" matches are
unrelated i18n placeholder strings. A user who writes `slash: true` gets no slash command
and no error. Either wire it to the command layer or remove it from the schema; shipping a
field that silently does nothing is worse than not having it.
_Size: S to remove, M to implement._

**G2 — No hot reload; the content cache is permanently stale.** `skill.ts:109` holds
`const cache = new Map<string, Info[]>()`, keyed by source, populated on first `list()` and
**never invalidated**. It is a plain closure variable outside `State`, so `state.reload`
re-materializes the source _list_ without clearing loaded _content_. Editing a `SKILL.md`
has no effect until the process restarts. The code carries an unanswered
`QUESTION(Dax)` at `skill.ts:107-108` asking exactly this. This is the gap that hurts most
when authoring a skill, because the edit/test loop is a full restart.
_Size: S for an explicit invalidation hook, M for filesystem-watch invalidation._

**G3 — No per-skill tool restrictions.** Claude Code skills can declare `allowed-tools`.
Lunos has no equivalent — `allowed-tools`/`allowedTools` appears nowhere in `core/src` or
`schema/src`. Permissions gate _whether a skill loads_, not _what it may then do_.
_Size: M._

**G4 — No TUI surface.** Zero skill references in any `.go` file. Skills cannot be
listed, browsed, or inspected from the TUI, while plugins have a Discover view (XCOD-12).
_Size: M._

### Rough

**G5 — Silent file-list truncation.** `tool/skill.ts` sets `FILE_LIMIT = 10` and slices
the glob result, emitting `Note: file list is sampled.` A skill with more than ten
supporting files has the rest silently invisible to the model, with no count of what was
omitted. Multi-file skills are precisely the case this limit breaks.
_Size: S — report the omitted count, and prefer a manifest or depth-ordered selection._

**G6 — Description-less skills are invisible but loadable.** `guidance.ts:52-56` drops any
skill whose `description` is undefined from the advertised list. Such a skill still exists
and still loads if named, but the model is never told it exists — so it is dead weight in
practice. `description` is optional in the schema, which makes this trivially easy to hit.
_Size: S — warn at load time, or make `description` required._

**G7 — Name collisions resolve silently.** `skill.ts:116` does `skills.set(skill.name, ...)`
across all sources, so a later source silently shadows an earlier one. With directory,
URL, and embedded sources all in play, collisions are plausible and produce no diagnostic.
_Size: S._

**G8 — The builtin skill is still opencode-branded.** `plugin/skill.ts` registers
`customize-opencode`, whose description names `opencode.json`, `.opencode/`, and
`~/.config/opencode/`. Under the rebrand this is user-visible text that still says
opencode. Flagged here as discovered-in-passing; it belongs to the XCOD-44 rebrand family
rather than to parity, and the config paths themselves may legitimately still be
`.opencode` — that needs checking before any rename.
_Size: S, but verify the paths are actually renamed before touching the description._

### Fine as-is

Model-invoked discovery, nested directories, progressive-disclosure shape, permission
gating, and the URL-source security handling all meet or exceed the bar. Skill chaining
needs no dedicated mechanism — the model can call the `skill` tool repeatedly, and Claude
Code does not have a distinct chaining primitive either.

## Recommendation on what to close

XCOD-67's AC says to close only gaps that are load-bearing for XCOD-71 (porting a real
Cowork instruction set) or a clearly stated user need, and to avoid speculative parity.

**Close now, independent of the XCOD-71 decision:**

- **G2 (hot reload)** — load-bearing for _authoring_ any skill, which XCOD-71 requires.
  This is the highest-value fix in the list.
- **G1 (phantom `slash`)** — a correctness problem regardless of XCOD-71. At minimum make
  it honest.
- **G6, G7** — small, diagnostic-only, and both are failure modes an author hits blind.

**Hold pending the XCOD-71 instruction-set choice:**

- **G5** — only matters if the ported skill carries more than ten files.
- **G3** — only matters if the ported workflow needs to constrain tools per skill.
- **G4** — TUI listing is a convenience; nothing in XCOD-71 requires it.

**Defer / reassign:**

- **G8** — rebrand family, not parity.
- The marketplace decision — belongs to XCOD-69, informed by this audit's answer above.
