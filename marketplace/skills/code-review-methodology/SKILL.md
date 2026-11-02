---
name: code-review-methodology
description: Use when reviewing implemented code as part of the review team (architecture, security, performance, or code-quality dimension), after implementation is complete and before sign-off.
---

# Code Review Methodology

## Overview

Shared engine for the review team. Each reviewer owns ONE dimension and stays in its lane; this skill provides the severity scale, false-positive discipline, output structure, and handoff format common to all dimensions. Load your dimension's reference file for the actual checklists and detection heuristics.

## Dimension references

Read the reference for your dimension (progressive disclosure — load only yours):

| Dimension    | Reference                    | Owner agent           |
| ------------ | ---------------------------- | --------------------- |
| Architecture | `references/architecture.md` | architecture-reviewer |
| Security     | `references/security.md`     | security-reviewer     |
| Performance  | `references/performance.md`  | performance-reviewer  |
| Code quality | `references/code-quality.md` | code-review-signoff   |

## Stay in your lane

Review ONLY your dimension. Defer everything else to the owning reviewer (table above). Overlapping findings dilute signal and duplicate effort.

## Severity scale (all dimensions)

| Level       | Meaning                                 |
| ----------- | --------------------------------------- |
| 🔴 Critical | Fundamental flaw; must fix before merge |
| 🟠 High     | Significant maintainability/risk impact |
| 🟡 Medium   | Notable smell worth addressing          |
| 🟢 Low      | Minor improvement opportunity           |

## Structured reasoning (recommended)

Before reviewing, if `mcp__MCP_DOCKER__sequentialthinking` is available, use it to map the relevant structure and trace dependencies/data flow for your dimension. Fallback: reason through the same steps in an extended thinking block. Do not block on the tool.

## False-positive discipline

Every dimension reference carries an "accept these / challenge these" table. Apply it: a finding you can't tie to a concrete location and concrete impact is noise. When a project-accepted pattern looks like a violation, record it in agent memory rather than re-flagging it each review.

## Output

Produce a report with: a summary count by severity, findings grouped by severity (each with **location** `file:line`, **description**, **impact**, **fix**), good patterns observed, and a **Verdict** (`APPROVED` | `NEEDS FIXES`). The dimension reference gives the exact section layout.

## Handoff to the fixing developer

For each issue requiring a fix:

```markdown
### Issue: [name]

**Severity**: [level] **Location**: `path/file:line`
**Current State**: [the violation]
**Required Change**: [specific change]
**Acceptance Criteria**: [ ] measurable criterion
**Files Likely Affected**: [list]
```

## Common Mistakes

- Reviewing outside your dimension.
- Findings without `file:line` and concrete impact.
- Re-flagging project-accepted patterns (use the false-positive table + agent memory).
- Emitting a report with no explicit verdict.
