# Feature Lifecycle Workflow

Orchestrate the complete feature development lifecycle from discovery to implementation for: **$ARGUMENTS**

## Overview

This is a **master orchestrator workflow** that chains together all phases of feature development:

```
Phase 1: Discovery → Phase 2: User Journeys → Phase 3: Stories → Phase 4: Implementation → Phase 5: Doc Refresh
```

Each phase builds on the previous, with user checkpoints between major transitions.

**Key Innovation:** Phase 5 creates a **documentation feedback loop** - what you learn during implementation flows back into documentation, so future AI agents have accurate context during their discovery phase.

---

## Pre-flight: Worktree Reset (FIRST — before any action)

Before anything else, invoke **`Skill(worktree-preflight)`** to reset into a clean task worktree. _(Fallback: read `.claude/skills/worktree-preflight/SKILL.md` and follow it.)_ If the user passed an override base branch in `$ARGUMENTS` (e.g. a `--base=<branch>` token), pass it through; otherwise the repo default branch is used. If the project is not a git repository, the skill no-ops and this command proceeds normally. (Phase 4 delegates to `/feature`, whose own preflight will detect this worktree and reuse it rather than reset again.)

---

## Pre-Phase: Initialize State Management

Before starting the feature lifecycle, establish persistent session tracking.

### State Directory Check

1. Check if `.agent-state/` directory exists
2. If not, run `/state-init` to create the state infrastructure

### Start Feature Lifecycle Session

1. Run `/session-start "Feature: $ARGUMENTS"`
2. Note the session ID for reference throughout the workflow

This session will persist across all 5 phases:

- Phase 1: Discovery
- Phase 2: User Journeys
- Phase 3: Story Preparation
- Phase 4: Implementation
- Phase 5: Documentation Refresh

### Resume Check

If user indicates resuming a previous session:

1. Run `/state-resume` to load previous context
2. Display phase completion status
3. Ask user which phase to continue from

### Session Persistence Note

This session will persist across **all 5 phases**. Context is preserved and compressed at each phase checkpoint, allowing:

- Resume from any phase if interrupted
- Reference decisions from earlier phases
- Generate complete handoff at workflow end

---

## Phase Map

| Phase             | Command             | Output                                    | Purpose                             |
| ----------------- | ------------------- | ----------------------------------------- | ----------------------------------- |
| 1. Discovery      | `/discover`         | `.claude/docs/{feature}.md`               | Explore codebase, document patterns |
| 2. User Journeys  | `/user-journeys`    | `.claude/docs/{feature}-user-journeys.md` | Map all actor interactions          |
| 3. Story Prep     | `/prepare-stories`  | `.claude/stories/{feature}.md`            | Create implementable stories        |
| 4. Implementation | `/feature`          | Code changes                              | Execute with multi-dev team         |
| 5. Doc Refresh    | `ai-docs-generator` | Updated docs + changelog                  | Refresh docs for future AI agents   |

---

## PHASE 1: Discovery

### Objective

Thoroughly explore and document the feature area before any planning begins.

### Execution

**Step 1.1: Check for Existing Documentation**

First, search for any existing documentation:

```
Glob: ".claude/docs/*.md"
```

**Step 1.2: Determine Discovery Scope**

If documentation exists for `$ARGUMENTS`:

- Read and summarize existing documentation
- Identify any gaps or outdated information
- Ask user: "Existing documentation found. Should I: (1) Use it as-is, (2) Update it, (3) Start fresh?"

If no documentation exists:

- Proceed to discovery execution

**Step 1.3: Execute Discovery**

Use the Task tool with `subagent_type="Explore"` to thoroughly investigate:

```
## Discovery Request

### Target Feature
$ARGUMENTS

### Investigation Goals
1. Find all files related to this functionality
2. Identify entry points (components, controllers, services, routes)
3. Map dependencies (imports, injected services, external APIs)
4. Document data flow (inputs, outputs, state changes)
5. Identify integration points with other modules
6. Capture patterns and conventions used
7. Note any existing tests

### Output Requirements
Produce comprehensive exploration findings covering:
- File inventory with purposes
- Architecture overview
- Key patterns identified
- Integration touchpoints
- Potential complexity areas
```

**Step 1.4: Generate Discovery Documentation**

Create documentation at `.claude/docs/{feature-name}.md` following the discovery template:

- Overview and purpose
- Architecture and file structure
- Dependencies (internal and external)
- Data flow and state management
- Key patterns and conventions
- API endpoints involved
- Testing considerations
- Agent implementation notes

**Step 1.5: Checkpoint**

### Phase State Preservation

Before presenting checkpoint to user:

1. Run `/compact` to compress Phase 1 context
2. Log discovery decisions to state:

Use the Task tool with `subagent_type="state-manager"`:

```
## Phase Checkpoint Request

### Phase Details
- Phase: 1 - Discovery
- Status: Complete
- Output: .claude/docs/{feature-name}.md

### Decisions to Log
- Files identified: [N]
- Entry points discovered: [List]
- Key patterns: [List]

### Your Task
1. Log phase completion to decisions.yaml
2. Update session phase status
3. Preserve discovery context for future phases
```

### User Checkpoint

```markdown
## Phase 1 Complete: Discovery

**Documentation saved to:** `.claude/docs/{feature-name}.md`

### Summary

- **Files identified:** [N]
- **Entry points:** [List]
- **Key integrations:** [List]
- **Patterns to follow:** [List]

### Key Findings

[2-3 bullet summary of important discoveries]

---

**Ready to proceed to Phase 2 (User Journeys)?**

Options:

1. **Continue** - Proceed to User Journey analysis
2. **Review** - Let me examine the documentation first
3. **Expand** - Explore additional areas
4. **Skip** - Jump directly to Phase 3 (Stories)
```

Wait for user approval before proceeding to Phase 2.

---

## PHASE 2: User Journeys

### Objective

Identify and document all user interactions with the feature across all actor types.

### Prerequisites

- Phase 1 Discovery documentation must exist at `.claude/docs/{feature-name}.md`

### Execution

**Step 2.1: Launch User Journey Analysis**

Use the Task tool with `subagent_type="user-journey-analyst"`:

```
## User Journey Analysis Request

### Target Scope
$ARGUMENTS

### Source Documentation
Read and analyze: `.claude/docs/{feature-name}.md`
Also check: `.claude/docs/wetrack-overview.md`, `.claude/docs/wetrack-backend.md`, `.claude/docs/wetrack-frontend.md`

### Your Task
Extract ALL user journeys for this feature:

1. **End User Journeys** - External users, patrons, public
2. **Staff User Journeys** - Internal operators, handlers, control room
3. **Admin Journeys** - Configuration, setup, management
4. **System Journeys** - Automated processes, background jobs
5. **External Integration Journeys** - API consumers, webhooks, third-party

For each journey, capture:
- Trigger event
- Preconditions
- Step-by-step flow
- Success path
- Error paths
- Technical entry points

### Output
Save to: `.claude/docs/{feature-name}-user-journeys.md`
```

**Step 2.2: Interactive Clarification**

If the agent identifies gaps:

- Present questions to user
- Collect answers
- Update journey documentation

**Step 2.3: Journey Review**

Present journey summaries by actor type for user validation:

- End User Journeys
- Staff User Journeys
- Admin Journeys
- System Journeys
- External Integration Journeys

Wait for user feedback on each category.

**Step 2.4: Checkpoint**

### Phase State Preservation

Before presenting checkpoint to user:

1. Run `/compact` to compress Phase 2 context
2. Log journey decisions to state:

Use the Task tool with `subagent_type="state-manager"`:

```
## Phase Checkpoint Request

### Phase Details
- Phase: 2 - User Journeys
- Status: Complete
- Output: .claude/docs/{feature-name}-user-journeys.md

### Decisions to Log
- Total journeys documented: [N]
- Actor types covered: [List]
- Critical journeys: [List]
- Unresolved gaps: [List or "None"]

### Your Task
1. Log phase completion to decisions.yaml
2. Update session phase status
3. Preserve journey context for story creation
```

### User Checkpoint

```markdown
## Phase 2 Complete: User Journeys

**Documentation saved to:** `.claude/docs/{feature-name}-user-journeys.md`

### Summary

| Actor Type | Journey Count |
| ---------- | ------------- |
| End User   | [N]           |
| Staff User | [N]           |
| Admin      | [N]           |
| System     | [N]           |
| External   | [N]           |
| **Total**  | **[N]**       |

### Critical Journeys (Implementation Priority)

1. [Journey ID]: [Title]
2. [Journey ID]: [Title]
3. [Journey ID]: [Title]

### Unresolved Gaps

[List any gaps that couldn't be resolved]

---

**Ready to proceed to Phase 3 (Story Preparation)?**

Options:

1. **Continue** - Proceed to Story creation
2. **Review** - Let me examine the journeys first
3. **Add Journeys** - I need to add more journeys
4. **Skip** - Jump directly to Phase 4 (Implementation)
```

Wait for user approval before proceeding to Phase 3.

---

## PHASE 3: Story Preparation

### Objective

Transform the documented feature and journeys into structured, implementable stories.

### Prerequisites

- Phase 1 Discovery: `.claude/docs/{feature-name}.md`
- Phase 2 User Journeys: `.claude/docs/{feature-name}-user-journeys.md`

### Execution

**Step 3.1: Analyze Available Context**

Read both documentation files to understand:

- Technical implementation requirements
- All user journeys to cover
- Patterns to follow
- Integration points

**Step 3.2: Create Story Structure**

For each major journey or feature area, create stories:

```markdown
# Stories for: {Feature Name}

## Overview

- **Total Stories:** [N]
- **Discovery Doc:** .claude/docs/{feature-name}.md
- **User Journeys:** .claude/docs/{feature-name}-user-journeys.md

## Phase 1: Foundation Stories

[Database, models, base services]

## Phase 2: Core Implementation Stories

[Main functionality, primary journeys]

## Phase 3: Integration Stories

[Connect components, API endpoints, frontend-backend integration]

## Phase 4: Secondary Journeys

[Admin features, error paths, edge cases]

## Phase 5: Polish & Testing

[Validation, testing, documentation updates]

---

[Individual stories with full template...]
```

**Step 3.3: Map Journeys to Stories**

Create a journey-to-story mapping:

| Journey ID | Journey Title         | Story/Stories | Status  |
| ---------- | --------------------- | ------------- | ------- |
| EUSR-001   | Primary end user flow | Story 3, 4, 5 | Planned |
| ADMN-001   | Admin configuration   | Story 1, 2    | Planned |
| ...        | ...                   | ...           | ...     |

Ensure ALL journeys are covered by at least one story.

**Step 3.4: Story Validation**

Verify each story has:

- [ ] Clear objective
- [ ] Specific acceptance criteria
- [ ] Journey references
- [ ] Documentation references
- [ ] Technical notes
- [ ] Agent command

**Step 3.5: Checkpoint**

### Phase State Preservation

Before presenting checkpoint to user:

1. Run `/compact` to compress Phase 3 context
2. Log story planning decisions to state:

Use the Task tool with `subagent_type="state-manager"`:

```
## Phase Checkpoint Request

### Phase Details
- Phase: 3 - Story Preparation
- Status: Complete
- Output: .claude/stories/{feature-name}.md

### Decisions to Log
- Total stories created: [N]
- Stories by complexity: [S/M/L/XL breakdown]
- Journey coverage: [N] of [Total]
- Uncovered journeys: [List or "None"]

### Your Task
1. Log phase completion to decisions.yaml
2. Update session phase status
3. Preserve story structure for implementation
```

### User Checkpoint

```markdown
## Phase 3 Complete: Stories Prepared

**Stories saved to:** `.claude/stories/{feature-name}.md`

### Summary

| Phase               | Stories | Complexity      |
| ------------------- | ------- | --------------- |
| Foundation          | [N]     | S/M/L breakdown |
| Core Implementation | [N]     | S/M/L breakdown |
| Integration         | [N]     | S/M/L breakdown |
| Secondary Journeys  | [N]     | S/M/L breakdown |
| Polish & Testing    | [N]     | S/M/L breakdown |
| **Total**           | **[N]** |                 |

### Journey Coverage

- **Journeys covered:** [N] of [Total]
- **Uncovered journeys:** [List or "None"]

### Estimated Effort

[S/M/L/XL distribution]

---

**Ready to proceed to Phase 4 (Implementation)?**

Options:

1. **Continue** - Start implementation with multi-dev team
2. **Review Stories** - Let me examine the stories first
3. **Adjust Stories** - I need to modify some stories
4. **Pause** - I'll continue implementation later
```

Wait for user approval before proceeding to Phase 4.

---

## PHASE 4: Implementation

### Objective

Execute all stories using the multi-developer team workflow.

### Implementation Tracking

During implementation, the team will track:

- Files created/modified
- New patterns introduced
- API endpoints added
- Database changes
- Configuration additions
- Deviations from original plan

This information is captured for Phase 5 documentation refresh.

### Prerequisites

- Stories file: `.claude/stories/{feature-name}.md`
- Discovery doc: `.claude/docs/{feature-name}.md`
- User journeys: `.claude/docs/{feature-name}-user-journeys.md`

### Execution

Invoke the `/feature` workflow with full context:

```
## Feature Implementation: $ARGUMENTS

### Context Documents (MUST READ FIRST)
- `.claude/docs/{feature-name}.md` - Discovery documentation
- `.claude/docs/{feature-name}-user-journeys.md` - User journey documentation
- `.claude/stories/{feature-name}.md` - Prepared stories

### Implementation Approach
Follow the `/feature` workflow phases:
1. **Planning** - project-orchestrator breaks down stories
2. **UI/UX Design** - ui-ux-designer creates design specs (referencing journeys)
3. **Contract Definition** - team-lead defines interfaces
4. **Task Distribution** - team-lead assigns developer tasks
5. **Parallel Implementation** - developers work simultaneously
6. **Team Lead Review** - verify contract compliance
7. **Code Review** - security, performance, architecture, quality
8. **Final Sign-off** - team-lead approves
9. **Documentation** - ai-docs-generator updates docs

### Important
- All implementations MUST satisfy the user journeys documented
- Follow patterns identified in discovery documentation
- Update documentation as needed during implementation
- Frontend developer should follow Gemini → ChromeDevTools → Playwright hierarchy for HTML/SCSS work and browser verification (see `.claude/agents/_gemini-design-hook.md`)
```

### Phase 4 Sub-Checkpoints

The `/feature` workflow has its own checkpoints between each step. User approval is requested before each major transition.

**Step 4.1: Implementation Complete Checkpoint**

After all implementation steps complete:

### Phase State Preservation

Before presenting checkpoint to user:

1. Run `/compact` to compress Phase 4 implementation context
2. Log implementation decisions to state:

Use the Task tool with `subagent_type="state-manager"`:

```
## Phase Checkpoint Request

### Phase Details
- Phase: 4 - Implementation
- Status: Complete
- Output: Code changes across multiple files

### Decisions to Log
- Files created: [N]
- Files modified: [N]
- New API endpoints: [List]
- Database migrations: [List]
- New patterns introduced: [List]
- Deviations from stories: [List or "None"]
- Review outcomes: [Security/Performance/Architecture/Quality]

### Your Task
1. Log phase completion to decisions.yaml
2. Update session phase status
3. Preserve implementation context for documentation phase
4. Log any deviations or new patterns discovered
```

### User Checkpoint

```markdown
## Phase 4 Complete: Implementation

### Implementation Summary

| Metric              | Count |
| ------------------- | ----- |
| Files Created       | [N]   |
| Files Modified      | [N]   |
| New API Endpoints   | [N]   |
| Database Migrations | [N]   |
| New Components      | [N]   |
| New Services        | [N]   |

### Key Deliverables

[List main deliverables]

### Patterns Introduced

[Any new patterns that future agents should know about]

### Deviations from Plan

[Any significant deviations from the original stories]

---

**Ready to proceed to Phase 5 (Documentation Refresh)?**

Options:

1. **Continue** - Refresh documentation for future AI agents
2. **Skip** - Finish without updating documentation
3. **Review** - Let me review the implementation first
```

Wait for user approval before proceeding to Phase 5.

---

## PHASE 5: Documentation Refresh

### Objective

Update all documentation to reflect implementation reality, ensuring future AI agents have accurate, up-to-date information for discovery.

### Why This Phase Matters

```
    ┌─────────────────────────────────────────────────────────┐
    │              DOCUMENTATION FEEDBACK LOOP                │
    │                                                         │
    │   Future Agent                     This Implementation  │
    │       │                                    │            │
    │       ▼                                    │            │
    │   ┌───────────┐     uses      ┌───────────┐            │
    │   │ Discovery │◀──────────────│ Phase 5   │◀───────────│
    │   │  Phase 1  │               │ Doc Update│            │
    │   └───────────┘               └───────────┘            │
    │                                                         │
    │   What you document now becomes discovery context later │
    └─────────────────────────────────────────────────────────┘
```

### Documentation Updates

**Step 5.1: Update Discovery Documentation**

Read the existing discovery doc and update it with implementation reality:

```markdown
## Update: `.claude/docs/{feature-name}.md`

### Sections to Update:

1. **File Structure** - Add all new files created
2. **Entry Points** - Update with actual controllers, components, services
3. **Dependencies** - Add any new dependencies introduced
4. **Data Flow** - Update with actual implementation flow
5. **API Endpoints** - Add all new endpoints with request/response examples
6. **Key Patterns** - Document any new patterns introduced
7. **Configuration** - Document new config options
8. **Testing** - Update test file locations and key test scenarios

### Sections to Add:

1. **Implementation Notes**
   - Decisions made during implementation
   - Trade-offs chosen
   - Known limitations

2. **Troubleshooting Guide**
   - Common issues encountered
   - How to debug this feature
   - Error messages and their meaning

3. **Extension Points**
   - Where future enhancements should be added
   - Hooks for customization
   - Plugin points if applicable
```

**Step 5.2: Verify User Journeys**

Compare implemented behavior against documented journeys:

```markdown
## Verify: `.claude/docs/{feature-name}-user-journeys.md`

### For Each Journey:

- [ ] Trigger still accurate?
- [ ] Steps match implementation?
- [ ] Success path works as documented?
- [ ] Error paths implemented as documented?
- [ ] Technical entry points correct?

### Update Required If:

- Journey was modified during implementation
- New journeys were added
- Journeys were descoped
- Error handling differs from documented
```

**Step 5.3: Update Stories with Completion Status**

Mark stories as complete and add implementation notes:

```markdown
## Update: `.claude/stories/{feature-name}.md`

### For Each Story:

- [ ] Mark status: ✅ Complete | ⏸️ Deferred | ❌ Descoped
- [ ] Add implementation notes
- [ ] Link to actual files created
- [ ] Note any deviations from acceptance criteria
```

**Step 5.4: Generate AI Agent Quick Reference**

Use the Task tool with `subagent_type="ai-docs-generator"`:

````
## AI Documentation Update Request

### Feature Completed
$ARGUMENTS

### Implementation Summary
[Include summary from Phase 4]

### Files Changed
[List all files created/modified]

### Your Tasks

1. **Update Discovery Doc** (`.claude/docs/{feature-name}.md`)
   - Add all new files to file structure
   - Update entry points with actual implementations
   - Add new patterns discovered during implementation
   - Include troubleshooting and extension point sections

2. **Create/Update Quick Reference Section**
   Add an "AI Agent Quick Start" section:
   ```markdown
   ## AI Agent Quick Start

   ### To Understand This Feature
   1. Read this document for architecture overview
   2. Check `{main-entry-point}` for the primary flow
   3. See `{config-file}` for configuration options

   ### To Modify This Feature
   1. [Step-by-step for common modifications]

   ### To Extend This Feature
   1. [Where to add new functionality]

   ### Common Pitfalls
   - [Mistake 1 and how to avoid]
   - [Mistake 2 and how to avoid]
````

3. **Update Cross-References**
   - Link to related features
   - Update dependent feature documentation
   - Add backlinks from affected modules

4. **Verify Discoverability**
   Ensure an AI agent searching for:
   - "[feature name]" finds this doc
   - "[key functionality]" finds relevant sections
   - "[common task]" finds the right entry point

````

**Step 5.5: Update Project-Wide Documentation**

Check and update project-level documentation:

```markdown
### Project Documentation Updates

1. **API Documentation** (if new endpoints)
   - Update `.claude/docs/wetrack-backend.md` with new endpoints
   - Add request/response examples
   - Document authentication requirements

2. **Frontend Documentation** (if new components)
   - Update `.claude/docs/wetrack-frontend.md` with new components
   - Document component usage patterns
   - Add to module documentation

3. **Feature Index** (if exists)
   - Add new feature to feature list
   - Update feature dependencies map

4. **Configuration Guide** (if new config)
   - Document new configuration options
   - Add to environment setup guides
````

**Step 5.6: Create Implementation Changelog Entry**

Add an entry to track what was built:

```markdown
## Implementation Record

Save to: `.claude/docs/changelog/{feature-name}-{date}.md`

---

type: implementation-record
feature: {feature-name}
completed: {YYYY-MM-DD}
stories_completed: [N]
files_created: [N]
files_modified: [N]

---

# Implementation: {Feature Name}

## Summary

[2-3 sentence summary of what was built]

## Deliverables

| Type       | Item   | Location |
| ---------- | ------ | -------- |
| Controller | {Name} | {path}   |
| Service    | {Name} | {path}   |
| Component  | {Name} | {path}   |
| Migration  | {Name} | {path}   |

## API Endpoints Added

| Method | Endpoint | Purpose |
| ------ | -------- | ------- |
| GET    | /api/... | ...     |
| POST   | /api/... | ...     |

## Database Changes

[Tables/columns added or modified]

## Configuration Added

[New config keys and their purpose]

## Patterns Introduced

[Any new patterns future developers should follow]

## Known Limitations

[What this implementation doesn't do]

## Future Enhancements

[Suggested future improvements]
```

**Step 5.7: Documentation Verification**

Final verification checklist:

```markdown
## Documentation Verification

### Accuracy Checks

- [ ] All file paths in docs exist in codebase
- [ ] All function/class names match actual code
- [ ] API endpoint documentation matches implementation
- [ ] Configuration documentation is complete

### Discoverability Checks

- [ ] Feature can be found by searching its name
- [ ] Key functionality is tagged appropriately
- [ ] Cross-references are bidirectional
- [ ] Index/overview docs are updated

### Completeness Checks

- [ ] Discovery doc updated with implementation details
- [ ] User journeys verified against implementation
- [ ] Stories marked with completion status
- [ ] AI Agent Quick Start section exists
- [ ] Troubleshooting guide included
- [ ] Extension points documented
```

**Step 5.8: Checkpoint**

```markdown
## Phase 5 Complete: Documentation Refresh

### Documentation Updated

| Document      | Status       | Changes                        |
| ------------- | ------------ | ------------------------------ |
| Discovery Doc | ✅ Updated   | +[N] sections, [N] files added |
| User Journeys | ✅ Verified  | [N] journeys confirmed         |
| Stories       | ✅ Completed | [N] marked complete            |
| Changelog     | ✅ Created   | Implementation record added    |

### AI Agent Discoverability

- [ ] Quick Start section added
- [ ] Troubleshooting guide added
- [ ] Extension points documented
- [ ] Cross-references updated

### Project Docs Updated

- [ ] Backend docs: [Updated/N/A]
- [ ] Frontend docs: [Updated/N/A]
- [ ] API docs: [Updated/N/A]

---

**Documentation refresh complete!**

Future AI agents will now have accurate, up-to-date information when they run `/discover {feature-name}`.
```

---

## Post-Phase: Session Closure

After all 5 phases complete, finalize the session for state persistence and future reference.

### Final Context Compression

Run `/compact` one final time to compress the complete lifecycle context:

- All 5 phase summaries
- Key decisions across phases
- Final implementation state
- Documentation produced

### Generate Complete Handoff

Run `/handoff` to create a comprehensive handoff document:

```
## Handoff Document Contents

### Feature Overview
- Feature: $ARGUMENTS
- Phases completed: 5 of 5
- Total duration: [Start to end]

### Phase Summaries
1. Discovery: [Key findings]
2. User Journeys: [Journey count and coverage]
3. Stories: [Story count and complexity]
4. Implementation: [Files changed, reviews passed]
5. Documentation: [Docs updated]

### Artifacts Produced
- Discovery doc: .claude/docs/{feature-name}.md
- User journeys: .claude/docs/{feature-name}-user-journeys.md
- Stories: .claude/stories/{feature-name}.md
- Changelog: .claude/docs/changelog/{feature-name}-{date}.md

### Key Decisions
[All logged decisions from decisions.yaml]

### For Future Agents
[Critical context for agents working on this feature]
```

### Finalize Session State

Use the Task tool with `subagent_type="state-manager"`:

```
## Session Finalization Request

### Session Details
- Type: feature-lifecycle
- Feature: $ARGUMENTS
- Status: Complete (all 5 phases)

### Final Metrics
- Discovery: .claude/docs/{feature-name}.md
- Journeys documented: [N]
- Stories created: [N]
- Files created: [N]
- Files modified: [N]
- Reviews passed: 4/4

### Your Task
1. Mark session as "completed"
2. Log final phase completion
3. Generate session summary statistics
4. Archive session for future reference
```

### Display Final Session Status

Run `/session-status` to display:

- Complete lifecycle metrics
- All phase completion times
- Decision log summary
- Handoff document location

---

## Completion Summary

After all phases complete, provide a comprehensive summary:

```markdown
## Feature Lifecycle Complete: $ARGUMENTS

### Phase Summary

| Phase             | Status      | Key Output                     |
| ----------------- | ----------- | ------------------------------ |
| 1. Discovery      | ✅ Complete | `.claude/docs/{feature}.md`    |
| 2. User Journeys  | ✅ Complete | [N] journeys documented        |
| 3. Story Prep     | ✅ Complete | [N] stories created            |
| 4. Implementation | ✅ Complete | [N] files changed              |
| 5. Doc Refresh    | ✅ Complete | Docs updated for future agents |

### Documentation Produced

| Document      | Location                                     | For Future Agents                    |
| ------------- | -------------------------------------------- | ------------------------------------ |
| Discovery     | `.claude/docs/{feature}.md`                  | Architecture, patterns, entry points |
| User Journeys | `.claude/docs/{feature}-user-journeys.md`    | All actor interactions               |
| Stories       | `.claude/stories/{feature}.md`               | Implementation spec (completed)      |
| Changelog     | `.claude/docs/changelog/{feature}-{date}.md` | What was built                       |

### Implementation Summary

| Metric                    | Count      |
| ------------------------- | ---------- |
| Files Created             | [N]        |
| Files Modified            | [N]        |
| API Endpoints Added       | [N]        |
| Components Created        | [N]        |
| Services Created          | [N]        |
| User Journeys Implemented | [N] of [N] |

### Code Review Summary

| Reviewer     | Issues Found | Status      |
| ------------ | ------------ | ----------- |
| Security     | [count]      | ✅ Approved |
| Performance  | [count]      | ✅ Approved |
| Architecture | [count]      | ✅ Approved |
| Code Quality | [count]      | ✅ Approved |

### Documentation Feedback Loop Status

Future AI agents running `/discover {feature}` will now find:

- ✅ Accurate file structure with all new files
- ✅ Current entry points (controllers, components, services)
- ✅ Implementation patterns to follow
- ✅ Troubleshooting guide for common issues
- ✅ Extension points for future enhancements
- ✅ AI Agent Quick Start section

### Next Steps

- Run tests: `npm run jest` (frontend), `dotnet test` (backend)
- Manual testing per journey documentation
- Deploy to staging for QA
- Consider: What's the next feature?

### Team Lead Final Verdict

✅ APPROVED - Feature is production-ready with documentation for future AI agents
```

---

## Quick Reference

### Start Full Lifecycle

```
/feature-lifecycle {feature description}
```

### Skip Phases

If you want to skip phases (e.g., documentation already exists):

- Answer "Skip" at any checkpoint to jump ahead
- Or run individual commands: `/discover`, `/user-journeys`, `/prepare-stories`, `/feature`

### Resume from Phase

If you need to resume from a specific phase:

- Phase 2: `/user-journeys {feature-name}`
- Phase 3: `/prepare-stories {feature-name}`
- Phase 4: `/feature {feature-name}`

### Prerequisites Check

Before starting, ensure:

- [ ] Feature requirements are clear
- [ ] You have access to the codebase
- [ ] Build passes (see PROJECT_STARTUP.md for build commands)

---

## Agent Memory

At workflow start, each dispatched agent should consult its `.claude/agent-memory/{agent-name}/MEMORY.md` for prior learnings. At workflow end, agents should persist key insights discovered during this run.

---

## Error Handling

### Build Failures

If build fails during any phase:

1. Capture the error output
2. Diagnose the issue
3. Fix before continuing
4. Re-run affected phase steps

### Missing Documentation

If required documentation is missing:

1. Offer to create it now
2. Or skip to the next available phase
3. Note the gap for future resolution

### Stuck on a Story

If implementation gets stuck:

1. Use Integration Developer to help
2. Surface the blocker to user
3. Adjust story scope if needed
4. Continue with other stories

### User Questions

At any checkpoint, the user may:

- Ask questions about the feature
- Request clarification on stories
- Ask to see specific documentation
- Request to modify the approach

Handle these gracefully before continuing.

---

## Best Practices

1. **Don't Rush Phases** - Each phase builds on the previous; thoroughness pays off
2. **Document Decisions** - Capture important decisions in documentation
3. **Validate Early** - Check understanding at each checkpoint
4. **Map Journeys to Stories** - Ensure no journey is left unimplemented
5. **Follow Patterns** - Use patterns discovered in Phase 1
6. **Update Docs** - Keep documentation current as you learn more
7. **Test as You Go** - Run builds and lints frequently
