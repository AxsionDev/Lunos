# Jira Integration Protocol (Internal)

This file defines shared protocols for Jira-integrated commands. It is NOT a user-invocable command.

Referenced by: `/jira-bug-fix`, `/jira-feature`

---

## Protocol A: Jira MCP Setup

Establish a working connection to Jira via the Atlassian MCP server.

### Step A1: Parse Ticket Reference

Extract the Jira ticket key from `$ARGUMENTS` using these patterns (try in order):

1. **Full URL:** Match `/browse/([A-Z]+-\d+)` from a URL like `https://company.atlassian.net/browse/PROJ-123`
2. **Short URL:** Match `atlassian.net.*/([A-Z]+-\d+)` from any Atlassian URL variant
3. **Bare key:** Match `^([A-Z]+-\d+)$` — just the ticket key like `PROJ-123`
4. **Embedded key:** Match `([A-Z]+-\d+)` anywhere in the arguments

If no match is found, ask the user:

> "I couldn't find a Jira ticket key in your input. Please provide either a Jira URL (e.g., `https://yoursite.atlassian.net/browse/PROJ-123`) or a ticket key (e.g., `PROJ-123`)."

Store the extracted key as `jira_ticket_key` and set `jira_mode = "mcp"`.

### Step A2: Test MCP Connection

Try calling the Atlassian MCP tools directly:

```
mcp__MCP_DOCKER__mcp-exec with:
  name: "atlassian_get_issue"
  arguments: { issueIdOrKey: "{jira_ticket_key}" }
```

**If it succeeds:** MCP is configured. Proceed to Protocol B with the response data.

**If it fails (tool not found or connection error):** Continue to Step A3.

### Step A3: Auto-Setup MCP

Attempt to find and add the Atlassian MCP server:

1. Run `mcp-find "atlassian"` to locate the server in the catalog
2. If found, run `mcp-add` with the server name
3. Ask the user for configuration:

> "I need to configure the Jira connection. Please provide:
>
> 1. Your Jira instance URL (e.g., `https://yourcompany.atlassian.net`)
> 2. Your Jira username/email
> 3. Your Jira API token (create one at https://id.atlassian.com/manage-profile/security/api-tokens)"

4. Run `mcp-config-set` with the provided credentials
5. Retry the `get_issue` call from Step A2

**If setup succeeds:** Set `jira_mode = "mcp"`, proceed to Protocol B.

**If setup fails:** Continue to Step A4.

### Step A4: Manual Fallback

If MCP cannot be configured, fall back to manual ticket input:

Set `jira_mode = "manual"` and ask the user:

> "I couldn't connect to Jira automatically. Please paste the following ticket details:
>
> 1. **Ticket key** (e.g., PROJ-123)
> 2. **Title/Summary**
> 3. **Description** (full text)
> 4. **Acceptance Criteria** (if any)
> 5. **Type** (Bug / Story / Feature / Epic)
> 6. **Priority** (Critical / High / Medium / Low)
>
> I'll proceed with the workflow using pasted details. Note: I won't be able to update the ticket status at the end."

Store the manually provided data as the ticket object and proceed to Protocol B.

---

## Protocol B: Fetch Ticket Details

Retrieve and structure all relevant information from the Jira ticket.

### Step B1: Fetch Issue Data

**If `jira_mode = "mcp"`:**

Call the Atlassian MCP to get full issue details:

```
mcp__MCP_DOCKER__mcp-exec with:
  name: "atlassian_get_issue"
  arguments: { issueIdOrKey: "{jira_ticket_key}" }
```

**If `jira_mode = "manual"`:** Use the data provided by the user in Step A4.

### Step B2: Extract Structured Data

Parse the response into a structured ticket object:

```
ticket:
  key: "PROJ-123"
  title: "[Issue summary/title]"
  type: "Bug" | "Story" | "Feature" | "Epic" | "Task"
  status: "[Current status]"
  priority: "Critical" | "High" | "Medium" | "Low"
  description: "[Full description text]"
  acceptance_criteria: "[Extracted from description or custom field]"
  environment: "[Environment info if present]"
  labels: ["label1", "label2"]
  components: ["component1", "component2"]
  reporter: "[Reporter name]"
  assignee: "[Assignee name or Unassigned]"
  created: "[Creation date]"
  updated: "[Last update date]"
```

### Step B3: Fetch Recent Comments (MCP only)

If `jira_mode = "mcp"`, fetch up to 5 most recent comments:

```
mcp__MCP_DOCKER__mcp-exec with:
  name: "atlassian_get_issue_comments"
  arguments: { issueIdOrKey: "{jira_ticket_key}", maxResults: 5 }
```

Add relevant comments to the ticket object — especially those containing reproduction steps, technical details, or clarifications.

### Step B4: Present Ticket Summary

Display a concise summary to the user:

```markdown
## Jira Ticket: {ticket.key}

**Title:** {ticket.title}
**Type:** {ticket.type} | **Priority:** {ticket.priority} | **Status:** {ticket.status}

### Description

{ticket.description (truncated to ~500 chars if very long)}

### Acceptance Criteria

{ticket.acceptance_criteria or "None specified"}

### Recent Activity

{Summary of recent comments or "No recent comments"}
```

---

## Protocol C: Assess Ticket Completeness

Evaluate whether the ticket has enough information to proceed with the workflow.

### Step C1: Select Checklist

**For Bug tickets** (type = Bug), check:

| #   | Criteria                                                                     | Status                    |
| --- | ---------------------------------------------------------------------------- | ------------------------- |
| 1   | **Steps to Reproduce** — Clear sequence of actions to trigger the bug        | PRESENT / MISSING / VAGUE |
| 2   | **Expected Behavior** — What should happen                                   | PRESENT / MISSING / VAGUE |
| 3   | **Actual Behavior** — What actually happens (including error messages)       | PRESENT / MISSING / VAGUE |
| 4   | **Environment** — Browser, OS, app version, user role, or server environment | PRESENT / MISSING / VAGUE |
| 5   | **Error Messages / Logs** — Stack traces, console errors, API responses      | PRESENT / MISSING / VAGUE |

**For Feature tickets** (type = Story / Feature / Epic / Task), check:

| #   | Criteria                                                               | Status                    |
| --- | ---------------------------------------------------------------------- | ------------------------- |
| 1   | **Business Context** — Why this feature is needed, problem it solves   | PRESENT / MISSING / VAGUE |
| 2   | **Acceptance Criteria** — Specific, testable conditions for done       | PRESENT / MISSING / VAGUE |
| 3   | **User-Facing Scope** — What the user sees/interacts with              | PRESENT / MISSING / VAGUE |
| 4   | **Technical Constraints** — API requirements, data model, integrations | PRESENT / MISSING / VAGUE |
| 5   | **Out of Scope** — What is explicitly NOT included                     | PRESENT / MISSING / VAGUE |

### Step C2: Classify Completeness

Count PRESENT vs MISSING/VAGUE criteria:

- **SUFFICIENT** (4-5 criteria PRESENT): Proceed directly to the workflow.
- **PARTIAL** (2-3 criteria PRESENT): Ask targeted questions for missing items (max 2 rounds).
- **INSUFFICIENT** (0-1 criteria PRESENT): Ask the user to provide the missing information in a structured format.

### Step C3: Ask Targeted Questions (if PARTIAL or INSUFFICIENT)

For each MISSING or VAGUE criterion, ask the user a specific question. Group questions into a single prompt:

> "The Jira ticket is missing some details I need. Can you help fill in the gaps?
>
> 1. **[Missing criterion]:** [Specific question about it]
> 2. **[Missing criterion]:** [Specific question about it]
>    ..."

**Round limit:** Maximum 2 rounds of questions. If still incomplete after 2 rounds, proceed with what's available and note the gaps.

### Step C4: Construct Enriched Description

Combine ticket data + user answers into a comprehensive description:

**For Bugs:**

```
## Bug Report: {ticket.key} - {ticket.title}

### Steps to Reproduce
{From ticket or user answers}

### Expected Behavior
{From ticket or user answers}

### Actual Behavior
{From ticket or user answers}

### Environment
{From ticket or user answers}

### Error Messages
{From ticket or user answers}

### Additional Context
{From ticket comments and labels}
```

**For Features:**

```
## Feature Request: {ticket.key} - {ticket.title}

### Business Context
{From ticket or user answers}

### Acceptance Criteria
{From ticket or user answers}

### User-Facing Scope
{From ticket or user answers}

### Technical Constraints
{From ticket or user answers}

### Out of Scope
{From ticket or user answers}

### Additional Context
{From ticket comments and labels}
```

This enriched description becomes the `$ARGUMENTS` input for the downstream workflow.

---

## Protocol D: Post-Workflow Jira Update

Update the Jira ticket after the workflow completes successfully.

**IMPORTANT:** Skip this entire protocol if `jira_mode = "manual"`. Instead, display:

> "Jira was in manual mode — no ticket updates were made. You may want to manually transition {ticket.key} to 'In Review' and add a summary comment."

### Step D1: Get Available Transitions

```
mcp__MCP_DOCKER__mcp-exec with:
  name: "atlassian_get_issue_transitions"
  arguments: { issueIdOrKey: "{jira_ticket_key}" }
```

### Step D2: Find and Execute Transition

Search the available transitions for one matching "In Review" (case-insensitive, partial match).

**If "In Review" transition found:**

```
mcp__MCP_DOCKER__mcp-exec with:
  name: "atlassian_transition_issue"
  arguments: {
    issueIdOrKey: "{jira_ticket_key}",
    transitionId: "{matching_transition_id}"
  }
```

Display: `Ticket {ticket.key} transitioned to "In Review".`

**If "In Review" NOT found:**

Present the available transitions and let the user choose:

> "I couldn't find an 'In Review' transition. Available transitions for {ticket.key}:
>
> 1. {transition_1_name}
> 2. {transition_2_name}
> 3. {transition_3_name}
> 4. Skip transition
>
> Which would you like?"

Execute the chosen transition, or skip if requested.

### Step D3: Add Summary Comment

```
mcp__MCP_DOCKER__mcp-exec with:
  name: "atlassian_add_comment"
  arguments: {
    issueIdOrKey: "{jira_ticket_key}",
    body: "{comment_text}"
  }
```

**Comment template for bugs:**

```
*AI-Assisted Bug Fix Summary*

*Root Cause:* {root_cause_summary}
*Fix Applied:* {fix_summary}
*Files Changed:* {file_list}
*Code Review:* Passed
*Browser Verification:* {verified_or_skipped}

_Workflow: /jira-bug-fix — completed {date}_
```

**Comment template for features:**

```
*AI-Assisted Feature Implementation Summary*

*Phases Completed:*
- Discovery: {status}
- User Journeys: {journey_count} documented
- Stories: {story_count} prepared
- Implementation: {files_changed} files changed
- Documentation: {docs_updated}

*Key Deliverables:* {deliverable_summary}
*Code Review:* Passed (Security, Performance, Architecture, Quality)

_Workflow: /jira-feature — completed {date}_
```

### Step D4: Handle Failures

If transition or comment fails:

> "I couldn't update the Jira ticket automatically. Here's what you can do manually:
>
> **Transition:** Move {ticket.key} to "In Review"
> **Comment to add:**
>
> ````
> {comment_text}
> ```"
> ````

Do NOT retry or block the workflow completion over Jira update failures.
