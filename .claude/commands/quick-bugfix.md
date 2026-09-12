# Quick Bugfix Command

Execute a rapid bug fix for: $ARGUMENTS

## Instructions

This is a streamlined workflow for **small, known issues** where the problem is already understood. It uses rapid Alpha/Beta validation to confirm the fix direction before implementation.

**Use this when:**
- You already know what the bug is
- The issue is small/localized (1-3 files)
- You have a clear hypothesis or fix in mind

**Use `/bug-fix` instead when:**
- Issue is vague or unclear
- Root cause is unknown
- Multiple systems/layers are affected

---

## Pre-flight: Worktree Reset (FIRST — before any action)

Before anything else, invoke **`Skill(worktree-preflight)`** to reset into a clean task worktree. *(Fallback: read `.claude/skills/worktree-preflight/SKILL.md` and follow it.)* If the user passed an override base branch in `$ARGUMENTS` (e.g. a `--base=<branch>` token), pass it through; otherwise the repo default branch is used. If the project is not a git repository, the skill no-ops and this command proceeds normally. (When invoked from `/batch-bugfix`, the worktree already exists and is reused — it is not reset per bug.)

---

## Pre-Step: Initialize State Management

Before any investigation begins, ensure session state is properly initialized.

### State Directory Check

1. Check if `.agent-state/` directory exists
2. If not, silently run `/state-init` to create the state infrastructure

### Start Quick Bugfix Session

1. Run `/session-start "Quick fix: $ARGUMENTS"`
2. Note the session ID for reference throughout the workflow

### Resume Check

If user indicates resuming a previous investigation:
- Run `/state-resume` to load previous context
- Display previous session summary
- Ask user where to continue from

---

## Step 0: Project Detection & Environment Setup (Quick)

Rapidly detect project type and prepare environment for verification.

### Quick Detection

1. **Check for `package.json`** → Frontend exists (Angular/React/Vue)
2. **Check for `*.csproj` or `*.sln`** → Backend exists (.NET)
3. **Classify:** Frontend-only / Backend-only / Fullstack

### Start Commands Discovery

Check (in order):
1. `.claude/docs/project-start.md` (if exists, use it)
2. `package.json` scripts → look for `start`, `dev`, `serve`
3. `.csproj` files → use `dotnet run` (or see PROJECT_STARTUP.md)

**If no project-start.md exists:** Create one using `.claude/docs/templates/project-start.template.md` with discovered values.

### Documentation Lookup

Before investigating, silently search for relevant context:

1. **Check `.claude/docs/`** - Glob for `*.md` files related to the bug area
2. **Check project docs** - Look for `CODE_STRUCTURE.md` and `API_ENDPOINTS.md` in `.claude/docs/`, `.augment/`, `docs/`
3. **Pass context to agents** - Include relevant docs in Alpha/Beta task prompts

If no docs found, proceed without — but note the gap.

### Start Servers (If Frontend Bug)

If the bug description suggests UI/frontend involvement:

```
Frontend: Bash tool with run_in_background: true
  Command: Use start command from PROJECT_STARTUP.md
  URL: Use frontend URL from PROJECT_STARTUP.md

Backend (if needed): Bash tool with run_in_background: true
  Command: Use start command from PROJECT_STARTUP.md
  URL: Use backend URL from PROJECT_STARTUP.md
```

Proceed immediately to Step 1 (servers will start in background).

---

## Step 1: Rapid Alpha/Beta Analysis

Perform a quick dual-perspective validation using the bug-investigator agents IN PARALLEL.

### Launch Parallel Analysis

> **Workspace Enhancement:** Alpha and Beta agents can write findings to `.agent-workspace/quick-bugfix-{timestamp}/outputs/` for the consolidation step to read structured artifacts instead of parsing prose. Create the workspace directory before launching agents:
> ```bash
> mkdir -p .agent-workspace/quick-bugfix-$(date +%Y%m%d-%H%M%S)/outputs
> ```
> Pass the workspace path to both agents. If Alpha finishes first, Beta can read Alpha's structured output from the workspace for better-informed counter-analysis.

Use the Task tool to launch BOTH agents in a SINGLE message (parallel execution):

**Alpha Task** (`subagent_type="bug-investigator-alpha"`):
```
## Quick Analysis Request

**Issue:** $ARGUMENTS

### Your Task (RAPID MODE - 2 minutes max)
1. Locate the suspected code area quickly
2. Verify the hypothesis with code evidence
3. Identify exact fix location (file:line)
4. Flag any concerns or complications

This is a QUICK analysis - focus on confirming/denying the suspected issue.
Do NOT do extensive investigation. The user believes they know the root cause.

Output a brief report:
- Root cause: CONFIRMED/ADJUSTED/UNCONFIRMED
- Fix location: file:line
- Evidence: Brief code snippet or explanation
- Concerns: Any complications discovered
```

**Beta Task** (`subagent_type="bug-investigator-beta"`):
```
## Quick Validation Request

**Issue:** $ARGUMENTS

### Your Task (RAPID MODE - 2 minutes max)
1. Challenge the hypothesis - is there a simpler explanation?
2. Check for side effects in related code
3. Verify no obvious edge cases are missed
4. Confirm or counter the fix approach

This is a QUICK validation - focus on catching obvious problems.
Do NOT do extensive counter-investigation.

Output a brief report:
- Alpha's approach: AGREE/DISAGREE/PARTIAL
- Alternative explanation: [if any]
- Side effects: [if any found]
- Edge cases: [any missed]
```

### Present Consensus

After both agents complete, present the combined findings:

```markdown
## Quick Analysis Summary

**Issue:** [One-line description]
**Root Cause:** [Confirmed/Adjusted with evidence]
**Fix Location:** `[file:line]`
**Fix Approach:** [Brief description of the change]

### Alpha/Beta Consensus
- **Alpha says:** [brief finding]
- **Beta says:** [brief finding]
- **Verdict:** AGREE / DISAGREE

[If DISAGREE: Present both perspectives for user decision]

### Risk Assessment
- **Risk Level:** LOW / MEDIUM
- **Files Affected:** [count]
- **Estimated Impact:** [scope description]
```

### Approval Gate

Ask: **"Proceed with this fix? (yes/no/investigate-more)"**

- **yes** → Continue to Step 2
- **no** → End workflow
- **investigate-more** → Escalate to `/bug-fix` workflow

---

## Step 1.5: Pre-Fix Browser Reproduction (MANDATORY for UI Bugs)

**Skip this step if:** The bug is backend-only with no UI impact. Note: "Pre-fix browser baseline skipped: no UI impact."

This step follows the Reproduce → Fix → Verify workflow. See `_gemini-design-hook.md` "Bug-Fix Browser Workflow" for the canonical protocol.

### Capture Pre-Fix Baseline

Before implementing any fix, capture the broken state as evidence:

1. **Navigate** to the bug location using Chrome DevTools `navigate_page` (Tier 2) or Playwright `browser_navigate` (Tier 3)
2. **Screenshot** the broken state → save as `bug-pre-fix-baseline.png`
3. **Snapshot** the broken DOM state
4. **Console errors** — record pre-fix errors as baseline
5. **Network state** (if relevant) — record pre-fix failures as baseline

### Document Baseline

```markdown
## Pre-Fix Baseline
- **Screenshot:** bug-pre-fix-baseline.png
- **Bug reproduced:** Yes / No / Partial
- **Console errors:** [list or "none"]
- **Network failures:** [list or "none"]
```

If the bug cannot be reproduced in the browser, note this and proceed with the fix anyway.

---

## Step 2: Implement Fix

Use the Task tool with `subagent_type="fullstack-developer"`, `name="quick-fix-dev"`:

```
## Quick Bug Fix Implementation

### Issue
$ARGUMENTS

### Confirmed Root Cause
[Root cause from Step 1]

### Fix Location
[file:line from Step 1]

### Fix Approach
[Approach from Step 1]

### Your Task
1. Make the code change - MINIMAL and FOCUSED
2. Only modify what's necessary to fix the bug
3. Do NOT refactor surrounding code
4. Do NOT add "improvements" beyond the fix
5. Preserve existing code style

After implementation, run:
- Backend: Run the build command from PROJECT_STARTUP.md
- Frontend: Verify TypeScript compiles
```

---

## Step 3: Verification & Completion

After implementation, verify and summarize:

1. **Build Check:** Run relevant build command
2. **Quick Test:** If unit tests exist for the affected area, run them
3. **Browser Verification:** (If frontend bug) Verify fix in browser
4. **Summary:** Present what was changed

### Browser Verification (If Frontend Bug)

**Skip if:** Bug is backend-only with no UI impact.

### UI Tool Hierarchy — Gemini → ChromeDevTools → Playwright

For frontend HTML/SCSS bugs, follow this priority order:

| Tier | Tool | Load Via | Use For |
|------|------|----------|---------|
| **1 (Primary)** | Gemini Design MCP | `ToolSearch: "gemini-design"` | Fix/regenerate HTML, SCSS, visual markup before verification |
| **2 (Fallback)** | Chrome DevTools MCP | `ToolSearch: "chrome-devtools"` | Browser verification, DOM inspection, screenshots |
| **3 (Last Resort)** | Playwright MCP | `ToolSearch: "+playwright browser"` | Full browser interaction when Chrome DevTools is unavailable |

**Escalation:** Try Tier 1 first. If Gemini fails or doesn't apply → use Tier 2. If Chrome DevTools is unavailable → fall back to Tier 3.

See `.claude/agents/_gemini-design-hook.md` for the full protocol.

> **Gemini-First Pattern:** For HTML/SCSS bugs, FIRST try Gemini Design MCP (`modify_frontend`) to fix or regenerate the problematic code before verifying in browser. If Gemini hits a token limit, fall back to Chrome DevTools (Tier 2) or Playwright (Tier 3).

> **Tool Loading Order:** Load `ToolSearch: "gemini-design"` first, then `ToolSearch: "chrome-devtools"`, then `ToolSearch: "+playwright browser"` only if needed.

#### Quick Browser Test Protocol

1. **Navigate to application:**
   ```
   Use mcp__chrome-devtools__navigate_page
   URL: Use frontend URL from PROJECT_STARTUP.md (or detected URL)
   ```

2. **Take snapshot for element references:**
   ```
   Use mcp__chrome-devtools__take_snapshot
   ```

3. **Navigate to bug location:**
   - For simple navigation: use `mcp__chrome-devtools__click` with refs from snapshot
   - For complex navigation (login, deep menus): Use **Guided Navigation Mode**

#### Guided Navigation Mode

If the bug is deep in the app:

```
Present to user:
"I'm at [current page]. To verify the fix, I need to reach [target].

Options:
A) Tell me credentials/data to use
B) Navigate manually, tell me when ready
C) Skip browser verification"
```

4. **Verify fix + compare against baseline:**
   - Attempt to reproduce the original bug
   - Confirm expected behavior now occurs
   - Take screenshot → `bug-post-fix-verified.png`
   - Compare against `bug-pre-fix-baseline.png` from Step 1.5
   - Confirm pre-fix console errors and network failures are resolved

5. **Report result:**
   - **VERIFIED:** Bug no longer reproduces
   - **PARTIAL:** Some aspects still broken
   - **SKIPPED:** Could not verify in browser

### Completion Output

```markdown
## Quick Fix Complete

### Original Issue
$ARGUMENTS

### Root Cause
[What was causing the bug]

### Fix Applied
| File | Line | Change |
|------|------|--------|
| [file] | [line] | [brief description] |

### Verification
- **Build:** PASS / FAIL
- **Tests:** PASS / FAIL / SKIPPED (no tests in affected area)
- **Browser:** VERIFIED / PARTIAL / SKIPPED
  - Pre-Fix Baseline: bug-pre-fix-baseline.png (from Step 1.5)
  - Post-Fix Verified: bug-post-fix-verified.png
  - Before/After Comparison: [Summary of changes]

### Manual Test Recommendation
[Specific scenario to verify the fix works]
```

---

## Step 4: Session Closure

Finalize the quick bugfix session for state persistence and future reference.

### Compress Session Context

1. Run `/compact` to compress the session context
2. This preserves key decisions and findings for future reference

### Generate Handoff Document

1. Run `/handoff` to create a structured handoff document
2. This captures:
   - Original bug description
   - Root cause confirmed
   - Solution implemented
   - Files changed
   - Verification results

### Log Completion to Session State

Update session state with completion:
- Mark session status as "completed"
- Log bug fix decision to decisions.yaml
- Record files modified

### Display Session Summary

Run `/session-status` to display:
- Session duration
- Investigation phases completed
- Files analyzed and modified
- Decisions logged

---

## Error Handling

| Situation | Action |
|-----------|--------|
| **Alpha/Beta disagree** | Present both perspectives, let user decide |
| **Hypothesis was wrong** | Ask: "Root cause not confirmed. Escalate to /bug-fix? (yes/no)" |
| **Larger scope discovered** | Ask: "Issue is bigger than expected. Continue or escalate to /bug-fix?" |
| **Build fails** | Show error, fix compilation issue, re-verify |
| **Tests fail** | Show failures, ask user how to proceed |
| **Server won't start** | Check port conflicts, show error, ask user to resolve |
| **Browser can't connect** | Verify server is running, check URL, retry or skip browser test |
| **Can't navigate to bug location** | Use Guided Navigation Mode, ask user for help |
| **Browser verification inconclusive** | Note in summary, recommend manual testing |

---

## Comparison: /quick-bugfix vs /bug-fix

| Aspect | /quick-bugfix | /bug-fix |
|--------|---------------|----------|
| **Steps** | 5 (Pre-Step + Steps 0-4) | 9 (Pre-Step + Steps 0-8) |
| **Approval gates** | 1 | 4 |
| **Session tracking** | Full (same as /bug-fix) | Full |
| **Project detection** | Quick scan | Full detection + doc generation |
| **Clarification** | Skip (user knows issue) | Full dialogue |
| **Investigation** | Rapid Alpha/Beta (parallel) | Sequential with prompt conversion |
| **Browser testing** | Integrated in verification | Dedicated step with screenshots |
| **Code review** | Skip | Full review |
| **Session closure** | Yes (compact + handoff) | Yes (compact + handoff) |
| **Best for** | Known, small issues | Unknown, complex issues |

> **Memory**: Agents should consult and update their `.claude/agent-memory/` between sessions.
