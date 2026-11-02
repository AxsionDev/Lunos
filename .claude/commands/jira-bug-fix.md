# Jira Bug Fix Workflow

Orchestrate a complete bug investigation and fix cycle from a Jira ticket: $ARGUMENTS

## Overview

This command wraps the existing `/bug-fix` workflow with Jira integration — fetching ticket details before the workflow and updating the ticket after completion. It does NOT duplicate `/bug-fix`; it reads and executes it with enriched context from Jira.

```
Jira Step 0: Setup & Fetch  →  Jira Step 1: Assess & Enrich  →  Jira Step 2: Execute /bug-fix  →  Jira Step 3: Jira Update
```

---

## Pre-flight: Worktree Reset (FIRST — before any action)

Before anything else, invoke **`Skill(worktree-preflight)`** to reset into a clean task worktree. _(Fallback: read `.claude/skills/worktree-preflight/SKILL.md` and follow it.)_ If the user passed an override base branch in `$ARGUMENTS` (e.g. a `--base=<branch>` token), pass it through; otherwise the repo default branch is used. If the project is not a git repository, the skill no-ops and this command proceeds normally. (The wrapped `/bug-fix` in Jira Step 2 will detect this worktree and reuse it rather than reset again.)

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

**If type is Bug:** Proceed normally.

**If type is Story / Feature / Epic / Task:**

> "This ticket ({ticket.key}) is a **{ticket.type}**, not a Bug. The `/jira-bug-fix` workflow is optimized for bug investigation.
>
> Would you like to:
>
> 1. **Continue anyway** — Treat it as a bug fix
> 2. **Switch to `/jira-feature`** — Use the feature lifecycle workflow instead
> 3. **Cancel** — Stop and reconsider"

Wait for user response before proceeding.

---

## Jira Step 1: Assess & Enrich

Execute Protocol C from `.claude/commands/_jira-protocol.md` using the **Bug checklist**.

### Assess Ticket Completeness

Evaluate the ticket against the bug checklist:

| #   | Criteria              | Status |
| --- | --------------------- | ------ |
| 1   | Steps to Reproduce    | ?      |
| 2   | Expected Behavior     | ?      |
| 3   | Actual Behavior       | ?      |
| 4   | Environment           | ?      |
| 5   | Error Messages / Logs | ?      |

### Fill Gaps

- **SUFFICIENT** (4-5 present): Proceed directly
- **PARTIAL** (2-3 present): Ask targeted questions (max 2 rounds)
- **INSUFFICIENT** (0-1 present): Ask multiple questions in structured format

### Construct Enriched Bug Description

Combine Jira ticket data + user answers into the comprehensive bug report format from Protocol C, Step C4.

### Approval Gate

Present the enriched bug description and ask:

> "Bug details extracted from **{ticket.key}: {ticket.title}**
>
> **Summary:**
>
> - Steps to Reproduce: {present/enriched}
> - Expected: {present/enriched}
> - Actual: {present/enriched}
> - Environment: {present/enriched}
> - Errors: {present/enriched}
>
> **Ready to start the bug fix workflow?** (yes / adjust / cancel)"

Wait for explicit user confirmation before proceeding.

---

## Jira Step 2: Execute Bug Fix Workflow

Read and execute the full `/bug-fix` workflow from `.claude/commands/bug-fix.md`, using the enriched bug description as the `$ARGUMENTS` input.

### How to Execute

1. Read `.claude/commands/bug-fix.md` to load the complete workflow
2. Execute all steps (Pre-Step through Step 8) with the enriched description as context
3. The agent-clarifier (Step 1 of bug-fix) will fast-track since the enriched description is comprehensive — it should confirm understanding quickly rather than asking many questions

### Passing Context

When executing each step of `/bug-fix`, ensure:

- **Pre-Step (State Init):** Session name includes Jira key: `"Bug fix: {ticket.key} - {ticket.title}"`
- **Step 0 (Project Detection):** Normal execution
- **Step 1 (Clarification):** Pass the enriched description — clarification should be quick since Jira details + user enrichment provide most answers
- **Steps 2-6:** Normal execution with enriched context
- **Step 7 (Summary):** Include Jira ticket key in the summary
- **Step 8 (Session Closure):** Normal execution

### Track Workflow Outcome

Track whether the workflow completes successfully:

- `workflow_outcome = "completed"` — All steps finished, code review passed
- `workflow_outcome = "partial"` — Stopped at a step (user cancelled, build failed, etc.)
- `workflow_outcome = "failed"` — Critical failure, no fix applied

Store the outcome and implementation summary for Jira Step 3.

---

## Jira Step 3: Post-Workflow Jira Update

Execute Protocol D from `.claude/commands/_jira-protocol.md` — but ONLY if the workflow completed successfully.

### Decision Logic

| Workflow Outcome | Jira Action                                     |
| ---------------- | ----------------------------------------------- |
| `completed`      | Transition to "In Review" + add summary comment |
| `partial`        | Offer optional progress comment (no transition) |
| `failed`         | No Jira updates                                 |

### If Completed

1. Get available transitions for the ticket
2. Find and execute "In Review" transition (or let user choose)
3. Add a summary comment with:
   - Root cause identified
   - Fix applied
   - Files changed
   - Code review status
   - Browser verification status

### If Partial

Ask the user:

> "The bug fix workflow didn't fully complete. Would you like me to add a progress comment to {ticket.key}?
>
> The comment would include:
>
> - Steps completed so far
> - Current status
> - Remaining work
>
> (yes / no)"

If yes, add a progress comment without transitioning the ticket.

### If Failed or Manual Mode

- **Failed:** No Jira updates. Display what went wrong.
- **Manual mode:** Display the summary and suggest the user update the ticket manually.

---

## Error Handling

### Jira Connection Failures

If Jira becomes unavailable mid-workflow:

- Continue the bug fix — don't block development over Jira connectivity
- At the end, provide the comment text for manual posting

### Ticket Type Mismatch

If the ticket is not a Bug type, offer to switch to `/jira-feature`. Don't force the user to use a specific workflow.

### Enrichment Stalls

If the user can't provide missing information after 2 rounds:

- Proceed with available information
- Note gaps in the bug description
- The agent-clarifier in `/bug-fix` Step 1 will catch remaining gaps

### Transition Failures

If the "In Review" transition fails:

- Show available transitions
- Let the user choose or skip
- Provide the comment text for manual posting

---

## Quick Reference

```
/jira-bug-fix https://company.atlassian.net/browse/PROJ-123
/jira-bug-fix PROJ-123
```
