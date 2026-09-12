---
name: bug-investigation
description: Use when triaging a raw bug report into structured context, or conducting root-cause investigation of a defect — forming evidence-based hypotheses, classifying severity, tracing data flow, and identifying investigation paths.
---

# Bug Investigation

## Overview

Shared discipline for bug work, whether **triaging** a raw report into structured context (bug-reviewer agents) or **investigating** root cause (bug-investigator agents). The kernel is the same: evidence over speculation, every claim tied to `file:line`, hypotheses ranked with explicit confidence.

## Mode references (load what fits your role)

| Your role | Reference |
|-----------|-----------|
| Triage a raw report → structured Bug Analysis Report | `references/bug-triage.md` |
| Collaborative root-cause investigation (Alpha/Beta rounds) | `references/collaborative-dialogue.md` |

## Evidence discipline (always)

- Every finding cites `file:line`.
- Distinguish **"I know"** (verified) from **"I suspect"** (hypothesis) explicitly.
- For each hypothesis: evidence **for**, evidence **against** (or "none found"), and **confidence** (High/Medium/Low).
- Do not fix in triage/research roles — analysis only unless your role's protocol says otherwise.

## Hypothesis formation

1. Form 1–3 hypotheses about the root cause.
2. Rank by likelihood from the evidence.
3. For each, document what would **confirm or refute** it.

## Classification framework

**Severity:** P0-Critical (data corruption / security / outage) · P1-High (major path broken, no workaround) · P2-Medium (partial / edge case, workaround exists) · P3-Low (minor / cosmetic).

**Affected layer vs root-cause layer** — note both; the symptom layer often differs from where the bug originates (e.g. UI symptom, service-layer cause).

## Data-flow tracing

Map the request/interaction journey end to end: entry point → each layer invoked → data store / external dependency → response. The trace localizes where symptom and cause diverge.

## Frontend bugs — browser-first

For any UI/visual/browser behavior, use the **Gemini → Chrome DevTools → Playwright** tool hierarchy and the **Reproduce → Fix → Verify** workflow (capture a pre-fix baseline screenshot/DOM/console, then verify post-fix against it). Full protocol: `.claude/agents/_gemini-design-hook.md`. Code reading alone cannot reveal runtime state, CSS conflicts, or timing issues.

## Common Mistakes

- Findings or investigation paths without `file:line`.
- A single hypothesis stated as certainty — always rank and show contradicting evidence.
- Skipping the browser baseline for a UI bug, then "verifying" a fix with nothing to compare against.
- Fixing during a triage/analysis role.
