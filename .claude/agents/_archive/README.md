# \_archive

These are **previous versions** of agents that were superseded by updated versions in the main `.claude/agents/` directory. They are kept here for reference only — do not use them in workflows.

| Archived Agent                    | Superseded By                                              | Reason                                                                                             |
| --------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `bug-reviewer-backend.md`         | `agents/bug-reviewer-backend.md`                           | Pre-research-orchestrator version; did not support parallel dispatch pattern                       |
| `bug-reviewer-frontend.md`        | `agents/bug-reviewer-frontend.md`                          | Pre-research-orchestrator version; did not support parallel dispatch pattern                       |
| `fullstack-dotnet-angular-dev.md` | _Still active_ in `agents/fullstack-dotnet-angular-dev.md` | Kept as a .NET/Angular-specific variant; `agents/fullstack-developer.md` is the generic equivalent |
| `to-prompt-converter.md`          | _Still active_ in `agents/to-prompt-converter.md`          | Inline migration intended but not implemented; `bug-fix.md` Step 2 still dispatches the agent      |
| `ui-ux-designer.md`               | `agents/ui-ux-designer.md` (if present)                    | Previous version before Gemini Design MCP integration                                              |

> **Rule:** The main agents directory is always canonical. Only reference this archive to understand prior design decisions.
