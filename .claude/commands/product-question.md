# Product/Customer Question Command

Answer a product or customer question that needs code-level investigation, not just business knowledge: $ARGUMENTS

## Overview

```
Step 1: Investigate  →  Step 2: Answer  →  Step 3: Classify  →  Step 4: Draft & Confirm  →  Step 5: Create Ticket
```

The answer is always the primary deliverable. Ticket creation is a possible *consequence* of the investigation, not an alternative path — a single question can be answered AND reveal a bug, a missing feature, both, or neither.

## MCP Note

This command creates Jira issues, which `.claude/commands/_jira-protocol.md` (Protocols A–D) does not cover — that protocol only fetches/updates existing tickets via `mcp__MCP_DOCKER__mcp-exec`. This command instead uses `mcp__claude_ai_Atlassian_Rovo__*` tools directly, which expose the create-issue verbs needed here and were confirmed live in this environment. This is a deliberate, documented divergence from the `mcp-exec` convention used by `/jira-bug-fix` and `/jira-feature` — not an oversight.

---

## Step 1: Investigate

Invoke **`Skill(research-mode)`** to gather code evidence for the question. *(Fallback: read `.claude/skills/research-mode/SKILL.md` and follow it.)* This is read-only — no code changes.

1. Search the codebase (Glob/Grep) for the area the question touches.
2. Trace the relevant flow (controller → service → repository, or component → service → API).
3. Check `.claude/docs/` and `.augment/` for existing documentation that already answers part of the question.
4. Collect evidence citing `file:line` for every claim — this evidence backs both the answer and any ticket drafted later.

---

## Step 2: Answer the Question

Write a direct answer to the user's question, grounded in the evidence from Step 1. Cite `file:line` for factual claims about how the code behaves. Keep it in plain language a product/customer stakeholder can follow — technical detail supports the answer, it isn't the answer.

Always deliver this answer, regardless of what Step 3 concludes.

---

## Step 3: Classify the Finding

Based on the investigation, classify what was found. More than one can apply — don't force a single exclusive bucket:

| Classification | Signal |
|---|---|
| **Bug** | Code exists for this behavior, but it doesn't do what it's supposed to — contradicts documented/expected behavior, throws, or produces wrong output. |
| **Missing feature** | No code exists for what's being asked; the capability genuinely isn't there. |
| **Neither** | The question is answerable as-is — behavior is correct/by-design, or it's a pure business/process question with no code gap. |

If **neither**, stop here — no ticket needed.

If **bug** and/or **missing feature**, continue to Step 4 for each finding.

---

## Step 4: Draft & Confirm (per finding)

Creating a Jira issue is outward-facing and hard to reverse — colleagues on a shared board will see it. Never call `createJiraIssue` without explicit user confirmation.

### 4a: Resolve the Active Board

Resolve cheapest path first:

1. If `$ARGUMENTS` contains an explicit `--project=KEY` token, use it.
2. Else call `getVisibleJiraProjects` (via `mcp__claude_ai_Atlassian_Rovo__getVisibleJiraProjects`, resolving `cloudId` via `getAccessibleAtlassianResources` if not already known this session). If exactly one project is visible, use it.
3. Else list the visible projects (key + name) and ask the user which board is active. Suggest they pass `--project=KEY` next time to skip this.

### 4b: Resolve the Issue Type

Do NOT hardcode `"Bug"` or `"Story"` — issue type names vary by project (e.g. some projects use `Feature` or `Task` instead of `Story`; service-desk projects may not have either).

1. Call `getJiraProjectIssueTypesMetadata` for the resolved project.
2. Map the classification to the best-matching type name present: bug → `Bug` (or `Defect`); missing feature → `Story` (or `Feature`, `Task`).
3. If no reasonable match exists, show the available issue types and ask the user to pick.
4. Call `getJiraIssueTypeMetaWithFields` for the chosen type to confirm required fields before drafting.

### 4c: Duplicate Check

Call `searchJiraIssuesUsingJql` scoped to the resolved project (e.g. `project = KEY AND status != Done ORDER BY created DESC`) with keywords from the finding. If similar open issues turn up, show them ("N similar open issues found") — this is the most likely way this command embarrasses the user by filing a dupe on a live board.

### 4d: Draft the Ticket

Present the full draft for confirmation:

```markdown
## Proposed {Bug | Story} — {project.key}

**Summary:** {concise title}

**Description:**
{problem/gap statement in business terms}

**Evidence:**
{file:line citations from Step 1}

**Similar existing issues:** {list from 4c, or "None found"}
```

> "Create this {issue type} on **{project.key} — {project.name}**? (yes / edit / skip)"

Wait for explicit confirmation. If "edit", incorporate feedback and re-present. If "skip", do not create — move to the next finding or finish.

---

## Step 5: Create the Ticket

On confirmation, call `createJiraIssue` (`mcp__claude_ai_Atlassian_Rovo__createJiraIssue`) with the confirmed project, issue type, summary, and description from the draft.

On success, report the created issue key and a link (`{cloudUrl}/browse/{key}`).

On failure, show the draft content so the user can file it manually, and don't retry silently.

Repeat Step 4–5 for each additional finding from Step 3.

---

## Error Handling

- **Rovo/Atlassian MCP unavailable:** Still deliver the Step 2 answer. Tell the user ticket creation is unavailable and give them the draft(s) from Step 4d to file manually.
- **No projects visible / access denied:** Same as above — deliver the answer, surface the access problem, don't block on it.
- **Ambiguous classification:** If it's unclear whether something is a bug vs. a missing feature, ask the user rather than guessing — filing the wrong issue type is worse than a clarifying question.

---

## Quick Reference

```
/product-question Why can't a customer see their invoice history from last year?
/product-question --project=SCRUM Can users export their wallet transactions to CSV?
```
