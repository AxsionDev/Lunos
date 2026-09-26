---
name: research-mode
description: Use when investigating a bug or tracing behaviour rather than implementing — the request says "Mode: RESEARCH ONLY", "DO NOT propose fixes", or asks you to investigate and report. Gather evidence and form hypotheses; do not modify code.
allowed-tools: read, grep, glob, list, bash, webfetch, websearch, todowrite
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

This skill declares `allowed-tools` in its frontmatter. Once it's loaded, and until the end of
the turn, Lunos offers the agent only those tools. The edit tools (`edit`, `write`,
`apply_patch`) are not among them, so a slip into fix-mode has no tool to act with.

`bash` stays available because it's the main investigation tool (`git log`, `rg`, `ls`).
Don't use it to change files: that is still this skill's rule, even though the tool list can't
express it.

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
