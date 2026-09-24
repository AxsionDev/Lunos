# Plugin API v2: plan vs. implementation

Audit for XCOD-70, child of XCOD-66 (Phase 2 — Core parity). Grounded against
`origin/dev` at `fd9a4a85c5` (2026-09-22).

## Why this audit exists

The Phase 2 roadmap framed the plugin API as "finish the design upstream has left open."
That was wrong in both directions, and this audit establishes what is actually true.

`packages/plugin/src/v2/effect/PLAN.md` opens by declaring itself "the agreed target
design … an implementation plan, not documentation for the current API." Taken at face
value that implies the API is unbuilt and undocumented. Neither holds:

- The implementation exists — 9 domains across `v2/effect` and `v2/promise`, wired into
  core via `plugin/host.ts`, with real consumers (`plugin/provider/openai.ts`,
  `opencode.ts`, `github-copilot.ts`, `config/plugin/external.ts`).
- **Both APIs are already documented accurately.** `v2/effect/README.md` and
  `v2/promise/README.md` each sit next to the code and describe the current API using the
  names the code actually uses — including `reload`, which is what the code does, rather
  than PLAN.md's `rebuild`. The ticket's premise that current-API documentation is missing
  is simply false.

So the documentation acceptance criterion was substantially met before this story started.
What was missing is the comparison below, and an honest list of what is still unbuilt.

The whole v2 surface is small: roughly 400 lines of types across both APIs, plus ~540
lines of core wiring.

## Comparison

| PLAN.md says                                                                   | Implementation                                                        | Verdict           |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ----------------- |
| `define({ id, effect })` authoring model                                       | Same, `v2/effect/plugin.ts`                                           | as planned        |
| Plugin setup does not return hooks                                             | Same — `effect` returns `Effect<void, never, R>`                      | as planned        |
| `Registration { dispose }`, scope-owned, idempotent                            | Same, both APIs                                                       | as planned        |
| Transforms have no typed error channel                                         | Same — error channel is `never`                                       | as planned        |
| Transforms may perform arbitrary Effects                                       | Same                                                                  | as planned        |
| Registration is scoped and independently disposable                            | Same, `registration.ts`                                               | as planned        |
| Explicit domain replay named **`rebuild()`**                                   | Named **`reload()`** (`Reload` interface)                             | **deviated**      |
| Domains: agent, command, integration, reference, session, skill, tool, catalog | agent, aisdk, catalog, command, integration, plugin, reference, skill | **deviated**      |
| `ctx.tool.hook("execute.before", …)` runtime interception                      | **Does not exist.** No `tool` domain in either API                    | **not built**     |
| `ctx.event.subscribe(type)` returning typed Streams                            | `effect/event.ts` defines it, but it is unexported and unreferenced   | **dead code**     |
| Promise API "will be designed afterward", "deferred"                           | Fully implemented and exported, mirroring the Effect API              | **ahead of plan** |

### Deviations in detail

**`rebuild` → `reload`.** PLAN.md's "Public Naming" section settles on `rebuild` for
explicit domain replay. The implementation uses `reload` throughout, and README.md
documents `reload`. The code and its README agree with each other; only PLAN.md is out of
step. No action beyond retiring PLAN.md as a live reference.

**Domain set differs on both sides.** PLAN.md's migration step 4 lists a `tool` domain and
its "Public Naming" section also names `session`. Neither exists. Conversely the
implementation adds two domains PLAN.md never mentions: `aisdk` (SDK and language-model
resolution hooks, used by every provider plugin and by residency enforcement) and `plugin`
(`add`/`remove`, for dynamic plugin management). The additions are load-bearing, so the
plan is simply behind here.

**The missing `tool` domain has already cost real work.** XCOD-68 was written instructing
its implementer to build config-driven hooks "on top of the existing `ctx.tool.hook`
registration mechanism," citing PLAN.md. That mechanism does not exist, and the story had
to be re-planned mid-flight onto the v1 dispatch instead. This is the concrete cost of
leaving an aspirational document looking authoritative.

**The event API is dead code.** `effect/event.ts` defines `EventMap` and an `Event`
interface with `subscribe`. It is not exported from `effect/index.ts`, not a member of
`PluginContext`, and not referenced anywhere outside itself and PLAN.md. A plugin author
cannot reach it. PLAN.md's migration step 8 ("Add Event Adapter") is unstarted, and
`core/src/event.ts`'s `EventV2` — which the domain would delegate to — is unrelated to it.

**The two APIs expose different amounts of their own surface.** `promise/index.ts` exports
the drafts, hooks, `Registration` and `Reload`. `effect/index.ts` exports only
`PluginContext`, `define` and `Plugin`. An Effect plugin author who wants to name a
`Registration` or an `AgentDraft` in their own code has to reach past the package entry
point — `package.json` happens to expose `./v2/effect/plugin` and `./v2/effect/integration`
as deep imports, but not `registration` or the drafts.

## What is genuinely unfinished

Ordered by how load-bearing each is, not by size.

**P1 — No `tool` domain in v2.** PLAN.md steps 4 and 6 both require it; neither is done.
This is the gap that broke XCOD-68's plan, and it is what a v2-native version of
config-driven hooks would need. Until it exists, all tool interception runs through the v1
`Plugin.trigger` path.

**P2 — Event API is defined but unreachable.** Either wire `event` into `PluginContext`
(delegating to `EventV2`, per PLAN.md step 8) or delete `effect/event.ts`. Leaving a typed
interface that no one can import is the worst of both: it reads as a feature in code review
and does nothing at runtime. Deleting is defensible — the concrete need is unproven.

> **Resolved 2026-09-24 (XCOD-76):** deleted. `effect/event.ts` is gone and PLAN.md marks the Event API as not implemented.

**P3 — PLAN.md is stale and self-describes as authoritative.** Its "Status" section invites
readers to treat it as the plan of record, which is how XCOD-68 and XCOD-70 both came to be
written on false premises. It should be marked superseded and point at README.md, with the
genuinely unbuilt parts (tool domain, event adapter) tracked as tickets instead.

**P4 — The two APIs disagree on the name of the setup function.** The Effect API's
`Plugin` requires `effect:`; the Promise API's requires `setup:`. Same concept, same
position, different key, and PLAN.md's authoring model shows `effect`. Anyone porting a
plugin between the two hits this immediately, and it is invisible until the type error.
Worth either aligning or documenting as deliberate — currently it is neither.

**P5 — `effect/index.ts` under-exports** relative to `promise/index.ts`. Small, but it
forces deep imports for ordinary type annotations.

**P6 — Both READMEs are still opencode-branded** ("OpenCode V2 Effect Plugin API",
"OpenCode V2 Promise Plugin API", "installs behavior at an OpenCode extension point").
Rebrand family, flagged in passing.

**Not a gap: Promise API documentation.** An earlier draft of this audit listed "no
Promise API docs" as a finding. That was wrong — `v2/promise/README.md` exists and is
accurate. The claim came from checking that `v2/effect/README.md` existed and assuming its
absence next door rather than looking. Recorded because the same assumption produced two
false findings in XCOD-67, and the correction is cheaper to remember than to re-derive.

## Upstream decision

**Recorded 2026-09-22 (owner): stay Lunos-only. Do not upstream the v2 plugin API to
`anomalyco/opencode`.**

The recommendation put to the owner was the opposite — the v2 plugin API is generic
infrastructure carrying no Lunos differentiation, and the roadmap's own fork-drift
mitigation calls for upstreaming generic contributions while keeping a thin Lunos-specific
layer. The owner's call overrides that.

Consequence worth tracking rather than assuming flat: every generic subsystem kept private
is permanent merge surface against upstream, and that surface now grows. This repo already
merges rather than rebases from upstream for exactly this reason.

One second-order effect: the decision _raises_ the value of P6 and of keeping both READMEs
current. An internal-only API has no upstream documentation to fall back on, so its own
docs are the only ones that will ever exist.
