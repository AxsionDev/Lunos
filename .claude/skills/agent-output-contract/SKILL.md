---
name: agent-output-contract
description: Use when a team agent produces a workspace artifact or hands off results to another agent or orchestrator, and the output must be machine-parseable and consistent across the agent fleet.
---

# Agent Output Contract

## Overview

The standard format for any artifact an agent writes to `.agent-workspace/{run}/outputs/` or hands off downstream. YAML frontmatter makes outputs machine-parseable; the markdown body keeps them human-readable. Use "N/A" for sections that don't apply rather than omitting them.

## Frontmatter (required)

```yaml
---
agent: { agent-name }
workflow: { feature|bug-fix|quick-bugfix }
step: { step-number }
status: { completed|partial|blocked }
timestamp: { ISO-8601 }
files_changed: [list of file paths]
depends_on: [artifact names this agent consumed]
produces: [artifact names this output represents]
confidence: { high|medium|low }
---
```

## Body sections (required, in order)

```markdown
## Summary

[1–2 sentences on what was accomplished]

## Changes Made

| File      | Change Type              | Description       |
| --------- | ------------------------ | ----------------- |
| path/file | created/modified/deleted | Brief description |

## Key Decisions

- [Decision and rationale]

## Issues & Concerns

- [Issue: description + severity] (or "None")

## Handoff Notes

[What downstream agents need to continue]
```

## Role-specific sections (optional, after the required ones)

| Role          | Add                                                                      |
| ------------- | ------------------------------------------------------------------------ |
| Developers    | `## Build Status`, `## Contract Compliance`                              |
| Reviewers     | `## Findings`, `## Verdict` (APPROVED / CHANGES REQUESTED / NEEDS FIXES) |
| Investigators | `## Root Cause Hypothesis`, `## Evidence`                                |
| Team Lead     | `## Contract Specification`, `## Task Assignments`                       |

## Common Mistakes

- Omitting a required section instead of writing "N/A".
- Free-form prose with no frontmatter — breaks downstream tooling and orchestrator parsing.
- Putting role-specific sections before the required ones.
