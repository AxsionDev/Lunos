---
name: research-mode
description: Use when a developer agent is invoked for bug investigation rather than implementation — the prompt says "Mode: RESEARCH ONLY" / "DO NOT propose fixes", or the request comes from the research-orchestrator. Investigate and report with evidence; do not modify code.
---

# Research Mode

## Overview

A distinct mode for developer agents (backend/frontend/database): **investigate and report, do not change code.** You gather evidence and form hypotheses for a downstream fixer; you do not design or apply solutions.

## You are in Research Mode when

The prompt includes any of: `Mode: RESEARCH ONLY`, `DO NOT propose fixes`, or a request from the `research-orchestrator`.

## Workflow

1. **Analyze the investigation brief** — symptoms, error messages, reproduction steps.
2. **Search the codebase** — Glob/Grep to find relevant files for your layer.
3. **Trace data flows** — follow the call chains in your layer (e.g. controller → service → repository; component → service → API).
4. **Identify suspicious patterns** — null refs, missing validation, exception gaps, unhandled edge cases.
5. **Form hypotheses** — from evidence, not speculation.
6. **Document findings** — every finding cites `file:line`.

## Output Format

````markdown
## [Layer] Research Report

### Summary

[One paragraph: what you investigated and key findings]

### Files Examined

| File | Lines | Finding | Relevance |
| ---- | ----- | ------- | --------- |

### Code Analysis

#### Finding 1: [Title]

```[lang]
// File: path:line — Issue: [what's wrong]
[snippet]
```
````

**Why This Matters:** [link to the reported symptom]

### Hypotheses

| #   | Hypothesis | Evidence For | Evidence Against | Confidence |
| --- | ---------- | ------------ | ---------------- | ---------- |

### [Layer] Involvement Assessment

- **Involved:** Yes/No
- **Reasoning:** [why]

### Gaps and Uncertainties

- [What you couldn't determine]

```

## Constraints

**MUST:** focus on evidence not solution design; cite `file:line` for every finding; assess confidence per hypothesis; document what you couldn't determine.

**MUST NOT:** propose fixes or code changes; modify any files; assume without evidence; speculate without investigation.

## Common Mistakes

- Slipping into fix-design (that's the fixer's job — stay in evidence-gathering).
- Findings without `file:line`.
- Stating a hypothesis as fact — mark confidence and contradicting evidence honestly.
```
