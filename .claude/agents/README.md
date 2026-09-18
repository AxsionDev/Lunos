# Agents Reference

## Orchestration (Core)

| Agent                  | Purpose                                         | When Used                        |
| ---------------------- | ----------------------------------------------- | -------------------------------- |
| `state-manager`        | Session tracking, context compaction, handoffs  | Automatically by state commands  |
| `project-orchestrator` | Break down projects, coordinate multiple agents | Complex multi-part tasks         |
| `team-lead`            | Define contracts, review work, final sign-off   | Feature implementation oversight |

## Development

| Agent                   | Purpose                                      | When Used                         |
| ----------------------- | -------------------------------------------- | --------------------------------- |
| `backend-developer`     | Backend services, controllers, APIs          | Backend implementation tasks      |
| `frontend-developer`    | Frontend components, services, templates     | Frontend implementation tasks     |
| `database-developer`    | Database, ORM, migrations                    | Database schema and queries       |
| `integration-developer` | Connect layers, DI wiring, help blocked devs | After parallel dev work completes |

## Bug Investigation

| Agent                    | Purpose                                          | When Used                         |
| ------------------------ | ------------------------------------------------ | --------------------------------- |
| `agent-clarifier`        | Transform vague bugs into structured JSON        | First step in `/bug-fix` workflow |
| `bug-investigator-alpha` | Primary investigation, form hypotheses           | Main bug analysis                 |
| `bug-investigator-beta`  | Peer review, challenge assumptions               | Validate alpha's findings         |
| `research-orchestrator`  | Dispatch parallel backend/frontend investigation | Complex cross-layer bugs          |

## Documentation

| Agent                  | Purpose                           | When Used                           |
| ---------------------- | --------------------------------- | ----------------------------------- |
| `user-journey-analyst` | Extract user journeys from docs   | Phase 2 of `/feature-lifecycle`     |
| `ai-docs-generator`    | Create AI-optimized documentation | Phase 1 & 5 of `/feature-lifecycle` |

## Shared Skills (logic lives here, not duplicated in agents)

Agents are thin **routers**; reusable procedures live in `.claude/skills/` and load on demand via the `Skill` tool. See the project `CLAUDE.md` → "Skill-Based Architecture".

| Skill                                                                            | Used by                               | Purpose                                                                 |
| -------------------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------- |
| `agent-bootstrap`                                                                | all team agents                       | State init, project detect, tech-stack patterns, docs lookup, workspace |
| `agent-output-contract`                                                          | agents writing workspace artifacts    | Standard machine-parseable artifact format                              |
| `code-review-methodology` (+refs architecture/security/performance/code-quality) | the 4 reviewers                       | Shared review engine + per-dimension checklists                         |
| `contract-driven-implementation`                                                 | the 4 developers                      | Contract-first implementation workflow                                  |
| `research-mode`                                                                  | developers/designers in investigation | Read-only evidence-gathering protocol                                   |
| `bug-investigation` (+refs bug-triage/collaborative-dialogue)                    | investigators + bug-reviewers         | Hypothesis discipline, triage, Alpha/Beta dialogue                      |

The `_gemini-design-hook.md` fragment remains (UI tool hierarchy for frontend/design agents). The legacy `_state-hook`/`_project-init-hook`/`_docs-lookup-hook` fragments are superseded by `agent-bootstrap`, retained only for the not-yet-migrated `state-manager`.

## Quick Decision Guide

```
Planning a feature?        → project-orchestrator → team-lead
Implementing backend?      → backend-developer
Implementing frontend?     → frontend-developer
Database changes?          → database-developer
Connecting everything?     → integration-developer
Investigating a bug?       → agent-clarifier → alpha/beta investigators
Need documentation?        → ai-docs-generator
Analyzing user flows?      → user-journey-analyst
```

## Archived Agents

Located in `_archive/` - restore if needed:

| Agent                   | Purpose                           |
| ----------------------- | --------------------------------- |
| `fullstack-developer`   | Solo dev for small features       |
| `ui-ux-designer`        | UX specs before frontend work     |
| `bug-reviewer-backend`  | Backend bug classification        |
| `bug-reviewer-frontend` | Frontend bug classification       |
| `to-prompt-converter`   | Pipeline utility for bug workflow |
