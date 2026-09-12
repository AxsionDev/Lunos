# Batch Bugfix Command

Orchestrate batch bug fixing from an unstructured markdown file: **$ARGUMENTS**

## Pre-flight: Worktree Reset (FIRST — before any action)

Before processing any bugs, invoke **`Skill(worktree-preflight)`** once to reset into a clean task worktree for the whole batch. *(Fallback: read `.claude/skills/worktree-preflight/SKILL.md` and follow it.)* If the user passed an override base branch in `$ARGUMENTS` (e.g. a `--base=<branch>` token), pass it through; otherwise the repo default branch is used. If the project is not a git repository, the skill no-ops and this command proceeds normally. The per-bug `/quick-bugfix` and `/bug-fix` calls dispatched below will **detect this worktree and reuse it** — they do not reset between bugs, so each fix accumulates in the same worktree.

---

## Overview

This command takes a markdown file containing multiple bugs in a structured format and orchestrates their systematic fixing using the appropriate fix command for each bug's complexity.

**Input Format Expected:**
```markdown
## bug#1: Login fails intermittently
Users report that login sometimes fails with a 500 error.

## bug#2: Dashboard loading slow
The dashboard takes 10+ seconds to load.
```

**Command Selection:**
- **Simple bugs** (1-3 files, clear fix) → `/quick-bugfix`
- **Complex bugs** (multi-layer, unknown root cause) → `/bug-fix`

### Tool Hierarchy

Each individual bug dispatched via `/quick-bugfix` or `/bug-fix` inherits the **Gemini → ChromeDevTools → Playwright** three-tier hierarchy for frontend/UI work:

| Tier | Tool | Use For |
|------|------|---------|
| **1 (Primary)** | Gemini Design MCP | Generate/fix HTML, SCSS, visual markup |
| **2 (Fallback)** | Chrome DevTools MCP | Browser verification, DOM inspection, screenshots |
| **3 (Last Resort)** | Playwright MCP | Full browser interaction when Chrome DevTools is unavailable |

See `.claude/agents/_gemini-design-hook.md` for the full protocol.

**Pre-Fix Baseline Requirement:** Each frontend bug must follow the Reproduce → Fix → Verify workflow. Capture a pre-fix baseline (screenshot → `bug-pre-fix-baseline.png`, snapshot, console, network) before applying any fix, then verify and compare against the baseline after the fix. See `_gemini-design-hook.md` "Bug-Fix Browser Workflow" for the full protocol.

---

## Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `PATH` | Required | Path to markdown file containing bugs |
| `--mode` | `manual` | `auto` = minimal gates, `manual` = confirm each bug |
| `--max-retries` | `2` | Retry attempts per failed bug |
| `--skip-verification` | `false` | Skip final verification pass |
| `--start-from` | `1` | Resume from specific bug number |

**Examples:**
```
/batch-bugfix bugs.md
/batch-bugfix bugs.md --mode auto
/batch-bugfix bugs.md --start-from 3
/batch-bugfix bugs.md --max-retries 3 --skip-verification
```

---

## Pre-Step: Initialize State Management

Before any bug fixing begins, ensure session state is properly initialized.

### State Directory Check

1. Check if `.agent-state/` directory exists
2. If not, silently run `/state-init` to create the state infrastructure

### Start Batch Session

1. Run `/session-start "Batch bugfix: $ARGUMENTS"`
2. Note the session ID for reference throughout the workflow

### Documentation Lookup

Before structuring bugs, silently search for project context:

1. **Check `.claude/docs/`** - Glob for `*.md` files to understand feature areas mentioned in bugs
2. **Check project docs** - Look for `CODE_STRUCTURE.md` and `API_ENDPOINTS.md` in `.claude/docs/`, `.augment/`, `docs/`
3. **Pass context to structurer** - Include relevant docs when dispatching the bug-structurer agent

If no docs found, proceed without — but note the gap.

### Create Batch State File

Create `.agent-state/sessions/{session-id}/batch-state.yaml`:

```yaml
version: "1.0"
source_file: "$ARGUMENTS"
mode: "manual"  # or "auto"
max_retries: 2
skip_verification: false
start_from: 1

bugs:
  total: 0
  pending: 0
  in_progress: 0
  fixed: 0
  failed: 0
  skipped: 0
  verified: 0

bug_registry: []
# Will be populated with:
# - id: "BUG-001"
#   original_id: "bug#1"
#   title: "Login fails intermittently"
#   description: "Users report that login sometimes fails with a 500 error."
#   severity: "High"
#   complexity: "simple"  # simple or complex
#   fix_command: "quick-bugfix"  # quick-bugfix or bug-fix
#   status: "pending"  # pending/in_progress/fixed/failed/skipped/verified
#   attempts: 0
#   last_error: null
#   fixed_at: null
#   verified_at: null

current_bug_index: 0
workflow_status: "initializing"  # initializing/structuring/awaiting_approval/fixing/verifying/complete
```

### Resume Check

If `--start-from` is provided or user indicates resuming:
1. Read existing `batch-state.yaml`
2. Display previous progress summary
3. Ask user to confirm resume from specified bug

---

## Step 1: Parse Input File

Read and parse the markdown file from `$ARGUMENTS`.

### File Validation

1. Check file exists at path
2. Verify file is readable
3. Check file has expected format

### Parse Bug Sections

Extract bugs using regex pattern: `## bug#(\d+):\s*(.+)`

For each match:
1. Capture bug number
2. Capture bug title
3. Capture description (text until next `## bug#` or end of file)

### Parsing Output

```markdown
## Parsing Results

**Source file:** $ARGUMENTS
**Bugs found:** [N]

| # | Title | Description (preview) |
|---|-------|----------------------|
| 1 | Login fails intermittently | Users report that login sometimes... |
| 2 | Dashboard loading slow | The dashboard takes 10+ seconds... |
| ... | ... | ... |

Proceed to structure and prioritize these bugs? (yes/no)
```

Wait for user confirmation before proceeding.

---

## Step 2: Structure Bugs

Use the `bug-structurer` agent to analyze, categorize, and prioritize all bugs.

### Launch Bug Structurer

Use the Task tool with `subagent_type="bug-structurer"`:

```
## Batch Bug Structuring Request

### Source
File: $ARGUMENTS

### Raw Bug List
[Include all parsed bugs with their descriptions]

### Your Task
For each bug, analyze and provide:

1. **Severity Classification**: Critical / High / Medium / Low
2. **Complexity Assessment**:
   - Simple (1-3 files, clear fix, use /quick-bugfix)
   - Complex (multi-layer, unknown root cause, use /bug-fix)
3. **Type**: UI/UX, Functional, Performance, Security, Data, Integration
4. **Affected Area**: Which module/component/service
5. **Recommended Fix Command**: quick-bugfix or bug-fix
6. **Dependencies**: Bugs that should be fixed first

### Output Format
Provide a structured report with:
1. Individual bug analysis for each bug
2. Prioritized fixing order (considering severity, dependencies, quick wins)
3. Summary statistics
```

### Update Batch State

After structuring completes, update `batch-state.yaml`:

```yaml
bugs:
  total: [N]
  pending: [N]
  # ... rest stays 0

bug_registry:
  - id: "BUG-001"
    original_id: "bug#1"
    title: "Login fails intermittently"
    description: "Users report that login sometimes fails with a 500 error."
    severity: "High"
    complexity: "complex"
    type: "Functional"
    affected_area: "Authentication"
    fix_command: "bug-fix"
    status: "pending"
    attempts: 0
    priority_order: 1
  # ... more bugs

workflow_status: "awaiting_approval"
```

---

## Step 3: User Approval

Present the structured and prioritized bug queue for user review.

### Present Bug Queue

```markdown
## Bug Queue Ready for Fixing

### Summary
| Metric | Count |
|--------|-------|
| Total Bugs | [N] |
| Critical | [N] |
| High | [N] |
| Medium | [N] |
| Low | [N] |

### Fix Command Distribution
| Command | Count | Bugs |
|---------|-------|------|
| /quick-bugfix | [N] | BUG-001, BUG-003, ... |
| /bug-fix | [N] | BUG-002, BUG-004, ... |

### Prioritized Bug Queue

| Order | ID | Title | Severity | Complexity | Command |
|-------|-----|-------|----------|------------|---------|
| 1 | BUG-002 | API timeout on large requests | Critical | Complex | bug-fix |
| 2 | BUG-001 | Login fails intermittently | High | Complex | bug-fix |
| 3 | BUG-003 | Button alignment off | Low | Simple | quick-bugfix |
| ... | ... | ... | ... | ... | ... |

### Dependencies
- BUG-003 depends on BUG-001 (same authentication module)

---

**Mode:** [manual/auto]

**Options:**
1. **Start** - Begin fixing in the displayed order
2. **Reorder** - Modify the priority order
3. **Skip [ID]** - Skip specific bug(s)
4. **Override [ID] [command]** - Change fix command for a bug
5. **Auto mode** - Switch to auto mode (minimal confirmations)
6. **Cancel** - Abort batch bugfix
```

### Handle User Choice

**Start:** Proceed to Step 4
**Reorder:** Ask for new order, update batch-state.yaml, re-display
**Skip [ID]:** Mark bug as "skipped", update counts, re-display
**Override [ID] [command]:** Update fix_command in batch-state.yaml, re-display
**Auto mode:** Set mode to "auto" in batch-state.yaml, proceed
**Cancel:** Mark workflow as "cancelled", exit

---

## Step 4: Fix Loop

Execute the fix cycle for each bug in priority order.

### Loop Entry

```
workflow_status: "fixing"
```

### For Each Bug (in priority order)

#### 4.1: Pre-Bug Checkpoint (Manual Mode Only)

If mode is `manual`:

```markdown
## Next Bug: [BUG-ID]

**Title:** [Bug title]
**Severity:** [Severity]
**Complexity:** [simple/complex]
**Fix Command:** /[quick-bugfix|bug-fix]

**Description:**
[Full bug description]

**Affected Area:** [Module/Component]

---

**Options:**
1. **Fix** - Execute /[command] for this bug
2. **Skip** - Skip this bug
3. **Override** - Use different fix command
4. **Pause** - Pause batch processing (can resume later)
```

Wait for user choice. If `Pause`, save state and exit with resume instructions.

#### 4.2: Execute Fix Command

Based on complexity, invoke the appropriate command:

**For Simple Bugs (quick-bugfix):**

Use the Skill tool to invoke `/quick-bugfix`:

```
/quick-bugfix [Bug title]: [Bug description]
```

**For Complex Bugs (bug-fix):**

Use the Skill tool to invoke `/bug-fix`:

```
/bug-fix [Bug title]: [Bug description]
```

#### 4.3: Capture Result

After the fix command completes:

**If successful:**
```yaml
bug_registry[index]:
  status: "fixed"
  attempts: [N]
  fixed_at: "[timestamp]"

bugs:
  pending: [N-1]
  fixed: [N+1]
```

**If failed:**
```yaml
bug_registry[index]:
  attempts: [N+1]
  last_error: "[error description]"
```

#### 4.4: Retry Logic

If bug fix failed and `attempts < max_retries`:
1. Log the failure reason
2. Ask user (in manual mode): "Bug fix failed. Retry? (yes/skip/abort)"
3. If retry, go back to 4.2
4. If skip, mark as "failed" and continue
5. If abort, pause workflow

If `attempts >= max_retries`:
```yaml
bug_registry[index]:
  status: "failed"

bugs:
  pending: [N-1]
  failed: [N+1]
```

#### 4.5: Progress Update

After each bug (success or failure), display progress:

```markdown
## Progress Update

**Completed:** [N] of [Total]
**Fixed:** [N] | **Failed:** [N] | **Skipped:** [N]

**Current Bug:** [BUG-ID] - [Status]

**Remaining:** [N] bugs

[Progress bar visualization]
████████░░░░░░░░░░░░ 40% complete
```

### Loop Exit

When all bugs processed, proceed to Step 5.

---

## Step 5: Verification Pass

Re-test all "fixed" bugs to confirm they're actually resolved.

**Skip this step if:** `--skip-verification` flag was provided.

### Verification Protocol

For each bug with status "fixed":

1. **Identify Verification Method:**
   - Unit tests in affected area? → Run them
   - Integration tests? → Run them
   - Manual verification needed? → Note for user

2. **Execute Verification:**
   - Run relevant tests
   - Check for regressions
   - Verify original issue is resolved

3. **Update Status:**

**If verified:**
```yaml
bug_registry[index]:
  status: "verified"
  verified_at: "[timestamp]"

bugs:
  fixed: [N-1]
  verified: [N+1]
```

**If verification failed:**
```yaml
bug_registry[index]:
  status: "failed"
  last_error: "Verification failed: [reason]"

bugs:
  fixed: [N-1]
  failed: [N+1]
```

### Verification Summary

```markdown
## Verification Results

| Bug ID | Title | Verification | Result |
|--------|-------|--------------|--------|
| BUG-001 | Login fails... | Unit tests passed | VERIFIED |
| BUG-002 | API timeout... | Integration test failed | FAILED |
| BUG-003 | Button alignment | Manual check needed | PENDING |

**Verified:** [N]
**Failed Verification:** [N]
**Manual Check Needed:** [N]

Bugs requiring manual verification:
- BUG-003: Check button alignment in browser at /settings page
```

---

## Step 6: Completion

Generate final report and cleanup.

### Final Report

```markdown
## Batch Bugfix Complete

### Source
**File:** $ARGUMENTS
**Session ID:** [session-id]
**Duration:** [start to end time]

### Results Summary

| Status | Count | Bugs |
|--------|-------|------|
| Verified | [N] | BUG-001, BUG-003, ... |
| Fixed (unverified) | [N] | BUG-005, ... |
| Failed | [N] | BUG-002, ... |
| Skipped | [N] | BUG-004, ... |
| **Total** | **[N]** | |

### Success Rate
[N] of [Total] bugs fixed ([X]%)

### Detailed Results

#### Verified Fixes
| Bug ID | Title | Fix Command | Attempts |
|--------|-------|-------------|----------|
| BUG-001 | Login fails... | /bug-fix | 1 |
| ... | ... | ... | ... |

#### Failed Fixes
| Bug ID | Title | Attempts | Last Error |
|--------|-------|----------|------------|
| BUG-002 | API timeout... | 3 | Build failed: ... |
| ... | ... | ... | ... |

#### Skipped Bugs
| Bug ID | Title | Reason |
|--------|-------|--------|
| BUG-004 | Minor typo | User skipped |
| ... | ... | ... |

### Manual Verification Needed
[List any bugs that couldn't be auto-verified]

### Recommendations
1. [Any follow-up actions needed]
2. [Bugs that may need re-attempt]
3. [Related issues discovered]
```

### Session Cleanup

1. Run `/compact` to compress the session context
2. Run `/handoff` to create a handoff document

### Update Final State

```yaml
workflow_status: "complete"
completed_at: "[timestamp]"

bugs:
  total: [N]
  pending: 0
  in_progress: 0
  fixed: [N]
  failed: [N]
  skipped: [N]
  verified: [N]
```

### Final Output

```markdown
## Batch Bugfix Session Complete

**Session ID:** [ID]
**State file:** .agent-state/sessions/[session-id]/batch-state.yaml
**Handoff:** .agent-state/sessions/[session-id]/handoff.md

### Quick Stats
- **Success Rate:** [X]%
- **Verified:** [N] bugs
- **Failed:** [N] bugs
- **Skipped:** [N] bugs

### To Resume Failed Bugs
```
/batch-bugfix $ARGUMENTS --start-from [first-failed-bug-number]
```

### To Review Session
```
/session-status
```
```

---

## Agent Memory

At workflow start, each dispatched agent should consult its `.claude/agent-memory/{agent-name}/MEMORY.md` for prior learnings. At workflow end, agents should persist key insights discovered during this run.

---

## Error Handling

### File Not Found
```
Error: Bug file not found at: $ARGUMENTS

Please provide a valid path to a markdown file containing bugs.
Expected format:
## bug#1: Bug title
Bug description here.
```

### No Bugs Found
```
Error: No bugs found in file.

Expected format:
## bug#1: Bug title
Bug description...

## bug#2: Another bug
Another description...
```

### Invalid Bug Format
If some bugs don't match the expected format:
- Log warning
- Ask user if they want to proceed with valid bugs only
- Show which entries were skipped

### Fix Command Failure
- Capture error output
- Update bug status with error
- Check retry count
- In manual mode, ask user how to proceed
- In auto mode, mark as failed and continue

### Session Interruption
If the session is interrupted:
- State is preserved in batch-state.yaml
- User can resume with: `/batch-bugfix $ARGUMENTS --start-from [N]`
- Or run `/state-resume` to see previous session

### Build/Test Failures During Fix
If build or tests fail during a bug fix:
- The underlying `/bug-fix` or `/quick-bugfix` command handles this
- Result is captured and recorded in batch state
- Proceeds to next bug (or retries if configured)

---

## State File Reference

### batch-state.yaml Structure

```yaml
version: "1.0"
source_file: "bugs.md"
mode: "manual"
max_retries: 2
skip_verification: false
start_from: 1

bugs:
  total: 5
  pending: 0
  in_progress: 0
  fixed: 3
  failed: 1
  skipped: 1
  verified: 3

bug_registry:
  - id: "BUG-001"
    original_id: "bug#1"
    title: "Login fails intermittently"
    description: "Users report that login sometimes fails with a 500 error."
    severity: "High"
    complexity: "complex"
    type: "Functional"
    affected_area: "Authentication"
    fix_command: "bug-fix"
    status: "verified"
    attempts: 1
    priority_order: 2
    fixed_at: "2026-02-05T10:30:00Z"
    verified_at: "2026-02-05T10:45:00Z"
    last_error: null

  - id: "BUG-002"
    original_id: "bug#2"
    title: "API timeout on large requests"
    description: "Requests with more than 100 items timeout."
    severity: "Critical"
    complexity: "complex"
    type: "Performance"
    affected_area: "API Layer"
    fix_command: "bug-fix"
    status: "failed"
    attempts: 3
    priority_order: 1
    fixed_at: null
    verified_at: null
    last_error: "Build failed: Missing dependency in service layer"

current_bug_index: 5
workflow_status: "complete"
started_at: "2026-02-05T09:00:00Z"
completed_at: "2026-02-05T11:00:00Z"
```

---

## Comparison: /batch-bugfix vs Individual Commands

| Aspect | /batch-bugfix | /bug-fix | /quick-bugfix |
|--------|---------------|----------|---------------|
| **Input** | Markdown file with multiple bugs | Single bug description | Single bug description |
| **Orchestration** | Batch with state tracking | Single workflow | Single workflow |
| **Command Selection** | Auto-selects per bug | Full workflow | Streamlined workflow |
| **Approval Gates** | Per-batch + per-bug (manual) | 4 gates | 1 gate |
| **State Persistence** | Full batch state | Session state | Session state |
| **Resume Support** | `--start-from N` | `/state-resume` | `/state-resume` |
| **Verification** | Batch verification pass | Per-bug | Per-bug |
| **Best For** | Multiple known bugs | Single complex bug | Single simple bug |
