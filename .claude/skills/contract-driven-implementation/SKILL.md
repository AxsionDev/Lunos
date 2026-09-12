---
name: contract-driven-implementation
description: Use when a developer agent (backend, frontend, database, integration) implements against contracts defined by the team lead — interfaces, DTOs, API endpoints, or schema — in a multi-developer feature workflow.
---

# Contract-Driven Implementation

## Overview

In multi-developer workflows, the team lead defines contracts (interface signatures, DTO shapes, endpoints, data models) before implementation. **Your job is to implement them exactly.** If you believe a contract is wrong, signal it in your output — but still implement as specified, so parallel developers aren't blocked by divergence.

## Workflow

1. **Read contracts** — the interfaces, DTOs, endpoints, or schema you must implement (from the workspace `contracts/` artifact or the prompt).
2. **Load patterns & docs** — `.claude/patterns/{layer}-patterns.md` for real project code examples; `CODE_STRUCTURE.md` / `API_ENDPOINTS.md` for conventions. If no pattern file exists, scan the codebase for similar implementations and follow those.
3. **Implement to spec** — create code that matches the contract signatures and shapes exactly.
4. **Validate** — add validation on inputs/DTOs and in logic.
5. **Verify build** — run the project's build/diagnostics (see `PROJECT_STARTUP.md`); use `mcp__ide__getDiagnostics` before reporting complete.
6. **Report** — document what was implemented and any issues (see Output).

## Quality Checklist

- [ ] All contract interfaces/shapes implemented exactly
- [ ] All specified endpoints/components exist
- [ ] Validation present on inputs
- [ ] Dependency injection / wiring correct
- [ ] No hardcoded values (use configuration)
- [ ] Build/diagnostics pass

## Signaling for help

When blocked by another developer's work, emit clearly so the orchestrator/team-lead can route it:

```markdown
## HELP NEEDED
**Blocked By**: [database-developer | frontend-developer | backend-developer | integration-developer]
**Issue**: [what you need]
**To Proceed**: [what the other developer must provide]
```

## Output Format

```markdown
## [Layer] Developer - Implementation Complete

### Contracts Implemented
| Contract | File | Status |

### Files Created/Modified
| File | Action | Description |

### Build Status
✅ / ❌ [details]

### Integration Notes
[How to connect this work — for the integration developer]

### Issues/Deviations
[Any contract deviations or problems; "None" if clean]
```

When writing to a shared workspace, wrap this per the `agent-output-contract` skill.

## Core Principles

KISS (simplest solution that meets the contract) · contract compliance (implement exactly) · clean, self-documenting code · async all the way for I/O · fail fast (validate early, meaningful errors).

## Common Mistakes

- "Improving" a contract instead of implementing it — signal the concern, implement as specified.
- Reporting complete without running build/diagnostics.
- Reinventing helpers that already exist — search the codebase first.
