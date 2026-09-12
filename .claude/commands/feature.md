# Feature Development Workflow (Multi-Developer Team)

Orchestrate a complete feature development cycle with multiple developers working in parallel for: $ARGUMENTS

## Team Structure

| Role | Agent | Responsibility |
|------|-------|----------------|
| **Orchestrator** | `project-orchestrator` | Break down requirements |
| **UI/UX Designer** | `ui-ux-designer` | User experience, layouts, interactions |
| **Team Lead** | `team-lead` | Contracts, oversight, sign-off |
| **Backend Developer** | `backend-developer` | .NET/C# services, APIs |
| **Frontend Developer** | `frontend-developer` | Angular components, UI |
| **Database Developer** | `database-developer` | SQL/EF Core, migrations |
| **Integration Developer** | `integration-developer` | Connect all layers |
| **Security Reviewer** | `security-reviewer` | Vulnerabilities |
| **Performance Reviewer** | `performance-reviewer` | N+1, async, caching |
| **Architecture Reviewer** | `architecture-reviewer` | SOLID, patterns |
| **Code Quality Reviewer** | `code-review-signoff` | Readability, DRY |
| **Documentation** | `ai-docs-generator` | AI-friendly docs |

---

## Pre-flight: Worktree Reset (FIRST — before any action)

Before anything else, invoke **`Skill(worktree-preflight)`** to reset into a clean task worktree. *(Fallback: read `.claude/skills/worktree-preflight/SKILL.md` and follow it.)* If the user passed an override base branch in `$ARGUMENTS` (e.g. a `--base=<branch>` token), pass it through; otherwise the repo default branch is used. If the project is not a git repository, the skill no-ops and this command proceeds normally. This is **task-level** — the per-developer `isolation: "worktree"` agents in Steps 5.1–5.3 still spawn their own worktrees on top of this clean base.

---

## Step 0: Initialize Workspace

Create a shared workspace for this feature run so agents can exchange structured artifacts:

```bash
# Generate timestamp-based workspace directory
mkdir -p .agent-workspace/feature-$(date +%Y%m%d-%H%M%S)/contracts
mkdir -p .agent-workspace/feature-$(date +%Y%m%d-%H%M%S)/outputs
mkdir -p .agent-workspace/feature-$(date +%Y%m%d-%H%M%S)/reviews
```

Note the workspace path and pass it to the integration developer (Step 5.4) and reviewers (Steps 6–8).

> **Worktree Note:** The parallel developers (Steps 5.1–5.3) run with `isolation: "worktree"` — each is in a separate git branch and **cannot write to this shared workspace**. Their work lives in their worktree branches, which the integration developer merges in Step 5.4. The workspace directory is for the integration developer and reviewers who run in the main branch context.

---

## Step 1: Planning (project-orchestrator)

> **Parallelism Note:** If the feature description in `$ARGUMENTS` is detailed enough for UI/UX work to begin independently (clear user-facing requirements, not purely backend), launch Steps 1 and 2 in parallel using multiple Task tool calls in a single message. The planner focuses on technical decomposition while the designer focuses on user experience — these are independent concerns.

Use the Task tool with `subagent_type="project-orchestrator"` to:
- **First**: Read `QUICK_REFERENCE.md` (search in `.claude/docs/`, `.augment/`, `docs/`) and `CODE_STRUCTURE.md` (search in `.claude/docs/`, `.claude/patterns/`, `.augment/`, `docs/`)
- Analyze the feature request: "$ARGUMENTS"
- Break it down into specific, actionable tasks
- Identify which tasks can run in parallel vs sequential
- Identify files/components that need changes
- Create a prioritized implementation plan

After completion, ask: **"Step 1 (Planning) complete. Ready to proceed to Step 2 (UI/UX Design)? (yes/no/adjust)"**

Wait for user approval before continuing.

---

## Step 2: UI/UX Design (ui-ux-designer)

Use the Task tool with `subagent_type="ui-ux-designer"` with this prompt:

```
## UI/UX Design Request

### Feature to Design
$ARGUMENTS

### Task Breakdown from Planning
[Include the task breakdown from Step 1]

### Your Task
Create a comprehensive UI/UX Design Specification:

1. **User Flow**: How users navigate through this feature
2. **Screen Layouts**: Wireframe descriptions for each page/view
3. **Component Specifications**: UI components needed with all states
4. **Interaction Patterns**: How elements respond to user actions
5. **Form Specifications**: Fields, validation, error messages
6. **Responsive Behavior**: How layouts adapt to different screen sizes
7. **Accessibility Requirements**: Keyboard nav, screen readers, contrast
8. **Empty/Error States**: What users see in edge cases

Produce a complete UI/UX Design Specification that the Frontend Developer will implement.

Write the complete specification to `.claude/docs/{feature-slug}-ux-design.md` (where `{feature-slug}` is a lowercase-hyphenated version of the feature name from `$ARGUMENTS`). All subsequent steps will read it from that file.
```

After completion, ask: **"Step 2 (UI/UX Design) complete. Ready to proceed to Step 3 (Contract Definition)? (yes/no/adjust)"**

Wait for user approval before continuing.

---

## Step 3: Contract Definition (team-lead)

Use the Task tool with `subagent_type="team-lead"` with this prompt:

```
## Contract Definition Request

### Feature to Implement
$ARGUMENTS

### Task Breakdown from Planning
[Include the task breakdown from Step 1]

### UI/UX Design Specification
[Include the complete UI/UX design from Step 2]

### Your Task
Define all contracts before implementation begins. Use the UI/UX design to inform API requirements:

1. **API Contracts**: Endpoints, methods, request/response DTOs (must support all UI interactions)
2. **Interface Contracts**: Service interfaces with method signatures
3. **Data Models**: Entities and their relationships (must support all displayed data)
4. **Integration Points**: How components will connect
5. **Validation Rules**: Input validation requirements (match UI form specifications)

Ensure contracts support all user flows and component data requirements from the UI/UX design.

Produce a complete Contracts Specification that all developers will follow.

Write the complete specification to `.claude/docs/{feature-slug}-contracts.md` (same slug as the UX design file). All subsequent steps will read contracts from that file — do not repeat the full contracts in each agent prompt.
```

After completion, ask: **"Step 3 (Contract Definition) complete. Ready to proceed to Step 4 (Task Distribution)? (yes/no/adjust)"**

Wait for user approval before continuing.

---

## Step 4: Task Distribution (team-lead)

Use the Task tool with `subagent_type="team-lead"` with this prompt:

```
## Task Distribution Request

### Contracts Defined
[Include contracts from Step 3]

### UI/UX Design Specification
[Include UI/UX design from Step 2]

### Your Task
Assign specific tasks to each developer:

1. **Identify Parallel Work**: Which tasks can run simultaneously?
2. **Identify Sequential Work**: Which tasks depend on others?
3. **Assign to Developers**:
   - Backend Developer: [specific tasks]
   - Frontend Developer: [specific tasks + UI/UX design reference]
   - Database Developer: [specific tasks]
4. **Set Acceptance Criteria**: Clear definition of done for each

Ensure the Frontend Developer receives the full UI/UX design specification.

Produce a Task Distribution document with clear assignments.
```

After completion, ask: **"Step 4 (Task Distribution) complete. Ready to proceed to Step 5 (Parallel Implementation)? (yes/no/adjust)"**

Wait for user approval before continuing.

---

## Step 5: Parallel Implementation

Execute developer tasks based on the distribution. Launch **parallel tasks where possible** (use multiple Task tool calls in a single message).

> **Worktree Isolation:** Each parallel developer runs with `isolation: "worktree"` so they each get an isolated git branch and cannot overwrite each other's in-progress changes. The Integration Developer (Step 5.4) merges the worktrees together. Also assign a `name:` to each developer so the Step 6 fix loop can use SendMessage instead of spawning fresh agents.

### 5.1: Database Developer

Use the Task tool with `subagent_type="database-developer"`, `name="db-dev"`, `isolation="worktree"`:

```
## Database Developer Assignment

### Contracts Reference
Read `.claude/docs/{feature-slug}-contracts.md` for entity and data model contracts.

### Your Tasks
[Include database tasks from Step 3]

### Deliverables
- Entity classes
- EF Core configuration
- Migrations
- Indexes for performance

Follow the contracts exactly. Run the build command (see PROJECT_STARTUP.md) to verify.
```

### 5.2: Backend Developer

Use the Task tool with `subagent_type="backend-developer"`, `name="backend-dev"`, `isolation="worktree"`:

```
## Backend Developer Assignment

### Contracts Reference
Read `.claude/docs/{feature-slug}-contracts.md` for API and interface contracts.

### Your Tasks
[Include backend tasks from Step 4]

### Deliverables
- Controllers with endpoints
- Services implementing interfaces
- DTOs matching contracts
- Validation logic

Follow the contracts exactly. Run the build command (see PROJECT_STARTUP.md) to verify.
```

### 5.3: Frontend Developer

Use the Task tool with `subagent_type="frontend-developer"`, `name="frontend-dev"`, `isolation="worktree"`:

```
## Frontend Developer Assignment

### UI/UX Design Specification
Read `.claude/docs/{feature-slug}-ux-design.md` for the complete UI/UX specification.

### Contracts Reference
Read `.claude/docs/{feature-slug}-contracts.md` for API contracts and response DTOs.

### Your Tasks
[Include frontend tasks from Step 4]

### Deliverables
- TypeScript interfaces mirroring DTOs
- Angular services for HTTP calls
- Components matching UI/UX design specifications
- Forms with validation matching design specs
- All component states (loading, error, empty, success)
- Responsive behavior as specified
- Accessibility requirements implemented

IMPORTANT: Implement the UI exactly as specified in the UI/UX design.
Follow the contracts exactly. Verify TypeScript compiles.

NOTE: For HTML/SCSS work and browser verification, follow the Gemini → ChromeDevTools → Playwright
three-tier tool hierarchy defined in `.claude/agents/_gemini-design-hook.md`.
```

### 5.4: Integration Developer (after parallel work)

After the three parallel developers complete, use the Task tool with `subagent_type="integration-developer"`:

```
## Integration Developer Assignment

### Step 1 — Merge Worktree Branches (REQUIRED FIRST)

The parallel developers ran with `isolation: "worktree"`. Their changes are on separate git branches. Merge them into your current branch before doing anything else:

```bash
git merge {db-dev-branch} --no-edit        # branch name from database developer task result
git merge {backend-dev-branch} --no-edit   # branch name from backend developer task result
git merge {frontend-dev-branch} --no-edit  # branch name from frontend developer task result
```

If a merge conflict occurs, use `.claude/docs/{feature-slug}-contracts.md` as the source of truth for interface decisions.

### Contracts Reference
Read `.claude/docs/{feature-slug}-contracts.md` for all contracts.

### UI/UX Design Reference
Read `.claude/docs/{feature-slug}-ux-design.md` for integration points (API calls, data shapes).

### Work Completed By Other Developers
[Summarize outputs from Backend, Frontend, Database developers]

### Your Tasks
1. Verify contracts are aligned across all layers
2. Wire up dependency injection in Program.cs
3. Configure AutoMapper if needed
4. Ensure end-to-end flow works
5. Verify UI components can fetch and display data correctly
6. Fix any integration mismatches

### Deliverables
- DI configuration
- Mapping profiles
- Verified end-to-end flow
```

After ALL developers complete, ask: **"Step 5 (Implementation) complete. Ready to proceed to Step 6 (Team Lead Review)? (yes/no/adjust)"**

Wait for user approval before continuing.

---

## Step 6: Team Lead Review

Use the Task tool with `subagent_type="team-lead"` with this prompt:

```
## Team Lead Review Request

### Original Contracts
[Include contracts from Step 3]

### UI/UX Design Specification
[Include UI/UX design from Step 2]

### Developer Outputs
[Include summaries from all four developers]

### Your Task
Review each developer's work:

1. **Contract Compliance**: Does each implementation match the contracts?
2. **UI/UX Compliance**: Does the frontend match the design specification?
3. **Build Status**: Does the build succeed? (see PROJECT_STARTUP.md)
4. **Integration**: Can all pieces work together?

For each developer, provide:
- ✅ APPROVED - ready for code review
- 🔄 NEEDS FIXES - list specific issues

If any developer needs fixes, specify exactly what needs to change.
```

### If Fixes Needed

Use **SendMessage** to re-engage the relevant developer(s) with specific feedback, preserving their context:

```
SendMessage(to: "backend-dev",  message: "Team lead review: NEEDS FIXES\n\n[specific issues]")
SendMessage(to: "frontend-dev", message: "Team lead review: NEEDS FIXES\n\n[specific issues]")
SendMessage(to: "db-dev",       message: "Team lead review: NEEDS FIXES\n\n[specific issues]")
```

Only SendMessage to the developer(s) that need fixes. If a developer's session has expired (agent no longer active), re-launch with the Task tool providing the original context + specific fix feedback. Continue until all developers are approved.

After all approved, ask: **"Step 6 (Team Lead Review) complete. All implementations approved. Ready to proceed to Step 7 (Comprehensive Code Review)? (yes/no/adjust)"**

Wait for user approval before continuing.

---

## Step 7: Comprehensive Code Review

Launch **all four reviewers in parallel** (use multiple Task tool calls in a single message):

### 7.1: Security Review

Use the Task tool with `subagent_type="security-reviewer"`:

```
## Security Review Request

### Feature Implemented
$ARGUMENTS

### Files Changed
[List all files created/modified in Step 5]

### Your Task
Review for security vulnerabilities:
- Injection attacks (SQL, XSS, command)
- Authentication/authorization flaws
- Sensitive data exposure
- Input validation gaps
- Security misconfigurations

Provide Security Review Report with verdict.
```

### 7.2: Performance Review

Use the Task tool with `subagent_type="performance-reviewer"`:

```
## Performance Review Request

### Feature Implemented
$ARGUMENTS

### Files Changed
[List all files created/modified in Step 5]

### Your Task
Review for performance issues:
- N+1 query problems
- Missing async/await
- Inefficient LINQ
- Caching opportunities
- Resource leaks

Provide Performance Review Report with verdict.
```

### 7.3: Architecture Review

Use the Task tool with `subagent_type="architecture-reviewer"`:

```
## Architecture Review Request

### Feature Implemented
$ARGUMENTS

### Files Changed
[List all files created/modified in Step 5]

### Your Task
Review for architectural concerns:
- SOLID principles adherence
- Layer boundary violations
- Abstraction quality
- Pattern consistency
- Coupling and cohesion

Provide Architecture Review Report with verdict.
```

### 7.4: Code Quality Review

Use the Task tool with `subagent_type="code-review-signoff"`:

```
## Code Quality Review Request

### Feature Implemented
$ARGUMENTS

### Files Changed
[List all files created/modified in Step 5]

### Your Task
Review for code quality:
- Readability and clarity
- Naming conventions
- DRY violations
- Complexity reduction
- Documentation quality
- Testability

Provide Code Quality Review Report with verdict.
```

After all reviews complete, ask: **"Step 7 (Comprehensive Code Review) complete. Ready to proceed to Step 8 (Team Lead Final Sign-off)? (yes/no/adjust)"**

Wait for user approval before continuing.

---

## Step 8: Team Lead Final Sign-off

Use the Task tool with `subagent_type="team-lead"` with this prompt:

```
## Consolidate Review Findings

### Review Reports
- Security Review: [include report]
- Performance Review: [include report]
- Architecture Review: [include report]
- Code Quality Review: [include report]

### UI/UX Design Compliance
[Note any UI/UX design deviations found during review]

### Your Task
1. Consolidate all findings into a single summary
2. Prioritize issues by severity (Critical > High > Medium > Low)
3. Verify UI/UX design was implemented correctly
4. Determine overall verdict:
   - ✅ APPROVED - Feature is ready
   - 🔄 NEEDS FIXES - List required changes

If fixes needed, specify which developer should address each issue.
```

### If Fixes Needed

Use **SendMessage** to route consolidated feedback to the relevant developer(s):

```
SendMessage(to: "backend-dev",  message: "Review fixes required:\n\n[consolidated issues for backend]")
SendMessage(to: "frontend-dev", message: "Review fixes required:\n\n[consolidated issues for frontend]")
```

After fixes are applied, re-run only the affected reviewers (not the full set). Get Team Lead final sign-off again.

After approval, ask: **"Step 8 (Team Lead Sign-off) complete. Feature approved! Ready to proceed to Step 9 (Documentation)? (yes/no/adjust)"**

Wait for user approval before continuing.

---

## Step 9: Documentation (ai-docs-generator)

Use the Task tool with `subagent_type="ai-docs-generator"` to:
- Document the new feature for AI agents
- Include UI/UX design decisions in documentation
- Update relevant project documentation files (in `.claude/docs/`, `.augment/`, `docs/`)
- Create any needed reference guides
- Follow the established documentation patterns

After completion, report: **"Step 9 (Documentation) complete. Feature development workflow finished!"**

---

## Completion Summary

Provide a final summary including:

```markdown
## Feature Development Complete

### Feature Implemented
$ARGUMENTS

### Design & Development Contributions
| Role | Contribution | Status |
|------|--------------|--------|
| UI/UX Designer | [design summary] | ✅ |
| Database Developer | [summary] | ✅ |
| Backend Developer | [summary] | ✅ |
| Frontend Developer | [summary] | ✅ |
| Integration Developer | [summary] | ✅ |

### Code Review Summary
| Reviewer | Issues Found | Status |
|----------|--------------|--------|
| Security | [count] | ✅ Approved |
| Performance | [count] | ✅ Approved |
| Architecture | [count] | ✅ Approved |
| Code Quality | [count] | ✅ Approved |

### UI/UX Design Compliance
✅ Frontend implementation matches design specification

### Files Created/Modified
[List all files]

### Documentation Updated
[List documentation files updated]

### Team Lead Final Verdict
✅ APPROVED - Feature is production-ready
```

---

## Agent Memory

At workflow start, each dispatched agent should consult its `.claude/agent-memory/{agent-name}/MEMORY.md` for prior learnings. At workflow end, agents should persist key insights discovered during this run.

---

## Error Handling

### If a Developer is Blocked

When a developer signals `HELP NEEDED`:
1. Check if another developer can help
2. Use the Integration Developer as default helper
3. Resume work after unblocking

### If Reviews Find Critical Issues

1. Team Lead consolidates the issues
2. Assign fixes to appropriate developer(s)
3. Re-run only the affected reviews
4. Get Team Lead final sign-off again

### If Build Fails

1. Identify which layer caused the failure
2. Send build errors to the appropriate developer
3. Verify fix with the build command (see PROJECT_STARTUP.md)
4. Resume workflow
