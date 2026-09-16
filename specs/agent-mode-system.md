# Agent/Mode System Audit

Research for epic XCOD-38. Produced for XCOD-39 ("Research: how Lunos's
agent/mode system was built, and gaps vs Claude Code"). This document is
research/spec only — no `.ts`/`.tsx`/`.txt` source file was modified to
produce it (verified with `git diff --stat`).

Note on ticket numbering: XCOD-39's own body text says "XCOD-39, XCOD-40" in
its "As"/AC lines and "XCOD-39 (rename)" in its sequencing ask — these are
off by one against the ticket *summaries*, which are consistent: XCOD-39 is
this research story, XCOD-40 is the rename, XCOD-41 is the new Research Mode.
This document follows the summaries. Section 6 below is written for XCOD-40
(rename) and XCOD-41 (Research Mode), and the "link back" AC is satisfied by
commenting on both of those tickets, not on XCOD-39 itself.

## 1. Inventory

All native agents are defined in one map literal in
`packages/opencode/src/agent/agent.ts:140-265`, built from a `defaults`
permission ruleset (`agent.ts:119-136`) merged with per-agent overrides and
finally the user's own config (`user`, from `cfg.permission`).

| Name | `mode` | hidden | Permission summary | System prompt |
|---|---|---|---|---|
| `build` | `primary` | no | `defaults` + `question: allow`, `plan_enter: allow` (agent.ts:141-155) | none (uses default) |
| `plan` | `primary` | no | `defaults` + `question: allow`, `plan_exit: allow`, **`task: { general: "deny" }`**, `external_directory` allow for the plans data dir, `edit` denied except `.opencode/plans/*.md` and the plans data dir (agent.ts:156-181) | none |
| `general` | `subagent` | no | `defaults` + `todowrite: deny` (agent.ts:182-195) | none |
| `explore` | `subagent` | no | `defaults` + deny-all except `grep`/`glob`/`list`/`bash`/`webfetch`/`websearch`/`read`, plus a read-only `external_directory` allow-list (agent.ts:196-218) | `PROMPT_EXPLORE` (`agent/prompt/explore.txt`) |
| `compaction` | `primary` | **yes** | `defaults` + deny-all (agent.ts:219-233) | `PROMPT_COMPACTION` |
| `title` | `primary` | **yes** | `defaults` + deny-all, `temperature: 0.5` (agent.ts:234-249) | `PROMPT_TITLE` |
| `summary` | `primary` | **yes** | `defaults` + deny-all (agent.ts:250-264) | `PROMPT_SUMMARY` |

User-defined agents from `cfg.agent` config are merged into the same map at
runtime (agent.ts:267-294): if a key doesn't already exist as a native agent,
it defaults to `mode: "all"`, full default+user permission, `native: false`.
This means a user can already register a new Tab-switchable "primary" or a
new "subagent" purely through config — the roster is not literally fixed to
the four visible built-ins.

The `mode` field on `Agent.Info` (`agent.ts:38`, literal
`"subagent" | "primary" | "all"`) is mirrored by a second, independent schema
declaration on the config-file shape: `ConfigAgent.Info.mode`
(`packages/core/src/config/agent.ts:13-25`, same literal, `Schema.optional`).
Both are the worker-classification field named in Background — internal, and
explicitly out of scope for this rename per the epic and both child tickets.

`packages/opencode/src/agent/subagent-permissions.ts` (not named in any of
the three tickets, but directly relevant) builds the actual runtime
permission ruleset for a spawned subagent session: it inherits the parent's
deny rules and `external_directory` rules, then force-denies `todowrite` and
`task` unless the subagent's own ruleset explicitly allows them
(`subagent-permissions.ts:14-27`). This is where `plan`'s
`task: { general: "deny" }` really bites — a `plan`-mode session can never
successfully invoke `general` regardless of what the subagent itself allows.

## 2. Full surface map

Every place found that uses "agent" to mean the **Tab-switchable primary
persona** (`build`/`plan`/custom primaries) specifically — as opposed to
subagents/workers, which correctly keep "agent" and are out of scope.

**TUI keybinds** — `packages/tui/src/config/keybind.ts:129-131`:
`agent_list` (`<leader>a`, "List agents"), `agent_cycle` (`tab`, "Next
agent"), `agent_cycle_reverse` (`shift+tab`, "Previous agent"). Mapped to
command names via `CommandMap` at `keybind.ts:337-339`
(`agent.list`/`agent.cycle`/`agent.cycle.reverse`).

**TUI command palette** — `packages/tui/src/app.tsx:678-737`: command
`agent.list` (title "Switch agent", `slashName: "agents"`, opens
`DialogAgent`), `agent.cycle`/`agent.cycle.reverse` (both `hidden: true`,
call `local.agent.move(±1)`). All three, plus unrelated model/variant/MCP
commands, share `category: "Agent"` (app.tsx:660-747) — renaming this
category label affects that whole group, not just the three agent-switch
commands; worth a decision, see §6.

**CLI `--agent` flag wiring in the TUI process** — `app.tsx:481`:
`if (args.agent) local.agent.set(args.agent)`.

**Dialog component** — `packages/tui/src/component/dialog-agent.tsx` (whole
file): `DialogAgent`, dialog title `"Select agent"`, backed by
`local.agent.list()` / `.current()` / `.set()`.

**Helper functions** — `packages/app/src/context/local-agent.ts`:
`hasCustomAgent`, `resolveAgent`.

**The `local.agent` reactive namespace is not one thing — it's two
independent implementations, one per frontend, not cited by any ticket:**

1. `packages/tui/src/context/local.tsx:77-133` (`createAgent()`,
   instantiated at `local.tsx:135`, `const agent = createAgent()`) — the
   **terminal TUI's own** implementation, with its own local store
   (`agentStore`, line 80), and `list`/`current`/`set`/`move`/`color`
   methods (lines 92-132), sourced from `sync.data.agent` (line 78,
   filtered to `item.mode !== "subagent" && !item.hidden`). This is the one
   `dialog-agent.tsx`, `app.tsx`, `prompt/index.tsx`, and
   `routes/session/index.tsx` actually call into — `dialog-agent.tsx`
   imports `useLocal` from `../context/local`, which resolves to this file,
   not the one below.
2. `packages/app/src/context/local.tsx:182-231` (`const agent = { ... }`,
   exposing `list`/`visible`/`current`/`set`/`move`, no `color` method),
   re-exposed via the context's returned object at `local.tsx:378`
   (`result = { ..., model, agent, ... }`). This is a **separate**
   implementation used by the `packages/app` web/session-UI frontend
   (`prompt-input/submit.ts`, `new-session-draft-controller.ts`,
   `use-composer-commands.tsx`, `session-composer-controls.ts`) — a
   different frontend from the terminal TUI, not a shared module the TUI
   also depends on. A separate `model`/variant state block at
   `local.tsx:233-373` in this same file is not part of the `agent`
   namespace — it just calls `agent.current()` in passing.

Both must be renamed for XCOD-40 (its own Background cites files from both
`packages/tui` and `packages/app`), but as **two separate refactors**, not
one shared rename — there is no single definition site whose rename
propagates to both frontends.

**Full `local.agent.*` call-site list** (grep across `packages/tui` and
`packages/app`, superset of what the tickets found):
- `packages/tui/src/app.tsx:481,701,735`
- `packages/tui/src/component/dialog-agent.tsx:11,23,26`
- `packages/tui/src/component/prompt/index.tsx:323,326,961,1291,1293,1303-1306,1325-1327,1446` — this is the **prompt-bar agent name badge**: `Locale.titlecase(agent().name)` is rendered live next to the input box whenever not in shell mode (`prompt/index.tsx:1450`), a user-visible surface neither ticket's Background section names explicitly.
- `packages/tui/src/routes/session/index.tsx:335,338,1388,1557` — includes two **hardcoded** calls, `local.agent.set("build")` and `local.agent.set("plan")`, i.e. code that already spells out today's two primary names; XCOD-40 doesn't rename agent *names*, only the switcher vocabulary, so these calls themselves don't need to change, just confirm that.
- `packages/app/src/components/prompt-input/submit.ts:340`
- `packages/app/src/pages/new-session/new-session-draft-controller.ts:20`
- `packages/app/src/pages/session/use-composer-commands.tsx:71-80`
- `packages/app/src/pages/session/composer/session-composer-controls.ts:40-50`

**CLI flags** — `--agent` option declared at
`packages/opencode/src/cli/cmd/run.ts:170-173` and
`packages/opencode/src/cli/cmd/tui.ts:104-106`; consumed by
`localAgent`/`attachAgent`/`pickAgent` in `run.ts:595-668`, including
user-facing warning strings that say `agent "<name>" not found` /
`is a subagent, not a primary agent` (run.ts:606,614,644,653).

**The naming-collision CLI surface** —
`packages/opencode/src/cli/cmd/agent.ts`: `lunos agent create --mode
{all|primary|subagent}` (declared `cmd/agent.ts:46-50`, prompted
interactively at `cmd/agent.ts:157-184`), and `lunos agent list`, which
prints `${agent.name} (${agent.mode})` (`cmd/agent.ts:248`). This subcommand
manages agent/subagent **definition files** (primary or subagent), a
different concept from the Tab-switcher, and correctly keeps "agent" in its
name per the epic — only its `--mode` option is the collision to resolve
(see §5).

**Docs** (`packages/web/src/content/docs/`, not named by any ticket):
`agents.mdx` describes switching primary agents via "Tab" or a
`switch_agent` keybind, and describes three built-in subagents "General,
Explore, and Scout." Neither `switch_agent` (grep of `keybind.ts` — only
`agent_list`/`agent_cycle`/`agent_cycle_reverse` exist) nor a `Scout`
subagent (grep of `agent.ts` — only `general`/`explore` exist) is present in
this codebase today. This is stale documentation, most likely inherited from
upstream OpenCode before the Lunos fork, not a gap in the current system —
flagged here because XCOD-40 will already be editing this same doc page for
the rename and can fix the drift in the same pass (see §6).
`keybinds.mdx:66-68` also references `agent_list`/`agent_cycle`/
`agent_cycle_reverse` directly (accurately, matching current keybind names —
no drift there, just another rename call-site). `tui.mdx` was checked and
has no reference to the Tab-switcher concept — its only "agent"-adjacent
text is about `subagent_done` notification sounds (tui.mdx:410,417), which
is correctly out of scope.

**Explicitly out of scope, confirmed correctly named today** (not touched by
this epic): `packages/opencode/src/tool/task.ts` (the delegation tool
itself, `subagent_type` parameter), `subagent-permissions.ts`, the
`general`/`explore` entries, `dialog-subagent.tsx`/`subagent-footer.tsx`
(not read in this pass, per ticket's explicit out-of-scope list), and the
`Agent.Info.mode`/`ConfigAgent.Info.mode` schema field itself.

## 3. Claude Code comparison

Lunos-side claims below are file-cited above. Claude Code-side claims are
external knowledge of the product, not sourced from this repo — marked as
such rather than blended with the file-cited claims.

**(a) Plan Mode.** In Claude Code, Plan Mode is a real behavioral toggle: it
restricts the active session to read-only tools until the user explicitly
approves an exit (via an exit-plan-mode action that presents the drafted
plan for acceptance). Critically, Plan Mode does **not** block delegating to
subagents — a Plan Mode conversation can still dispatch Task-tool subagents
to do read-only research legwork; the restriction is on the primary
session's own tool access, not on delegation.

Lunos's `plan` is a **partial equivalent**: it correctly denies edit tools
except writes into a plans directory (agent.ts:171-176), mirroring the
read-only-until-approved shape. But it goes further than Claude Code's Plan
Mode by also setting `task: { general: "deny" }` (agent.ts:166) — an
additional restriction with no Claude Code counterpart. This is the gap
XCOD-41 is built to not repeat (see G1 below).

**(b) Subagents.** Claude Code subagents are typed workers with their own
system prompt, tool allow-list, and (optionally) model, invoked through a
delegation tool, and are user-extensible: anyone can define a new one and it
becomes available for delegation without touching Claude Code's own source.

Lunos's subagent model is structurally similar in shape (own prompt,
permission ruleset, invoked via the `task` tool — `task.ts:46`,
`subagent_type` parameter) but the *native* roster is fixed at two
(`general`, `explore`) hardcoded in `agent.ts:182-218`. Lunos does have a
config-driven extensibility path — `cfg.agent` entries merged at
agent.ts:267-294 can set `mode: "subagent"` and become delegatable — and a
CLI wizard for authoring them (`lunos agent create --mode subagent`,
`cmd/agent.ts`). So the primitive for extensibility exists; what's missing
relative to Claude Code is discoverability and polish (no in-TUI "create a
subagent" flow, no equivalent of Claude Code's richer per-agent tool
allow-list authoring surface) rather than the capability itself.

## 4. Gap list

- **G1 — no pure-research/no-edit mode.** `plan` is the closest built-in,
  but `task: { general: "deny" }` (agent.ts:166) makes it unusable for
  "delegate research, then write up findings" workflows — the exact shape
  XCOD-41 asks for. This is a capability Lunos lacks outright today, not a
  weaker version of one it has.
- **G2 — subagent roster is small, and its extensibility path isn't
  surfaced in the TUI.** Two native subagents vs. Claude Code's broader,
  freely user-definable set. The extension mechanism exists
  (`cfg.agent` + `lunos agent create`) but has no in-TUI equivalent, so a
  user mid-session can't spin up a new subagent the way they can in Claude
  Code.
- **G3 — no vocabulary distinction between "persona you talk to" and
  "worker it delegates to."** Both are called "agent" everywhere in the UI
  today (dialog title "Select agent" for primaries; docs describe invoking
  subagents via `@` mention) — this is the root motivation this whole epic
  exists to fix, not a new finding, but stated here for completeness.
- **G4 — "mode" is already a loaded word before this epic adds another
  sense of it.** Found four pre-existing/incoming uses:
  1. `Agent.Info.mode` / `ConfigAgent.Info.mode` — worker classification
     (agent.ts:38; config/agent.ts:19).
  2. `lunos agent create --mode` — CLI flag mirroring (1) (cmd/agent.ts:46-50).
  3. `store.mode: "normal" | "shell"` — the prompt input's own local UI mode
     toggle, unrelated to agents entirely
     (`packages/tui/src/component/prompt/index.tsx:286,296`, read at
     e.g. lines 402, 824, 1040, 1450-1455, 1663, 1682).
  4. `local.permission.mode === "auto"` — permission auto-approval mode,
     rendered right next to the agent-name badge in the same prompt bar
     (`prompt/index.tsx:1452`).

  Section 5 resolves only the (1)/(2) collision, which is the one the
  Background section names explicitly. (3) and (4) are separate, narrower
  collisions XCOD-40 should **not** attempt to rename — they predate this
  epic and aren't part of its scope — but its implementer should know they
  exist so code review doesn't confuse a `mode` reference to one of them for
  the new Tab-switcher concept.
- **G5 — stale docs, not a system gap.** `agents.mdx` references a `Scout`
  subagent and a `switch_agent` keybind that don't exist in this codebase
  (see §2). Doesn't block anything, but XCOD-40 will already be in this
  file for the rename and can fix the drift in the same pass.

## 5. Naming recommendation

**Decision** (not a menu of options):

**(a) The Tab-switchable concept becomes "Mode."** Every user-visible
surface renames "agent"/"Agent" → "mode"/"Mode" in this specific sense:
dialog title "Select mode" (`DialogAgent` → `DialogMode`,
`dialog-agent.tsx` → `dialog-mode.tsx`), keybind names `mode_list` /
`mode_cycle` / `mode_cycle_reverse`, command names `mode.list` / `mode.cycle`
/ `mode.cycle.reverse`, slash command `/modes`, CLI flag `--mode` on
`lunos run` / `lunos tui` (replacing `--agent`), and the reactive namespace
`local.mode.*` (replacing `local.agent.*`, including the definition site in
`packages/app/src/context/local.tsx:182-378`, not just the call sites the
tickets already found). The shared command-palette `category: "Agent"`
(app.tsx:660-747) should also become `"Mode"` for consistency, since it's
the same switcher's commands, even though it currently also groups
model/variant/MCP commands under that label — grouping unrelated commands
under the switcher's category is a pre-existing quirk, not something to fix
here, just carry the same category name forward.

**(b) `lunos agent create --mode {all|primary|subagent}` is renamed to
`--role`.** Same three choices, same meaning (worker classification), only
the flag name changes — because "mode" is moving to mean (a) everywhere else
in this CLI, and readers should not see `--mode` mean two different things
on two different subcommands even though they don't technically collide
(different subcommand namespaces). The underlying schema field name,
`Agent.Info.mode` / `ConfigAgent.Info.mode`, is **not** renamed — per the
epic's and both child tickets' explicit "must survive untouched" language,
only the CLI-facing option name for `agent create` changes, not the schema
it writes into or the `mode` property on the generated frontmatter
(`cmd/agent.ts:195-205`, which continues to write `mode: <value>` — only the
flag used to *collect* that value from the CLI user is renamed).

**(c) "Agent" / "subagent" terminology for workers is unchanged.** The
`task` tool, `subagent_type` parameter, `general`/`explore` entries,
`dialog-subagent.tsx`, `subagent-footer.tsx`, and the `lunos agent
create`/`lunos agent list` subcommand names all keep "agent." This is
explicit in both XCOD-40 and XCOD-41 already; restated here as the third leg
of one coherent vocabulary decision rather than left implicit.

`store.mode` (prompt input normal/shell toggle) and
`local.permission.mode` (auto-approval) are **not** touched by (a)-(c) —
see G4. They are unrelated concepts that happen to share a common English
word with the renamed concept; renaming either of them is out of scope for
this epic and would be unrelated scope creep.

## 6. Sequencing note (for XCOD-40 and XCOD-41)

**For XCOD-40 (rename):**
- The Background list in the ticket is a subset of the real surface, and it
  treats `local.agent` as one shared thing — it's actually two independent
  implementations (§2): rename both `createAgent()` in
  `packages/tui/src/context/local.tsx:77-133` (the TUI's own) and the
  `agent` object in `packages/app/src/context/local.tsx:182-231` (the
  separate web/session-UI one) as two separate edits, not one shared
  rename. Beyond what's already named there, also touch: the prompt-bar
  name badge in `packages/tui/src/component/prompt/index.tsx:1450`; the
  hardcoded `local.agent.set("build")` / `local.agent.set("plan")` calls in
  `packages/tui/src/routes/session/index.tsx:335,338` (these don't need
  edits themselves, just confirm they still compile against the renamed
  namespace); the four extra `packages/app/src/pages/**` call-sites listed
  in §2; and the command-palette `category: "Agent"` string in `app.tsx`.
- While already editing `packages/web/src/content/docs/agents.mdx` for the
  rename, also fix the stale `switch_agent` keybind reference and the
  `Scout` subagent that doesn't exist (G5) — same file, same pass, avoids
  compounding doc drift. Sweep `keybinds.mdx` and `tui.mdx` too.
- Apply the `--mode` → `--role` rename from §5(b) to
  `packages/opencode/src/cli/cmd/agent.ts` only (the `create` subcommand's
  option and its three prompt/handler branches at cmd/agent.ts:46-50 and
  157-184) — do not touch `lunos agent list`'s output format
  (`cmd/agent.ts:248`, `${agent.name} (${agent.mode})`), which prints the
  *schema* field, not the CLI flag, and is unaffected by the flag rename.

**For XCOD-41 (Research Mode):**
- Model the new entry structurally on `plan` (agent.ts:156-181), but do
  **not** copy its `task: { general: "deny" }` line (agent.ts:166) — that's
  precisely the restriction that makes `plan` the wrong template for
  research (G1, §3a). Everything else about `plan`'s shape (deny-all edit
  except a scoped `.md` glob, via the same `edit`/`external_directory`
  pattern at agent.ts:171-176) is the right template.
- `subagent-permissions.ts:14-27` derives a *spawned subagent's* effective
  permissions from the parent's deny rules; since this new mode must allow
  `task`, double-check with a permission-system test (as the ticket already
  requires) that a `general`/`explore` subagent spawned from this mode isn't
  incidentally re-denied by that inheritance logic.
- The new mode will be `native: true`, not `hidden`, matching `build`/`plan`
  (contrast with `compaction`/`title`/`summary`, which are `hidden: true`
  and must stay that way — don't pattern-match on the wrong sibling).

## Addendum: surface found during XCOD-40 implementation

§2 above described itself as a "full surface map" but missed a real layer:
`packages/app`'s own command-palette and i18n corpus. Recorded here so
XCOD-41's implementer (and anyone auditing this doc later) has the accurate
boundary rather than trusting the original claim at face value.

- **`packages/app` composer commands**
  (`packages/app/src/pages/session/use-composer-commands.tsx:65-81`): a
  second, independent set of Tab-switcher-equivalent commands
  (`agent.cycle`/`agent.cycle.reverse`, `slash: "agent"`) for the web/session
  UI frontend, parallel to the TUI's `app.tsx` commands. Renamed to
  `mode.cycle`/`mode.cycle.reverse`/`slash: "mode"` as part of XCOD-40. This
  frontend's `CommandOption` type (`packages/app/src/context/command.tsx:75-88`)
  has no `slashAliases`-equivalent field, unlike the TUI's `slashAliases`
  mechanism — so the legacy `/agent` slash trigger has **no deprecation
  shim** on this frontend. Adding one requires extending `CommandOption`
  plus wiring a toast/notice, which XCOD-40 did not do.
- **The i18n corpus** (`packages/app/src/i18n/`, ~50 locale files): the four
  English string values tied to the renamed commands
  (`command.agent.cycle`, `command.agent.cycle.description`,
  `command.agent.cycle.reverse`, `command.agent.cycle.reverse.description`)
  were updated from "agent" to "mode" wording. The *key paths* were
  deliberately left unchanged (they're lookup identifiers, not user copy —
  renaming them would touch all ~50 locale files for no user-visible
  benefit) and other locales' translated values still say "agent" in their
  own language until someone runs a normal translation update.
- **The broader settings-page surface** was deliberately left untouched:
  `command.category.agent` (command-palette category key, English value
  still "Agent"), `settings.agents.title`/`settings.agents.description`,
  `settings.general.row.showCustomAgents.title`/`.description` ("Switch
  between agents in the composer..."), and the notification/sound settings
  labeled "Agent" (`settings.general.notifications.agent.*`,
  `settings.general.sounds.agent.*`). These describe the same Tab-switcher
  concept in prose but sit a layer further from the mechanical rename than
  the command IDs; call it a judgment call to leave them for a follow-up
  pass rather than let this story's diff sprawl further.
- **`PromptInputControls.agents`**
  (`packages/app/src/components/prompt-input/contracts.ts:14-21`) and the
  persisted `State.agent`/`store.last.agent` fields
  (`packages/app/src/context/local.tsx`) were also left unrenamed: the
  former is a downstream consumer type with its own cascade into
  `prompt-input.tsx`, the latter is on-disk persisted session state — neither
  matches the AC's literal `local\.agent\.` grep target, and renaming either
  risks a much larger, less bounded change than this story asked for.

### Follow-up fixes made after a second advisor pass

A second review caught real regressions the first implementation pass
introduced. Fixed in the same branch, worth recording so the pattern isn't
repeated in XCOD-41:

- **The TUI's `/agents` shim was dead on arrival.** The first pass added a
  separate `hidden: true` command with `slashName: "agents"`, but
  `isVisiblePaletteCommand` (`packages/tui/src/keymap.tsx:49-51`) filters
  `hidden` commands out of the slash list entirely — so that command was
  never reachable and `/agents` would have hard-broken. Fixed by using
  `slashAliases: ["agents"]` on the canonical (visible) `mode.list` command
  instead — confirmed `fuzzysort` matches against `.aliases`
  (`packages/tui/src/component/prompt/autocomplete.tsx:502-509`), the same
  mechanism already used for `slashAliases: ["mo"]` on `model.list`. Trade-off:
  this path shows no deprecation toast (unlike the keybind and `--agent`-flag
  paths), since a shared `onSelect` can't tell which alias text was typed.
- **Stale command-ID string literals broke keybind-hint lookups.** Renaming
  `agent.cycle` → `mode.cycle` orphaned four separate lookups by the old
  literal: `packages/app/src/components/prompt-input-v2.tsx:393`,
  `packages/app/src/components/prompt-input.tsx:1658`,
  `packages/tui/src/feature-plugins/home/tips-view.tsx:101`, and a Storybook
  mock at `packages/storybook/.storybook/mocks/app/context/command.ts:6`. All
  four now reference `"mode.cycle"`. Found via `git grep` for the literal
  command-name strings, not by tsgo — command IDs are plain strings, so the
  type checker can't catch a rename that leaves a stale lookup behind.
- **An external HTTP API used the old keybind action name as its wire
  vocabulary.** `packages/opencode/src/server/routes/instance/httpapi/handlers/tui.ts`
  has a legacy `/tui/execute-command` endpoint whose `commandAliases` map
  translates snake_case action names (e.g. `agent_cycle`) to internal
  command names (`"agent.cycle"`) — this is a pre-existing legacy-alias
  pattern, not something XCOD-40 introduced. Updated `agent_cycle` to map to
  `"mode.cycle"` (keeping the external wire key working) and added
  `mode_cycle` as the new canonical wire key. Also added `"mode.cycle"` as a
  documented literal in the source schema
  (`packages/schema/src/tui-event.ts`, `CommandExecute.command`), additively
  — `"agent.cycle"` stays listed too, since the schema always had a
  `Schema.String` fallback and removing it would just be documentation
  churn. Generated SDK files under `packages/sdk/js/src/gen/` and
  `packages/client/src/generated-effect/` were **not** regenerated (would
  need `bun run generate` in `packages/client`, not run this pass) — they
  still only list `"agent.cycle"` as a typed literal; this is a docs/autocomplete
  gap in the generated types, not a functional break, since the underlying
  schema accepts any string.
- **Docs fixes**: `packages/web/src/content/docs/keybinds.mdx`'s full
  keybind-defaults JSON dump still had `agent_list`/`agent_cycle`/
  `agent_cycle_reverse` — updated to `mode_list`/`mode_cycle`/
  `mode_cycle_reverse`. `agents.mdx`'s two references to a `switch_agent`
  keybind (which never existed under that literal name, before or after
  this rename) were corrected to `mode_cycle`. The rest of `agents.mdx` —
  which is almost entirely about the config-file agent-authoring surface
  (`mode: primary|subagent|all`, permissions, `agent create`) — was left
  alone: that's the correctly-named, out-of-scope "agent" concept, not the
  Tab-switcher, and a full editorial pass distinguishing the two throughout
  a 780-line doc is a separate task from this rename. Its stale "Scout"
  subagent mention (G5, §2) was also left as-is.
- **The help-text snapshot test** (`packages/opencode/test/cli/help/help-snapshots.test.ts`)
  needed `--update-snapshots` after the CLI flag rename — a legitimate diff
  (new `--mode`/`--role` help text replacing `--agent`/`--mode`), not a
  regression.
