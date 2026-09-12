# Code Quality Review Reference

The code-quality dimension of `code-review-methodology` — the final quality gate. Focus EXCLUSIVELY on: readability/clarity, naming, DRY, complexity, documentation, testability, error-handling clarity. Defer security, performance, and architecture to their reviewers.

Load project conventions from `.claude/patterns/review-patterns.md` (naming/case style, code organization, known antipatterns). If absent, scan the codebase for the conventions in use before flagging style.

## Checklist

### 1. Readability & Clarity
Self-documenting code; reasonable method/function length; clear control flow (limited nesting); meaningful variable names; consistent formatting.

### 2. Naming
Follows project casing/conventions; descriptive, intent-revealing names; consistent across codebase.

### 3. DRY
Duplicated blocks; copy-paste with minor edits; similar logic extractable to a helper; repeated magic numbers/strings.

### 4. Complexity
Deep nesting (>3 levels); long methods (>30 lines); complex boolean expressions; too many parameters (>4); conditionals that could be simplified.

### 5. Documentation & Comments
Public APIs documented (project convention); comments explain WHY not WHAT; no commented-out code; no leftover TODOs in production; clear messages.

### 6. Testability
Injectable dependencies (not hardcoded); methods do one thing; no hidden side effects; clear public interface; avoid static methods with side effects.

### 7. Error-Handling Clarity
Helpful error messages for debugging; exceptions caught at the appropriate level; appropriate logging; user-facing vs developer-facing messages distinguished.

## Severity (code-quality-specific — three levels)

| Level | Meaning | Examples |
|-------|---------|----------|
| 🔴 Critical | Severely impacts maintainability | Major DRY violation, unreadable code |
| 🟡 Suggested | Should improve | Naming issues, minor duplication |
| 🟢 Nitpick | Optional polish | Style preferences, micro-improvements |

## Output Layout

```markdown
## Code Quality Review Report

### Summary
- Files Reviewed / Critical / Suggested / Nitpicks: [counts]

### Critical 🔴
#### Issue: [title]
**Location**: `file:line` (and any duplicate locations)
**Description**: [the problem]   **Impact**: [why it matters]   **Fix**: [change]

### Suggested Improvements 🟡
#### Issue: [e.g. poor naming]
**Location**: `file:line`   **Current**: `doAction()`   **Better**: `processUserRegistration()`

### Nitpicks 🟢
### Positive Observations ✅
### Verdict: ✅ APPROVED / 🔄 CHANGES REQUESTED
### Required Actions (if changes requested)
```

## Core Principles

Clarity over cleverness · consistency with established patterns · single responsibility · meaningful names · DRY · simple first.

## Success Criteria

Complete when: changed code checked against all 7 categories; naming/DRY/complexity assessed against project conventions; each finding has location + fix; explicit verdict.
