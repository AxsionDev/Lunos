# Jira Feature Lifecycle Workflow

Orchestrate the complete feature development lifecycle from a Jira ticket: $ARGUMENTS

## Overview

This command wraps the existing `/feature-lifecycle` workflow with Jira integration — fetching ticket details before the workflow and updating the ticket after completion. It does NOT duplicate `/feature-lifecycle`; it reads and executes it with enriched context from Jira.

```
Jira Step 0: Setup & Fetch  →  Jira Step 1: Assess & Enrich  →  Jira Step 2: Execute /feature-lifecycle  →  Jira Step 3: Jira Update
```

---

## Pre-flight: Worktree Reset (FIRST — before any action)

Before anything else, invoke **`Skill(worktree-preflight)`** to reset into a clean task worktree. *(Fallback: read `.claude/skills/worktree-preflight/SKILL.md` and follow it.)* If the user passed an override base branch in `$ARGUMENTS` (e.g. a `--base=<branch>` token), pass it through; otherwise the repo default branch is used. If the project is not a git repository, the skill no-ops and this command proceeds normally. (The wrapped `/feature-lifecycle` in Jira Step 2 will detect this worktree and reuse it rather than reset again.)

---

## Jira Step 0: Setup & Fetch Ticket

Execute Protocols A and B from `.claude/commands/_jira-protocol.md`.

### A: Establish Jira Connection

1. Parse the ticket key from `$ARGUMENTS` (URL or bare key)
2. Test the Atlassian MCP connection
3. If MCP fails: attempt auto-setup, then fall back to manual paste
4. Store `jira_mode` ("mcp" or "manual") and `jira_ticket_key`

### B: Fetch Ticket Details

1. Retrieve full issue data (title, description, type, priority, status, acceptance criteria)
2. Fetch up to 5 recent comments for additional context
3. Present the ticket summary to the user

### Verify Ticket Type

After fetching, check the ticket type:

**If type is Story / Feature / Epic / Task:** Proceed normally.

**If type is Bug:**

> "This ticket ({ticket.key}) is a **Bug**, not a Story/Feature. The `/jira-feature` workflow is optimized for feature development.
>
> Would you like to:
> 1. **Continue anyway** — Treat it as a feature implementation
> 2. **Switch to `/jira-bug-fix`** — Use the bug fix workflow instead
> 3. **Cancel** — Stop and reconsider"

Wait for user response before proceeding.

---

## Jira Step 1: Assess & Enrich

Execute Protocol C from `.claude/commands/_jira-protocol.md` using the **Feature checklist**.

### Assess Ticket Completeness

Evaluate the ticket against the feature checklist:

| # | Criteria | Status |
|---|----------|--------|
| 1 | Business Context | ? |
| 2 | Acceptance Criteria | ? |
| 3 | User-Facing Scope | ? |
| 4 | Technical Constraints | ? |
| 5 | Out of Scope | ? |

### Fill Gaps

- **SUFFICIENT** (4-5 present): Proceed directly
- **PARTIAL** (2-3 present): Ask targeted questions (max 2 rounds)
- **INSUFFICIENT** (0-1 present): Ask multiple questions in structured format

### Construct Enriched Feature Description

Combine Jira ticket data + user answers into the comprehensive feature description format from Protocol C, Step C4.

### Approval Gate

Present the enriched feature description and ask:

> "Feature details extracted from **{ticket.key}: {ticket.title}**
>
> **Summary:**
> - Business Context: {present/enriched}
> - Acceptance Criteria: {N criteria identified}
> - User-Facing Scope: {present/enriched}
> - Technical Constraints: {present/enriched}
> - Out of Scope: {present/enriched}
>
> **Ready to start the feature lifecycle workflow?** (yes / adjust / cancel)"

Wait for explicit user confirmation before proceeding.

---

## Jira Step 2: Execute Feature Lifecycle Workflow

Read and execute the full `/feature-lifecycle` workflow from `.claude/commands/feature-lifecycle.md`, using the enriched feature description as the `$ARGUMENTS` input.

### How to Execute

1. Read `.claude/commands/feature-lifecycle.md` to load the complete workflow
2. Execute all phases (Pre-Phase through Post-Phase) with the enriched description as context
3. The Jira ticket's acceptance criteria directly inform Phase 2 (User Journeys) and Phase 3 (Stories)

### Passing Context

When executing each phase of `/feature-lifecycle`, ensure:

- **Pre-Phase (State Init):** Session name includes Jira key: `"Feature: {ticket.key} - {ticket.title}"`
- **Phase 1 (Discovery):** Use enriched description to focus the discovery scope
- **Phase 2 (User Journeys):** Seed user journeys from the ticket's acceptance criteria — each acceptance criterion likely maps to a journey or journey step
- **Phase 3 (Stories):** Ticket acceptance criteria become story acceptance criteria — ensure full coverage
- **Phase 4 (Implementation):** Normal execution
- **Phase 5 (Doc Refresh):** Include Jira ticket key in changelog entry
- **Post-Phase (Session Closure):** Normal execution

### Phase Checkpoints

The `/feature-lifecycle` workflow has user approval gates between phases. These remain active — the user decides whether to continue, skip, or pause at each checkpoint.

### Track Workflow Outcome

Track which phases complete:

- `phases_completed = []` — List of completed phases (1-5)
- `workflow_outcome = "completed"` — All 5 phases finished
- `workflow_outcome = "partial"` — Stopped at a phase checkpoint (user paused or skipped remaining)
- `workflow_outcome = "failed"` — Critical failure

Store the outcome and phase summaries for Jira Step 3.

---

## Jira Step 3: Post-Workflow Jira Update

Execute Protocol D from `.claude/commands/_jira-protocol.md` — but ONLY if the workflow completed successfully.

### Decision Logic

| Workflow Outcome | Jira Action |
|------------------|-------------|
| `completed` (all 5 phases) | Transition to "In Review" + add full summary comment |
| `partial` (some phases done) | Offer optional progress comment (no transition) |
| `failed` | No Jira updates |

### If Completed

1. Get available transitions for the ticket
2. Find and execute "In Review" transition (or let user choose)
3. Add a summary comment with:
   - Phases completed (all 5)
   - Key deliverables (files created, endpoints added, components built)
   - Documentation produced (discovery doc, user journeys, stories, changelog)
   - Code review status (Security, Performance, Architecture, Quality)

### If Partial

Ask the user:

> "The feature lifecycle completed **{N} of 5 phases**. Would you like me to add a progress comment to {ticket.key}?
>
> The comment would include:
> - Phases completed: {list}
> - Phase currently at: {current_phase}
> - Artifacts produced so far
> - Remaining work
>
> (yes / no)"

If yes, add a progress comment without transitioning the ticket.

Also offer:

> "Would you like to be able to resume from Phase {next_phase} later? I can save the state with `/compact` and `/handoff`."

### If Failed or Manual Mode

- **Failed:** No Jira updates. Display what went wrong.
- **Manual mode:** Display the summary and suggest the user update the ticket manually.

---

## Error Handling

### Jira Connection Failures

If Jira becomes unavailable mid-workflow:
- Continue the feature lifecycle — don't block development over Jira connectivity
- At the end, provide the comment text for manual posting

### Ticket Type Mismatch

If the ticket is a Bug type, offer to switch to `/jira-bug-fix`. Don't force the user to use a specific workflow.

### Enrichment Stalls

If the user can't provide missing information after 2 rounds:
- Proceed with available information
- Note gaps in the feature description
- Phase 1 (Discovery) will uncover technical details organically
- Phase 2 (User Journeys) will surface missing scope through journey analysis

### Phase Failures

If a specific phase fails:
- Don't block subsequent phases unless they depend on the failed phase's output
- Log the failure for the Jira progress comment
- The `/feature-lifecycle` workflow has its own error handling per phase

### Transition Failures

If the "In Review" transition fails:
- Show available transitions
- Let the user choose or skip
- Provide the comment text for manual posting

---

## Quick Reference

```
/jira-feature https://company.atlassian.net/browse/PROJ-456
/jira-feature PROJ-456
```
