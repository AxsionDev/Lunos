# Commands Reference

## State Management (Mandatory)

| Command           | Purpose                              | When to Use                               |
| ----------------- | ------------------------------------ | ----------------------------------------- |
| `/state-init`     | Initialize `.agent-state/` directory | First time setup, or after deleting state |
| `/session-start`  | Start a new tracked session          | Beginning of any work session             |
| `/session-status` | Show current session progress        | Check what's done, what's pending         |
| `/state-resume`   | Resume a previous session            | Returning to incomplete work              |
| `/compact`        | Compress conversation context        | When context is getting long              |
| `/handoff`        | Generate handoff document            | Before switching agents or ending session |

## Workflows (Recommended)

| Command              | Purpose                                                                                                                              | When to Use                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `/feature-lifecycle` | Full 5-phase feature development                                                                                                     | New features requiring discovery, stories, implementation                   |
| `/bug-fix`           | Structured bug investigation and fix                                                                                                 | Any bug that needs proper analysis                                          |
| `/jira-bug-fix`      | Jira-integrated bug fix                                                                                                              | Bugs tracked in Jira tickets                                                |
| `/jira-feature`      | Jira-integrated feature lifecycle                                                                                                    | Features tracked in Jira tickets                                            |
| `/batch-bugfix`      | Batch bug fixing from markdown file                                                                                                  | Multiple bugs to fix systematically                                         |
| `/product-question`  | Answer a product/customer question needing code knowledge; files a Jira Bug or Story on the active board if the question reveals one | Product/customer asks something that needs codebase investigation to answer |

### Feature Lifecycle Phases

1. **Discovery** → `.claude/docs/{feature}.md`
2. **User Journeys** → `.claude/docs/{feature}-user-journeys.md`
3. **Stories** → `.claude/stories/{feature}.md`
4. **Implementation** → Code changes via multi-dev team
5. **Doc Refresh** → Update docs for future AI agents

## Utilities (Optional)

| Command              | Purpose                                                        | When to Use                                                      |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/quick-bugfix`      | Fast fix for known small bugs                                  | Simple, well-understood bugs                                     |
| `/Lyra`              | Prompt optimization                                            | Improving AI prompts                                             |
| `/CangeClaude`       | Update CLAUDE.md automatically                                 | After significant codebase changes                               |
| `/memory-audit`      | Review `remember`/`claude-mem` usage, size, freshness          | Checking for dead/duplicate memory systems                       |
| `/mcp-memory-health` | Check Docker MCP Toolkit's `mcp/memory` knowledge-graph server | Verifying the 2026-09-10 removal stuck, no lingering schema cost |

## Quick Decision Guide

```
Need to track work?        → /state-init + /session-start
New feature?               → /feature-lifecycle
Bug to fix?                → /bug-fix (complex) or /quick-bugfix (simple)
Jira bug ticket?           → /jira-bug-fix {ticket-url}
Jira feature ticket?       → /jira-feature {ticket-url}
Multiple bugs to fix?      → /batch-bugfix bugs.md
Product/customer question needing code knowledge? → /product-question "{question}"
Context getting long?      → /compact
Switching tasks/agents?    → /handoff
Resuming previous work?    → /state-resume
```
