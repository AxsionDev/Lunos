# Bug Fix Workflow

Orchestrate a complete bug investigation and fix cycle for: $ARGUMENTS

## Instructions

Execute this multi-agent debugging workflow sequentially, with human approval gates at critical decision points. This workflow uses specialized clarification, prompt conversion, and parallel research agents before implementation.

---

## Pre-flight: Worktree Reset (FIRST — before any action)

Before anything else, invoke **`Skill(worktree-preflight)`** to reset into a clean task worktree. *(Fallback: read `.claude/skills/worktree-preflight/SKILL.md` and follow it.)* If the user passed an override base branch in `$ARGUMENTS` (e.g. a `--base=<branch>` token), pass it through; otherwise the repo default branch is used. If the project is not a git repository, the skill no-ops and this command proceeds normally.

---

## Pre-Step: Initialize State Management

Before any investigation begins, ensure session state is properly initialized.

### State Directory Check

1. Check if `.agent-state/` directory exists
2. If not, silently run `/state-init` to create the state infrastructure

### Start Bug Fix Session

1. Run `/session-start "Bug fix: $ARGUMENTS"`
2. Note the session ID for reference throughout the workflow

### Resume Check (if applicable)

If the user indicates they're resuming a previous investigation:
- Run `/state-resume` to load previous context
- Display previous session summary
- Ask user where to continue from

---

## Step 0: Project Detection & Environment Setup

> **Parallelism Note:** Project detection (Step 0) can run in the background while Step 1 (Clarification) begins, since detection is silent and doesn't require user input. Launch Step 0 as a background Task or Bash call, then immediately proceed to Step 1.

Before investigation begins, detect the project type and prepare the development environment.

### Detect Project Type

Scan the repository to determine what kind of project this is:

1. **Check for frontend indicators:**
   - `package.json` with `angular`, `react`, `vue`, or similar frameworks
   - `angular.json`, `vite.config.*`, `next.config.*`

2. **Check for backend indicators:**
   - `*.csproj` or `*.sln` files (.NET)
   - `package.json` with `express`, `fastify`, or backend frameworks (Node.js)
   - `requirements.txt`, `pyproject.toml` (Python)

3. **Classify project:**
   - **Frontend-only:** Only frontend indicators found
   - **Backend-only:** Only backend indicators found
   - **Fullstack:** Both frontend and backend present

### Discover Start Commands

Check for existing documentation first:

1. Look for `.claude/docs/project-start.md`
2. Check `README.md` for "Getting Started", "Development", or "Running" sections
3. Search for project documentation in `.claude/docs/`, `.augment/`, `docs/`

**If no documentation exists, auto-generate it:**

Use Glob and Read tools to discover:
- `package.json` → extract `scripts.start`, `scripts.dev`, `scripts.serve`
- `*.csproj` → identify runnable projects
- Detect common patterns (`ng serve`, `npm start`, `dotnet run`)

Create `.claude/docs/project-start.md` using the template at `.claude/docs/templates/project-start.template.md` with discovered values.

### Feature Documentation Lookup

Search for existing feature-level documentation relevant to the bug:

1. **Search `.claude/docs/`** - Glob for `*.md` files matching bug keywords
2. **Search project docs** - Look for `CODE_STRUCTURE.md`, `API_ENDPOINTS.md`, `QUICK_REFERENCE.md` in `.claude/docs/`, `.augment/`, `docs/`
3. **Apply context** - Pass discovered architecture docs to downstream agents (clarifier, reviewers, investigators)

If matching feature docs exist, include them in every agent prompt throughout the workflow.
If no docs found, note the documentation gap and suggest `/discover` after the fix is complete.

### Determine Required Servers

Based on the bug description from `$ARGUMENTS`:

| Bug Type | Frontend Needed | Backend Needed |
|----------|-----------------|----------------|
| UI/styling bug | Yes | Maybe (if data-dependent) |
| JavaScript/TypeScript error | Yes | Maybe (if API-dependent) |
| API endpoint bug | Maybe (for testing) | Yes |
| Database/query bug | No | Yes |
| Integration/data flow | Yes | Yes |

### Start Development Servers

If this bug involves frontend (UI verification needed), start servers in background:

**Frontend (if needed):**
```
Use Bash tool with run_in_background: true
Command: cd {frontend_path} && {start_command}
Expected URL: See PROJECT_STARTUP.md for frontend URL
```

**Backend (if needed):**
```
Use Bash tool with run_in_background: true
Command: cd {backend_path} && {start_command}
Expected URL: See PROJECT_STARTUP.md for backend URL
```

Wait briefly for servers to start, then proceed to Step 1.

---

## Step 1: Issue Clarification

Use the Task tool with `subagent_type="agent-clarifier"` to conduct an interactive clarification session with the user.

### Clarification Process

Provide the initial bug description to the agent:

```
## Issue to Clarify

$ARGUMENTS

### Your Task
1. Analyze this bug description for clarity and completeness
2. Ask targeted questions to understand:
   - Exact symptoms and expected behavior
   - Reproduction steps
   - Environment and context
   - Technology scope (frontend/backend/mixed)
3. Summarize your understanding after each round
4. Continue until the user confirms the summary is accurate
5. Produce the structured JSON output for the next step

Maximum 5 rounds of clarification. If clarity not achieved, proceed with best understanding and note uncertainties.
```

### Approval Gate

The agent-clarifier will present a summary and ask:
**"Does this summary accurately capture the issue? (yes/no/adjust)"**

Wait for explicit user confirmation before proceeding to Step 2.

---

## Step 2: Prompt Generation

Use the Task tool with `subagent_type="to-prompt-converter"` to transform the clarified issue into an AI-optimized investigation prompt.

### Conversion Process

Provide the structured output from Step 1:

```
## Issue to Convert

[Include the full JSON output from agent-clarifier]

### Your Task
Transform this clarified issue into an AI-optimized investigation prompt with:
1. Mission brief and success criteria
2. Issue context and symptom profile
3. Investigation parameters (keywords, file patterns)
4. Research directives for backend and frontend developers
5. Validation criteria for findings

Output a comprehensive markdown prompt ready for the research-orchestrator.
```

### No Approval Gate

Proceed directly to Step 3 (prompt generation is deterministic transformation).

---

## Step 3: Bug Classification & Specialized Analysis

> **Which investigation approach?** This step uses `bug-reviewer-frontend` / `bug-reviewer-backend` for structured parallel analysis. Use `/quick-bugfix` instead if you already know the root cause and just want rapid Alpha/Beta validation. Use `research-orchestrator` only if you need dynamic dispatch (orchestrator decides frontend vs. backend vs. both based on evidence). Default here is direct parallel dispatch — it's the most explicit.

Based on the clarified bug scope from Step 1 and the AI-optimized prompt from Step 2, dispatch specialized bug reviewers for structured analysis.

### Classify Bug Type

Analyze the bug description to determine scope:
- **Frontend-only**: UI bugs, JavaScript errors, styling issues, component state
- **Backend-only**: API errors, database issues, service logic, server errors
- **Mixed/Unclear**: Integration bugs, data flow issues, or unclear root cause

### Dispatch Specialized Bug Reviewers

**If bug involves BOTH frontend and backend (or unclear):**

Launch **both reviewers in parallel** (single message, multiple Task calls):

1. Use the Task tool with `subagent_type="bug-reviewer-frontend"`:
   ```
   ## Frontend Bug Analysis Request

   ### Bug Description
   [Include clarified bug description from Step 1]

   ### Investigation Prompt
   [Include relevant frontend directives from Step 2]

   ### Your Task
   Analyze this bug from a frontend perspective:
   1. Identify affected Angular components, services, templates
   2. Trace user interaction paths
   3. Check for state management issues
   4. Review browser console errors
   5. Identify affected CSS/styling rules if applicable

   Produce a Frontend Bug Analysis Report with:
   - Severity classification
   - Affected files with line numbers
   - Suggested investigation paths
   - Confidence level (High/Medium/Low)
   ```

2. Use the Task tool with `subagent_type="bug-reviewer-backend"`:
   ```
   ## Backend Bug Analysis Request

   ### Bug Description
   [Include clarified bug description from Step 1]

   ### Investigation Prompt
   [Include relevant backend directives from Step 2]

   ### Your Task
   Analyze this bug from a backend perspective:
   1. Identify affected controllers, services, repositories
   2. Trace API request/response flow
   3. Check database query patterns
   4. Review error handling and logging
   5. Identify data integrity issues if applicable

   Produce a Backend Bug Analysis Report with:
   - Severity classification
   - Affected files with line numbers
   - Data flow trace
   - Suggested investigation paths
   - Confidence level (High/Medium/Low)
   ```

**If bug is frontend-only:**

Use only the Task tool with `subagent_type="bug-reviewer-frontend"` (prompt above).

**If bug is backend-only:**

Use only the Task tool with `subagent_type="bug-reviewer-backend"` (prompt above).

### Consolidate Findings

After bug reviewer(s) complete:

1. Merge analysis reports into unified root cause hypothesis
2. Validate findings against quality criteria:
   - **HIGH**: Specific file:line, code snippet, clear relevance (accept)
   - **MEDIUM**: File identified, pattern found, needs verification (accept with note)
   - **LOW**: Speculation without evidence (reject)
3. Present consolidated analysis for user approval

### Approval Gate

Present the consolidated root cause analysis and ask:
**"Root cause identified: [summary]. Approve and proceed to implementation? (yes/no/adjust)"**

Wait for explicit user approval before proceeding to implementation.

---

## Step 4: Implementation

Once the root cause is approved, implement the fix.

Use the Task tool with `subagent_type="fullstack-developer"`, `name="bug-fixer"` with the following prompt:

```
## Bug Fix Implementation Request

### Root Cause (Confirmed)
[Root cause from the research-orchestrator analysis]

### Recommended Fix Direction
[Fix recommendations from the analysis]

### Files to Modify
[File list from the analysis]

### Your Task
1. Implement the fix following KISS principles
2. Make minimal, surgical changes
3. Ensure the fix addresses the root cause without introducing new issues
4. Run the build command from PROJECT_STARTUP.md to verify compilation
5. Document what was changed and why

Follow the existing code patterns in the codebase. Do NOT over-engineer the solution.
```

### After Implementation

Summarize what was changed and ask:

**"Implementation complete. Changes made: [brief summary]. Ready for browser verification? (yes/skip/adjust)"**

- **yes** → Continue to Step 5 (Browser Verification)
- **skip** → Skip to Step 6 (Code Review) - use for backend-only bugs
- **adjust** → Make additional changes

---

## Step 4.5: Pre-Fix Browser Reproduction (MANDATORY for UI Bugs)

> **Workflow Reordering Note:** For UI bugs, the actual execution order is: Step 3 (Root Cause Analysis) → Step 4.5 (Pre-Fix Baseline) → Step 4 (Implementation) → Step 5 (Post-Fix Verification). Capture the broken state BEFORE implementing the fix.

**Skip this step if:** The bug is backend-only with no UI impact. Note: "Pre-fix browser baseline skipped: no UI impact."

This step follows the Reproduce → Fix → Verify workflow. See `_gemini-design-hook.md` "Bug-Fix Browser Workflow" for the canonical protocol.

### Navigate to Bug Location

1. Navigate to the application and follow reproduction steps from Step 1 (Clarification phase)
2. Use Chrome DevTools `navigate_page` (Tier 2) or Playwright `browser_navigate` (Tier 3)

### Capture Pre-Fix Baseline

1. **Screenshot the broken state:**
   ```
   Use mcp__chrome-devtools__take_screenshot
   filename: "bug-pre-fix-baseline.png"
   Purpose: Evidence of the bug BEFORE any fix is applied
   ```

2. **Snapshot the broken DOM:**
   ```
   Use mcp__chrome-devtools__take_snapshot
   Purpose: Capture broken DOM/accessibility tree state
   ```

3. **Record console errors:**
   ```
   Use mcp__chrome-devtools__list_console_messages
   Purpose: Document pre-fix console errors as baseline
   ```

4. **Record network state (if relevant):**
   ```
   Use mcp__chrome-devtools__list_network_requests
   Purpose: Document pre-fix network failures as baseline
   ```

### Pre-Fix Baseline Report

Present to user:

```markdown
## Pre-Fix Baseline Captured

### Bug Location
[How we navigated to the bug]

### Pre-Fix Evidence
- **Screenshot:** bug-pre-fix-baseline.png
- **DOM Snapshot:** [summary of broken state]
- **Console Errors:** [list of errors found, or "none"]
- **Network Failures:** [list of failures found, or "none"]

### Bug Reproduction
- **Reproduced:** Yes / No / Partial
- **Observed Behavior:** [what we saw]
- **Expected Behavior:** [what should happen]
```

### Approval Gate

Ask: **"Pre-fix baseline captured. Bug [reproduced/not reproduced]. Proceed to implementation? (yes/no/adjust)"**

- **yes** → Continue to Step 4 (Implementation)
- **no** → End workflow or adjust approach
- **adjust** → Try different reproduction steps

---

## Step 5: Interactive Browser Verification

> **Parallelism Note:** If the bug is mixed (frontend + backend), browser verification (Step 5) and code review (Step 6) can run in parallel since they examine different aspects of the fix — browser tests verify runtime behavior while code review checks code quality.

**Skip this step if:** The bug is backend-only with no UI impact.

This step uses the three-tier tool hierarchy to verify the fix in the browser.

### UI Tool Hierarchy — Gemini → ChromeDevTools → Playwright

For frontend HTML/SCSS bugs, follow this priority order:

| Tier | Tool | Load Via | Use For |
|------|------|----------|---------|
| **1 (Primary)** | Gemini Design MCP | `ToolSearch: "gemini-design"` | Fix/regenerate HTML, SCSS, visual markup before browser verification |
| **2 (Fallback)** | Chrome DevTools MCP | `ToolSearch: "chrome-devtools"` | Browser verification, DOM inspection, screenshots, console, network |
| **3 (Last Resort)** | Playwright MCP | `ToolSearch: "+playwright browser"` | Full browser interaction when Chrome DevTools is unavailable |

**Escalation:** Try Tier 1 first. If Gemini fails or doesn't apply → use Tier 2. If Chrome DevTools is unavailable → fall back to Tier 3.

See `.claude/agents/_gemini-design-hook.md` for the full protocol.

> **Gemini-First Pattern:** For frontend HTML/SCSS bugs, FIRST try Gemini Design MCP (`modify_frontend`) to fix or regenerate the problematic component code *before* browser verification. This often resolves layout/styling issues more reliably than manual iteration. If Gemini hits a token limit, fall back to manual edits and verify with Chrome DevTools (Tier 2) or Playwright (Tier 3).

> **Tool Loading Order:** Load `ToolSearch: "gemini-design"` first, then `ToolSearch: "chrome-devtools"`, then `ToolSearch: "+playwright browser"` only if needed.

### Pre-Verification Check

If dev servers aren't running from Step 0, start them now:

```
Use Bash tool with run_in_background: true to start required servers
Wait for servers to be available (check with navigate_page)
```

### Initial Navigation

1. Navigate to the application:
   ```
   Use mcp__chrome-devtools__navigate_page
   URL: See PROJECT_STARTUP.md for frontend URL
   ```

2. Take initial snapshot:
   ```
   Use mcp__chrome-devtools__take_snapshot
   Purpose: Capture page state for action references
   ```

### Deep Navigation Protocol

**If the bug is deep in the application** (requires login, specific navigation path, data setup):

#### Guided Navigation Mode

1. **Assess current location:**
   - Take snapshot of current page
   - Identify what action is needed to reach the bug location

2. **For straightforward actions** (visible buttons, links):
   - Use `mcp__chrome-devtools__click` with element ref from snapshot
   - Take new snapshot after action

3. **For actions requiring user knowledge** (credentials, specific data, complex navigation):

   Present to user:
   ```
   I'm currently at [page description from snapshot].

   To reach the bug location, I need to [required action].

   Please choose:
   A) Provide the information I need: [specific request]
   B) Navigate manually in the browser, then tell me when you're ready
   C) Skip browser testing and proceed to code review
   ```

   Wait for user response and proceed accordingly.

4. **Repeat until bug location is reached**

### Post-Fix Verification Against Baseline

Once at the bug location (after fix has been applied in Step 4):

1. **Refresh or re-navigate to trigger the fixed code path:**
   ```
   Use mcp__chrome-devtools__navigate_page
   Or use mcp__chrome-devtools__press_key with "F5" to refresh
   ```

2. **Verify the fix against pre-fix baseline from Step 4.5:**
   - Perform the actions that previously triggered the bug
   - Confirm expected behavior now occurs
   - Compare against the pre-fix baseline evidence

3. **Document the post-fix state:**
   ```
   Use mcp__chrome-devtools__take_screenshot
   filename: "bug-post-fix-verified.png"
   Purpose: Visual proof the fix works — compare against bug-pre-fix-baseline.png
   ```

4. **Capture post-fix console and network state:**
   ```
   Use mcp__chrome-devtools__list_console_messages
   Purpose: Confirm pre-fix console errors are gone

   Use mcp__chrome-devtools__list_network_requests
   Purpose: Confirm pre-fix network failures are resolved
   ```

### Verification Report

Present to user:

```markdown
## Browser Verification Results

### Navigation Path
[How we got to the bug location]

### Pre-Fix Baseline (from Step 4.5)
- **Screenshot:** bug-pre-fix-baseline.png
- **DOM State:** [summary of broken state]
- **Console Errors:** [errors captured before fix]
- **Network Failures:** [failures captured before fix]

### Post-Fix State
- **Screenshot:** bug-post-fix-verified.png
- **DOM State:** [summary of fixed state]
- **Console Errors:** [errors after fix, or "none"]
- **Network Failures:** [failures after fix, or "none"]

### Before/After Comparison
| Aspect | Pre-Fix (Baseline) | Post-Fix (Verified) |
|--------|-------------------|---------------------|
| Visual state | [broken description] | [fixed description] |
| Console errors | [N errors] | [0 errors] |
| Network failures | [N failures] | [0 failures] |
| **Verdict** | **Bug present** | **Bug resolved** |

### Verdict
- [ ] FIX VERIFIED - Bug no longer reproduces, before/after comparison confirms resolution
- [ ] FIX PARTIAL - Some aspects still broken (see comparison)
- [ ] COULD NOT VERIFY - Unable to reach bug location
```

### Approval Gate

Ask: **"Browser verification complete. Proceed to code review? (yes/no/re-test)"**

- **yes** → Continue to Step 6
- **no** → End workflow or return to implementation
- **re-test** → Repeat browser verification

---

## Step 6: Code Review Signoff

Use the Task tool with `subagent_type="code-review-signoff"` with the following prompt:

```
## Code Review Request - Bug Fix

### Original Bug
$ARGUMENTS

### Root Cause
[Root cause from research phase]

### Changes Made
[Summary from implementation step]

### Your Task
1. Review all code changes made to fix this bug
2. Verify the fix addresses the root cause
3. Check for potential regressions or side effects
4. Ensure changes follow project patterns and CLAUDE.md guidelines
5. Provide APPROVED or CHANGES REQUESTED verdict

Pay special attention to:
- Does this fix actually solve the problem?
- Are there any edge cases not handled?
- Could this introduce new bugs?
```

### If CHANGES REQUESTED

Use **SendMessage** to re-engage the developer with specific feedback without losing context:

```
SendMessage(to: "bug-fixer", message: "Code review feedback:\n\n[specific issues from reviewer]\n\nPlease address and re-verify the build.")
```

If the agent session has expired, re-launch the Task tool with original context + review feedback. Return to Step 5 for browser re-verification after fixes.

### If APPROVED

Announce: **"Bug fix complete and approved! The fix has passed code review."**

---

## Step 7: Completion Summary

Provide a final summary of the entire workflow:

```markdown
## Bug Fix Complete

### Original Issue
$ARGUMENTS

### Clarification Summary
- Rounds of clarification: [N]
- User confirmed understanding: Yes

### Root Cause Identified
[What was causing the bug]

### Research Process
- Backend findings: [summary]
- Frontend findings: [summary]
- Confidence level: [High/Medium]

### Solution Implemented
[What was done to fix it]

### Files Changed
| File | Change |
|------|--------|
| [file] | [what changed] |

### Browser Verification
- **Status:** [VERIFIED / SKIPPED / PARTIAL]
- **Pre-Fix Baseline:** bug-pre-fix-baseline.png (from Step 4.5)
- **Post-Fix Verified:** bug-post-fix-verified.png (from Step 5)
- **Before/After Comparison:** [Summary of visual/console/network changes]
- **Notes:** [Any observations from browser testing]

### Review Outcome
[APPROVED by code-review-signoff]

### Testing Recommendations
[What should be tested to verify the fix]
```

---

## Step 8: Session Closure & Handoff

Finalize the bug fix session for state persistence and future reference.

### Compress Session Context

1. Run `/compact` to compress the full session context into a summary
2. This preserves key decisions and findings for future reference

### Generate Handoff Document

1. Run `/handoff` to create a structured handoff document
2. This captures:
   - Original bug description
   - Root cause analysis
   - Solution implemented
   - Files changed
   - Testing recommendations

### Log Decision to State

Use the Task tool with `subagent_type="state-manager"`:

```
## Decision Log Request

### Decision Details
- Type: bug-fix-complete
- Bug: $ARGUMENTS
- Root cause: [Summary from Step 3]
- Solution: [Summary from Step 4]
- Files changed: [List from Step 7]
- Review status: APPROVED

### Your Task
1. Log this bug fix decision to decisions.yaml
2. Mark the session tasks as complete
3. Update session status to "completed"
```

### Display Session Summary

Run `/session-status` to display:
- Session duration
- Investigation phases completed
- Files analyzed and modified
- Decisions logged

### Final Output

```markdown
## Bug Fix Session Complete

**Session ID:** [ID from state-manager]
**Duration:** [Start to end time]

### Artifacts Produced
- ✅ Bug analysis report
- ✅ Implementation complete
- ✅ Code review passed
- ✅ Session context compressed
- ✅ Handoff document generated

### State Files Updated
- `.agent-state/sessions/{session-id}/decisions.yaml`
- `.agent-state/sessions/{session-id}/context.yaml`
- `.agent-state/sessions/{session-id}/handoff.md`

### To Resume or Reference
Future agents can access this bug fix context via:
- `/state-resume {session-id}`
- Read `.agent-state/sessions/{session-id}/handoff.md`
```

---

## Agent Memory

At workflow start, each dispatched agent should consult its `.claude/agent-memory/{agent-name}/MEMORY.md` for prior learnings. At workflow end, agents should persist key insights discovered during this run.

---

## Error Handling

### Vague Bug Description
The agent-clarifier will ask targeted questions to clarify. If still vague after 5 rounds, proceed with uncertainties documented.

### Research Finds No Root Cause
If the research-orchestrator cannot identify a clear root cause:
- Present what was found
- List investigation gaps
- Ask user for additional debugging (logs, environment access, etc.)

### Conflicting Research Findings
If backend and frontend developers identify conflicting root causes:
- Present both with evidence quality
- Let user decide which to pursue

### Build Failures
If the implementation fails to build, automatically loop back with the build errors for the developer agent to address.

### Server Start Failures
If development servers fail to start:
- Check for port conflicts (use `lsof -i :{port}` to identify)
- Verify dependencies are installed (`npm install`, `dotnet restore`)
- Ask user for help if environment-specific issue

### Browser Navigation Issues
If unable to reach the bug location in browser:
- Use Guided Navigation Mode to request user assistance
- Document what was accessible vs. what wasn't
- Offer to skip browser verification if user provides manual testing

### Browser Verification Inconclusive
If browser testing cannot definitively verify the fix:
- Document what was observed
- Note any remaining uncertainty
- Proceed to code review with findings documented
- Recommend specific manual testing scenarios

### Review Rejection
If code review identifies issues, loop back to implementation with the specific feedback.
