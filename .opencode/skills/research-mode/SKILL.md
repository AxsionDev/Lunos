---
name: research-mode
description: Use when investigating a bug or tracing behaviour rather than implementing — the request says "Mode: RESEARCH ONLY", "DO NOT propose fixes", or asks you to investigate and report. Gather evidence and form hypotheses; do not modify code.
---

# Research Mode

## Overview

A distinct mode for investigation: **gather evidence and report, do not change code.** You
produce findings and hypotheses for whoever fixes the problem; you do not design or apply
solutions.

## You are in Research Mode when

The request includes any of: `Mode: RESEARCH ONLY`, `DO NOT propose fixes`, or asks you to
investigate and report rather than fix.

## Enforcing read-only

Lunos has no per-skill tool restriction, so this skill cannot declare "read-only" and have
the runtime honour it. Instead, take the lock and let the configured hook enforce it:

```bash
touch .opencode/research-mode.lock
```

While that file exists, the `research-mode-guard` hook vetoes `apply_patch` and any
mutating `bash` command, so a slip into fix-mode fails loudly instead of silently editing
the tree. Release it when the investigation is done:

```bash
rm -f .opencode/research-mode.lock
```

Take the lock **before** you start investigating. A guard you enable after the edit has
already happened is decoration.

## Workflow

1. **Analyse the brief** — symptoms, error messages, reproduction steps.
2. **Search the codebase** — `glob` and `grep` to find relevant files.
3. **Trace data flows** — follow the call chains (e.g. route → service → repository;
   component → service → API).
4. **Identify suspicious patterns** — null refs, missing validation, swallowed exceptions,
   unhandled edge cases.
5. **Form hypotheses** — from evidence, not speculation.
6. **Document findings** — every finding cites `file:line`.

## Verifying a negative

A grep that returns nothing is only evidence of absence if the search could have
succeeded. Before reporting "X does not exist", confirm the files you searched are
non-empty and that a term you _expect_ to match does match. An empty result over zero files
proves nothing.

## Output Format

```markdown
## Research Report

### Summary

[One paragraph: what you investigated and the key findings]

### Files Examined

| File | Lines | Finding | Relevance |
| ---- | ----- | ------- | --------- |

### Code Analysis

#### Finding 1: [Title]

`path:line` — [what's wrong]

**Why this matters:** [link back to the reported symptom]

### Hypotheses

| #   | Hypothesis | Evidence for | Evidence against | Confidence |
| --- | ---------- | ------------ | ---------------- | ---------- |

### Gaps and uncertainties

- [What you could not determine, and why]
```

## Constraints

**MUST:** focus on evidence rather than solution design; cite `file:line` for every
finding; state confidence per hypothesis; record what you could not determine.

**MUST NOT:** propose fixes or code changes; modify any file; assume without evidence;
state a hypothesis as fact.

## Common mistakes

- Slipping into fix-design — that is the fixer's job; stay in evidence-gathering.
- Findings without `file:line`.
- Reporting a hypothesis as a conclusion. Mark confidence and contradicting evidence
  honestly.
- Trusting the measuring instrument. If a number moves between runs, confirm _what_ is
  varying before concluding the system is at fault.
