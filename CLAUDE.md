# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a Claude Code configuration repository containing custom agents, commands, and workflows for multi-agent software development. It provides a framework for orchestrating complex feature development using specialized AI agents.

## Architecture Overview

```
.claude/
├── agents/           # Specialized AI agent definitions (thin routers)
├── skills/           # Reusable procedural logic, loaded on demand (source of truth)
├── commands/         # User-invocable slash commands
└── workflows/        # Workflow documentation and guides
```

### Agent System

The agent system follows a **team-based architecture** with specialized roles:

| Role | Agent | Purpose |
|------|-------|---------|
| Orchestration | `project-orchestrator` | Breaks down complex projects, coordinates agents |
| Leadership | `team-lead` | Defines contracts, reviews work, final sign-off |
| Development | `backend-developer`, `frontend-developer`, `database-developer` | Layer-specific implementation |
| Integration | `integration-developer` | Connects all layers, helps blocked developers |
| Review | `security-reviewer`, `performance-reviewer`, `architecture-reviewer`, `code-review-signoff` | Specialized code review |
| Analysis | `bug-investigator-alpha`, `bug-investigator-beta` | Collaborative debugging |
| Documentation | `ai-docs-generator`, `user-journey-analyst` | AI-friendly documentation |
| State | `state-manager` | Session management, context compaction |

### Skill-Based Architecture

Following current Anthropic guidance, **agents are thin routers and reusable logic lives in skills** (`.claude/skills/`). An agent's body holds only its identity, responsibilities, decision-making, and a `## On invocation` section that calls the relevant skills via the `Skill` tool (each with a Read fallback to `.claude/skills/<name>/SKILL.md` for robustness when a newly-added skill isn't yet registered). Skills use progressive disclosure: a short `SKILL.md` plus `references/*.md` loaded only when needed.

Two loading mechanisms coexist, deliberately: `skills:` frontmatter (a YAML list) **eagerly preloads** a skill's full content at subagent startup — used only for `agent-bootstrap`, which every team agent runs unconditionally as step 1, so there's no discovery cost to save by deferring it. The runtime `Skill` tool call stays the mechanism for every conditionally-invoked skill (`contract-driven-implementation`, `research-mode`, `code-review-methodology`, etc.) — those should stay lazy since not every invocation needs them. Don't add more skills to `skills:` frontmatter by default; it's a latency/cache trade-off that only pays off for something every invocation runs.

| Skill | Used by | Purpose |
|-------|---------|---------|
| `agent-bootstrap` | all team agents | State init, project detection, tech-stack patterns, docs lookup, workspace protocol. **Preloaded via `skills:` frontmatter** (not called at runtime via the `Skill` tool) — every agent that always runs it lists `skills: [agent-bootstrap]`, so it's injected in full at subagent startup instead of costing a tool round-trip. |
| `agent-output-contract` | agents writing workspace artifacts | Standard machine-parseable artifact format |
| `code-review-methodology` | the 4 reviewers | Shared review engine + `references/{architecture,security,performance,code-quality}.md` |
| `contract-driven-implementation` | the 4 developers | Contract-first implementation workflow |
| `research-mode` | developers/designers in investigation | Read-only evidence-gathering protocol |
| `bug-investigation` | investigators + bug-reviewers | Hypothesis discipline + `references/{bug-triage,collaborative-dialogue}.md` |
| `worktree-preflight` | action-taking commands (bug-fix, feature, etc.) | First-step reset into a clean git worktree from a chosen base branch; reuse-guarded for nested commands; no-ops outside a git repo |

**When adding/editing agents:** put role-specific judgment in the agent; if logic would be reused by another agent verbatim, put it in a skill instead. The `_gemini-design-hook.md` fragment is the one remaining shared fragment (UI tool hierarchy); the legacy `_state-hook`/`_project-init-hook`/`_docs-lookup-hook` fragments are superseded by `agent-bootstrap`.

### Command System

Primary workflows:

- `/feature-lifecycle` - Full 5-phase development cycle (Discovery → User Journeys → Stories → Implementation → Doc Refresh)
- `/feature` - Multi-developer parallel implementation with reviews
- `/bug-fix` - Structured bug investigation and fix workflow
- `/discover` - Generate AI-agent-friendly documentation for a feature area

State management commands:
- `/state-init` - Initialize `.agent-state/` directory
- `/session-start` - Start a new tracked session
- `/session-status` - Show current session progress
- `/compact` - Compress conversation context
- `/handoff` - Generate handoff document for agent transitions
- `/state-resume` - Resume a previous session

### Feature Lifecycle Flow

```
Phase 1: Discovery → .claude/docs/{feature}.md
Phase 2: User Journeys → .claude/docs/{feature}-user-journeys.md
Phase 3: Stories → .claude/stories/{feature}.md
Phase 4: Implementation → Code changes via multi-dev team
Phase 5: Doc Refresh → Update docs for future AI agents
```

## Key Patterns

### Auto-Initialize State Tracking

All major agents auto-initialize state management at start:
1. Check `.agent-state/` exists
2. Create session if none active
3. Load existing context if resuming

### Documentation-First Workflow

Agents are configured to read existing documentation before any work:
- `.claude/docs/` - Discovery and feature documentation
- `.augment/` - Project reference documentation (CODE_STRUCTURE.md, API_ENDPOINTS.md, etc.)

### Contract-Driven Development

The team-lead agent defines contracts before implementation:
1. API contracts (endpoints, DTOs)
2. Interface contracts (service interfaces)
3. Data models (entities, relationships)
4. Validation rules

Developers implement against contracts; team-lead reviews compliance.

### Parallel Execution

Implementation uses parallel agent execution where possible:
- Backend, Frontend, and Database developers work simultaneously (each with `isolation: "worktree"`)
- All four code reviewers run in parallel
- Integration developer merges worktree branches first, then connects everything

### Skill Protocol

Agents use `## Skill Protocol` sections to invoke skills at specific trigger points via the `Skill` tool. The `Skill` tool is available in both direct invocations and subagent contexts. If a skill invocation fails silently in a subagent, follow the skill's documented workflow manually.

### Sequential Thinking

Agents include a `## Sequential Thinking Requirement` section recommending `mcp__MCP_DOCKER__sequentialthinking` for structured pre-task reasoning. This is **recommended, not mandatory** — if the MCP Docker server is unavailable, agents fall back to extended thinking blocks. Do not block task execution waiting for this tool.

### Worktree Environment Files

When deploying agents on a target project that uses worktree isolation (`isolation: "worktree"`), create a `.worktreeinclude` file in the target project root listing gitignored files that should be copied into each worktree:

```
# .worktreeinclude — files to copy into isolated worktrees
.env
.env.local
appsettings.Development.json
```

This ensures parallel developer agents have access to local config/credentials even when those files are gitignored.

## Advisor Model

This fleet is designed to run with an **Opus advisor** ([docs](https://code.claude.com/docs/en/advisor)). The advisor is a stronger model that the main model consults at key decision points — before committing to an approach, when stuck on recurring errors, and before declaring a task complete — without being invoked every turn.

**Configuration is session-level, not repo-level.** The advisor cannot be set in this repo's `.claude/settings.json` or in agent frontmatter; it lives in user settings (`~/.claude/settings.json` → `"advisorModel": "opus"`, already set) or is enabled per session via `/advisor opus` or `claude --advisor opus`. Requires Claude Code ≥ v2.1.98. As of **v2.1.260**, `/advisor` (`/advisor <model>`, `/advisor off`) also works in headless `-p` / SDK / Remote Control sessions, not just interactive ones — useful for CI or scripted agent runs that still want advisor oversight. Fable is selectable as an advisor again as of the same release.

**All subagents auto-inherit it.** Every agent spawned by these workflows (orchestrator, developers, reviewers, investigators) inherits the session advisor automatically — there is no per-agent advisor field. Each agent's own `model:` is pairing-checked against the advisor: the advisor must be at least as capable as the agent's model, or it detaches for that agent only. As of **v2.1.265**, this pairing decision is made **once per conversation** (and announced in the conversation when it changes) rather than re-decided per request — the same session no longer flips advisor status mid-conversation as different models handle different turns.

- **Opus advisor** pairs validly with the entire fleet (opus/sonnet/haiku agents all ≤ opus).
- For the opus-tier reasoning agents (orchestrator, team-lead, investigators, ideator/critic) the advisor is a **second-opinion quality boost**, not a cost saver — they already run on opus.
- To capture advisor *economics* (cheaper main + opus judgment at decision points), demote those reasoning singletons to `sonnet`; not done here, kept on opus by choice.
- **Fable 5.1 ≥ Opus 4.8**, so the Opus advisor detaches for `/fullstack-fable` (pinned to `claude-fable-5-1`) — that command is the strongest model in its own loop and is documented to own judgment without a second opinion.
- Disable for a session with `/advisor off`.

## Technology Stack (Target Projects)

The agents are configured for:
- **Backend**: .NET/C#, Entity Framework Core
- **Database**: SQL Server
- **Frontend**: Angular 18+, TypeScript, RxJS
- **UI**: ngx-bootstrap modals/components

## Core Principles (Enforced by Agents)

1. **KISS**: Simplest solution that meets requirements
2. **Code Reuse**: Search existing code before writing new
3. **Minimal Changes**: Surgical, focused modifications
4. **Contract Compliance**: Follow defined interfaces exactly

## State Directory Structure

```
.agent-state/
├── config.yaml              # System configuration
├── active-session.yaml      # Current session pointer
├── sessions/{session-id}/
│   ├── session.yaml         # Session metadata
│   ├── tasks.yaml           # Task registry
│   ├── decisions.yaml       # Decision log
│   ├── context.yaml         # Compacted context
│   └── handoff.md           # Agent handoff summary
├── global/
│   ├── patterns.yaml        # Discovered code patterns
│   └── conventions.yaml     # Project conventions
└── indexes/
    └── task-index.yaml      # Cross-session task lookup
```
