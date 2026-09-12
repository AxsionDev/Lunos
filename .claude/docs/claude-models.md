# Claude Models - Reference Documentation

> **Generated:** 2026-06-11
> **Scope:** Complete catalog of currently-active Claude models, their capabilities, pricing, API behavior, and "which model for what" guidance — with a focus on the newest model, **Claude Fable 5**.
> **Source of truth:** The bundled `claude-api` skill model catalog (cached 2026-06-04). Model IDs below are authoritative — use them exactly, never append date suffixes to aliases.
> **Primary reference files:** `claude-api` skill → `shared/models.md`, `shared/model-migration.md`

## Overview

This document is a local, AI-agent-friendly reference for choosing and using Claude models. It covers every active model, its pricing and limits, the API quirks that will cause `400` errors if you get them wrong, and a decision guide for matching a model to a task. The headline addition is **Claude Fable 5** — Anthropic's most capable widely released model, which sits *above* the Opus tier and has a meaningfully different API contract from the Opus family.

---

## Quick Catalog (Current / Recommended Models)

| Model | Model ID (use this) | Context | Max Output | Input $/1M | Output $/1M | Tier |
|-------|---------------------|---------|------------|-----------|-------------|------|
| **Claude Fable 5** | `claude-fable-5` | 1M | 128K | $10.00 | $50.00 | Frontier / most capable |
| **Claude Mythos 5** | `claude-mythos-5` | 1M | 128K | $10.00 | $50.00 | Frontier (Project Glasswing only) |
| **Claude Opus 4.8** | `claude-opus-4-8` | 1M | 128K | $5.00 | $25.00 | Opus (most capable Opus-tier) |
| **Claude Opus 4.7** | `claude-opus-4-7` | 1M | 128K | $5.00 | $25.00 | Opus (previous gen) |
| **Claude Opus 4.6** | `claude-opus-4-6` | 1M | 128K | $5.00 | $25.00 | Opus (older) |
| **Claude Sonnet 4.6** | `claude-sonnet-4-6` | 1M | 64K | $3.00 | $15.00 | Sonnet (speed + intelligence) |
| **Claude Haiku 4.5** | `claude-haiku-4-5` | 200K | 64K | $1.00 | $5.00 | Haiku (fast + cheap) |

> **Default model:** Unless you have a specific reason otherwise, use **`claude-opus-4-8`**. Use `claude-fable-5` only when you explicitly want the most capable model and accept the higher price + different API contract. Never silently downgrade for cost — that is the user's decision.

### Legacy / still-active (pin only if you need them)

| Model | Model ID | Status |
|-------|----------|--------|
| Claude Opus 4.5 | `claude-opus-4-5` | Active |
| Claude Opus 4.1 | `claude-opus-4-1` | Deprecated — retires 2026-08-05 → migrate to `claude-opus-4-8` |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | Active |
| Claude Sonnet 4 | `claude-sonnet-4-0` | Deprecated → `claude-sonnet-4-6` |
| Claude Opus 4 | `claude-opus-4-0` | Deprecated → `claude-opus-4-8` |
| Claude Haiku 3 | `claude-3-haiku-20240307` | Deprecated — retires 2026-04-19 → `claude-haiku-4-5` |

### Recently retired (return 404 — replace immediately)

| Retired model | Replacement |
|---------------|-------------|
| `claude-3-7-sonnet-20250219` (retired 2026-02-19) | `claude-sonnet-4-6` |
| `claude-3-5-haiku-20241022` (retired 2026-02-19) | `claude-haiku-4-5` |
| `claude-3-opus-20240229` (retired 2026-01-05) | `claude-opus-4-8` |
| `claude-mythos-preview` (invite-only preview) | `claude-mythos-5` (Glasswing) or `claude-fable-5` (GA) |

---

## ⭐ Claude Fable 5 — The New Flagship

**`claude-fable-5`** is Anthropic's most capable widely released model, built for the most demanding reasoning and **long-horizon agentic work**. It is *not* the default Opus upgrade path — it is a higher tier with higher pricing ($10/$50 per 1M vs Opus's $5/$25) and a different API surface.

- **Context:** 1M tokens (the maximum is also the default).
- **Max output:** 128K tokens.
- **Pricing:** $10.00 input / $50.00 output per 1M tokens — above Opus-tier.

> **Claude Mythos 5** (`claude-mythos-5`) is the *same model* — identical capabilities, pricing, limits, and API behavior — available only through **Project Glasswing**. It succeeds the invite-only `claude-mythos-preview`. Use `claude-mythos-5` only if your org participates in Glasswing; otherwise use `claude-fable-5`. Everything below applies to both.

### What makes Fable 5 different (API contract)

These are the breaking differences vs the Opus family. Getting them wrong produces `400` errors.

| Behavior | Fable 5 contract |
|----------|------------------|
| **Thinking** | **Always on.** Omit the `thinking` parameter entirely (or send `{type: "adaptive"}`). `{type: "disabled"}` → **400**. `{type: "enabled", budget_tokens: N}` → **400**. Control depth with `output_config.effort` (`low`→`xhigh`, `max`). |
| **Protected thinking** | The **raw chain of thought is never returned.** Responses carry regular `thinking` blocks: `display: "summarized"` gives a readable summary; `"omitted"` (the default) leaves the text empty. Echo thinking blocks back **unchanged** on the same model; a *different* model silently drops them from the prompt (unbilled). |
| **Tokenizer** | **New tokenizer — ~30% more tokens** for the same content vs Opus-tier. Re-baseline token counts, context budgets, and `max_tokens` with `count_tokens` (pass `model: "claude-fable-5"` — the response returns counts under both tokenizers). |
| **`refusal` stop reason** | Safety classifiers may decline a request: **HTTP 200** with `stop_reason: "refusal"` + a `stop_details.category`. Pre-output refusal = empty `content`, not billed; mid-stream = partial output billed (discard it). **Always check `stop_reason` before reading `content[0]`.** |
| **Assistant prefill** | Not supported (same as the 4.6+ family). Use `output_config.format` (structured outputs) or system-prompt instructions. |
| **Sampling params** | `temperature`, `top_p`, `top_k` are removed → **400** if sent. Steer with prompting. |
| **Data retention** | Requires **30-day data retention.** Not available under zero-data-retention (ZDR); a ZDR/sub-30-day org gets `400 invalid_request_error` on *every* request regardless of payload. |
| **Turn length** | Single requests on hard tasks can run **many minutes** at high effort. Plan timeouts, streaming, and async progress UX. |

### When Fable 5 shines (and when not to bother)

**Use Fable 5 for:**
- Long-horizon autonomous agentic runs (overnight coding, complex multi-step refactors that complete without human correction).
- First-shot implementation of well-specified systems.
- End-to-end enterprise deliverables (financial analysis, spreadsheets, slides, docs with self-verification).
- Deep code review / debugging (excluding security-focused analysis — cyber classifiers apply there).
- Repository-history search, parallel sub-agent delegation, vision on dense/degraded images.
- Navigating genuine ambiguity where you want the strongest planning.

**Don't reach for Fable 5 when:**
- The task is routine — Opus 4.8 or Sonnet 4.6 is cheaper and plenty capable.
- You need security/biology-domain work (classifiers target these; benign adjacent work can false-positive).
- You're in a ZDR org (it's simply unavailable).
- You just want "the latest model" — that request resolves to `claude-opus-4-8`, not Fable 5.

### Prompting Fable 5 (it differs from prior models)

Prompts tuned for older models are often **too prescriptive** and *reduce* Fable 5's output quality. Key levers:
- **Run an effort sweep including `low`/`medium`** for routine work — low effort on Fable 5 often beats `xhigh`/`max` on prior models.
- **Add a "no unrequested tidying/refactoring" instruction** at higher effort, or it may over-build.
- **Ground progress claims** ("audit each claim against a tool result before reporting") — nearly eliminates fabricated status on long runs.
- **State boundaries explicitly** ("when the user is thinking out loud, report findings and stop; don't apply a fix until asked").
- **Let it delegate to async sub-agents** — reliable on Fable 5; give explicit "when to delegate" guidance instead of suppressing it.
- **Give it a memory surface** (even a plain `.md` file) — it performs notably better when it can write learnings for future reference.
- **Add a `send_to_user` tool** for verbatim mid-task delivery (tool inputs are never summarized).

---

## The Rest of the Lineup

### Claude Opus 4.8 (`claude-opus-4-8`) — recommended default

The most capable **Opus-tier** model: highly autonomous, state-of-the-art on long-horizon agentic work, knowledge work, and memory; clearer, warmer writing than 4.7. **Same API surface as Opus 4.7 — no new breaking changes.** 1M context at standard pricing (no long-context premium). A 4.7 → 4.8 move is a model-ID swap plus prompt re-tuning.

- Adaptive thinking only (`{type: "adaptive"}`); `budget_tokens` and sampling params removed.
- `thinking.display` defaults to `"omitted"` — set `"summarized"` if you surface reasoning.
- New feature: **mid-session system prompts** (`role: "system"` in `messages`, beta `mid-conversation-system-2026-04-07`) — inject context mid-conversation without invalidating the prompt cache.
- Behavioral notes: narrates *more* than 4.7 (add a silence-default for terse coding agents); asks permission more often (add small-decisions-don't-ask guidance); under-reaches for search/subagents/memory/custom tools (add explicit "when to use" triggers).

### Claude Opus 4.7 (`claude-opus-4-7`) — previous-gen Opus

Highly autonomous; strong on long-horizon agentic work, knowledge work, vision, and memory. First Claude with **high-resolution vision** (up to 2576px long edge, coordinates 1:1 with pixels). Introduced **Task Budgets** (beta) and the **`xhigh`** effort level. Adaptive thinking only; sampling params + `budget_tokens` removed; `thinking.display` defaults to `"omitted"`.

### Claude Opus 4.6 (`claude-opus-4-6`) — older Opus

Supports adaptive thinking (recommended) **and** still accepts `budget_tokens` as a deprecated transitional escape hatch. 128K max output (requires streaming for large outputs). 1M context. Has a Fast Mode variant (`claude-opus-4-6-fast`); 4.7/4.8 do not.

### Claude Sonnet 4.6 (`claude-sonnet-4-6`) — best speed/intelligence balance

Anthropic's best combination of speed and intelligence for high-volume production workloads. Adaptive thinking supported; `budget_tokens` deprecated. 1M context, 64K max output. Supports `effort` up to `max`. **When migrating Sonnet 4.5 → 4.6, set `effort` explicitly** — 4.6 defaults to `high`, which changes your latency/cost profile.

### Claude Haiku 4.5 (`claude-haiku-4-5`) — fastest + cheapest

Fastest and most cost-effective model for simple, speed-critical tasks (classification, extraction, simple Q&A, high-volume routing). 200K context (the only sub-1M model in the current lineup), 64K max output. Does **not** support the `effort` parameter (errors if sent). Separate rate-limit pool from Haiku 3.x.

---

## "Which Model for What" Decision Guide

| Task / Use case | Recommended model | Why |
|-----------------|-------------------|-----|
| Simple classification / extraction / routing at volume | `claude-haiku-4-5` | Fastest, cheapest; no thinking overhead needed |
| Summarization / Q&A / content generation (production volume) | `claude-sonnet-4-6` | Best speed/intelligence/cost balance |
| Most general engineering, coding, agentic work | `claude-opus-4-8` | The recommended default; top Opus-tier intelligence |
| Interactive coding agent | `claude-opus-4-8` at `high`/`xhigh` effort | Strong autonomy; re-tune effort per route |
| Long-horizon autonomous agents (overnight runs, big migrations) | `claude-fable-5` | Most capable; state-of-the-art long-horizon execution |
| First-shot build of a well-specified complex system | `claude-fable-5` | Highest planning + execution ceiling |
| Deep code review / bug hunting (non-security) | `claude-fable-5` or `claude-opus-4-8` | Higher recall + precision; report-everything-then-filter |
| Vision-heavy (screenshots, charts, documents, computer use) | `claude-opus-4-8` / `claude-opus-4-7` | High-res vision, pixel-accurate coordinates |
| Enterprise deliverables (xlsx/docx/pptx with self-verification) | `claude-fable-5` | Strong self-verifying knowledge work |
| Cost-sensitive but needs reasoning | `claude-sonnet-4-6` at `low`/`medium` effort | Tunable depth, half the Opus price |
| Security or biology domain work | **Not Fable 5** — use `claude-opus-4-8` | Fable 5 classifiers target/refuse these domains |
| ZDR (zero data retention) org | Any except Fable 5/Mythos 5 | Fable 5 requires 30-day retention |

### Effort parameter quick guide (Opus 4.5+, Sonnet 4.6, Fable 5 — not Haiku)

`output_config: {effort: "low" | "medium" | "high" | "xhigh" | "max"}` (inside `output_config`, not top-level). Default is `high`. `xhigh` added in Opus 4.7 (best for most coding/agentic work). `max` is Opus-tier+ only.

- `low` — subagents, simple/latency-sensitive tasks. On Fable 5, often beats prior models' `xhigh`.
- `medium` — cost-sensitive balance.
- `high` — default; most intelligence-sensitive work.
- `xhigh` — best for most coding and agentic use cases (Claude Code default).
- `max` — correctness matters more than cost; can overthink.

---

## Thinking & Effort — Cheat Sheet by Model

| Model | Thinking config | Notes |
|-------|-----------------|-------|
| Fable 5 / Mythos 5 | Omit `thinking` (always on) or `{type: "adaptive"}` | `{type: "disabled"}` → 400; `budget_tokens` → 400 |
| Opus 4.8 / 4.7 | `{type: "adaptive"}` | `budget_tokens` → 400; `{type: "disabled"}` allowed |
| Opus 4.6 / Sonnet 4.6 | `{type: "adaptive"}` (recommended) | `budget_tokens` deprecated but still functional |
| Haiku 4.5 / older | `{type: "enabled", budget_tokens: N}` | `budget_tokens` must be < `max_tokens`, min 1024; no `effort` |

> **`max_tokens` defaults:** non-streaming → ~16000 (avoids SDK HTTP timeouts); streaming → ~64000. Fable 5 / Opus 4.6/4.7/4.8 support up to 128K output **but require streaming** at large values.

---

## Common Pitfalls (will cause errors)

1. **Fable 5 `thinking: {type: "disabled"}` → 400.** Omit the param entirely.
2. **`budget_tokens` on Fable 5 / Opus 4.7 / 4.8 → 400.** Use `{type: "adaptive"}` + `effort`.
3. **`temperature` / `top_p` / `top_k` on Fable 5 / Opus 4.7 / 4.8 → 400.** Remove them; steer via prompting.
4. **Reading `response.content[0]` on Fable 5 without checking `stop_reason`** → breaks on refusals. Branch on `stop_reason == "refusal"` first.
5. **Reusing token counts across tokenizers** — Fable 5 counts ~30% higher. Re-baseline.
6. **ZDR org + Fable 5** → 400 on every request. Check retention config before debugging the payload.
7. **Assistant prefills on any 4.6+ model or Fable 5 → 400.** Use `output_config.format`.
8. **Appending date suffixes to aliases** (e.g. `claude-sonnet-4-6-20251114`) → 404. Use the bare alias.
9. **Sonnet 4.5 → 4.6 without setting `effort`** → unexpected latency/cost (4.6 defaults to `high`).

---

## Programmatic Model Discovery (live capabilities)

The tables above are cached. For live context windows, max output, and feature support, query the Models API:

```python
m = client.models.retrieve("claude-fable-5")
m.max_input_tokens          # context window
m.max_tokens                # max output tokens
m.capabilities["thinking"]["types"]["adaptive"]["supported"]
m.capabilities["effort"]["max"]["supported"]

# Filter all models by capability (iterate directly — auto-paginates)
[m for m in client.models.list()
 if m.capabilities["image_input"]["supported"]
 and m.max_input_tokens >= 1_000_000]
```

```bash
curl https://api.anthropic.com/v1/models/claude-fable-5 \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
```

---

## Related Documentation

- **`claude-api` skill** — the authoritative reference for model IDs, pricing, params, streaming, tool use, caching. Invoke it before writing any Claude API code.
  - `shared/models.md` — full catalog + resolution table for user phrasing ("fable", "opus", "fast", etc.)
  - `shared/model-migration.md` — breaking changes and per-model migration steps (incl. "Migrating to Claude Fable 5")
  - `shared/live-sources.md` — WebFetch URLs for the latest official docs, incl. "Introducing Claude Fable 5"

## Agent Notes

> **Quick Start:** For any task that involves calling a Claude model, default to `claude-opus-4-8`. Only choose `claude-fable-5` when the user explicitly asks for the most capable model or the task is long-horizon/high-stakes agentic work and the higher cost + 30-day-retention requirement are acceptable.
>
> **Common Pitfalls:** The biggest trap is treating Fable 5 like an Opus model — it has a different API contract (always-on thinking, new tokenizer, refusal handling, no ZDR). Always check `stop_reason` before reading content, and never send `thinking: {type: "disabled"}` or `budget_tokens` to it.
>
> **Extension Points:** When this doc goes stale (new model launches), refresh from the `claude-api` skill's `shared/models.md` and `shared/model-migration.md`, or WebFetch the live sources. The model ID strings in the skill are the source of truth — do not invent or date-suffix them.
