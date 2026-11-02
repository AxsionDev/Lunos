# User Journey Analysis Workflow

Analyze documentation and extract comprehensive user journey documentation for: **$ARGUMENTS**

## Overview

This workflow uses the `user-journey-analyst` agent to systematically extract, categorize, and document all user journeys from existing discovery documentation.

---

## Step 1: Documentation Inventory

**First, catalog available documentation:**

1. Search for documentation files:

   ```
   Glob: ".claude/docs/*.md"
   ```

2. For each documentation file found:
   - Note the feature/module covered
   - Assess documentation completeness
   - Identify sections relevant to user interactions

3. Report findings in this format:

   ```markdown
   ## Documentation Inventory

   | File                | Feature/Module        | Completeness | Journey Relevance      |
   | ------------------- | --------------------- | ------------ | ---------------------- |
   | wetrack-overview.md | System Overview       | High         | Context only           |
   | wetrack-backend.md  | Backend Architecture  | High         | Technical reference    |
   | wetrack-frontend.md | Frontend Architecture | High         | Technical reference    |
   | {feature}.md        | {Feature Name}        | {Level}      | {Journey-rich/Limited} |

   **Target for Analysis:** $ARGUMENTS
   **Primary Sources:** [List relevant docs]
   ```

**If no relevant documentation exists:**

```markdown
No documentation found for "$ARGUMENTS".

**Recommended Action:**
Run `/discover $ARGUMENTS` first to generate discovery documentation, then re-run `/user-journeys`.
```

---

## Step 2: Launch Journey Analysis

Use the Task tool with `subagent_type="user-journey-analyst"`:

Provide the agent with:

- Target scope: $ARGUMENTS
- Documentation sources from Step 1
- Instructions to extract ALL user journeys
- Request for structured output following the agent's template

The agent will:

1. Read all relevant documentation from `.claude/docs/`
2. Extract ALL user journeys for the specified scope
3. Categorize by actor type (End User, Staff, Admin, System, External)
4. Identify gaps and prepare clarifying questions
5. Produce structured journey documentation

---

## Step 3: Interactive Clarification

The agent will identify gaps and ask clarifying questions. For each set of questions:

1. **Present Questions to User**

   ```markdown
   ## Clarification Needed

   The following gaps were identified during journey analysis:

   ### Gap 1: [Description]

   [Agent's question]

   ### Gap 2: [Description]

   [Agent's question]

   Please provide answers or indicate if these should be marked as "Unknown/TBD".
   ```

2. **Collect Responses**
   - Wait for user input
   - Record responses for incorporation into documentation

3. **Continue Analysis**
   - Feed responses back to agent
   - Repeat until all critical gaps are addressed or marked as TBD

---

## Step 4: Journey Documentation Generation

After clarification is complete, the agent produces:

1. **Journey Documentation File**
   - Saved to: `.claude/docs/{feature-name}-user-journeys.md`
   - Contains all identified journeys organized by actor type
   - Includes resolved and unresolved gaps
   - Provides agent implementation notes

2. **Summary Report**

   ```markdown
   ## User Journey Analysis Complete

   ### Output

   **Documentation saved to:** `.claude/docs/{feature-name}-user-journeys.md`

   ### Summary

   | Metric                        | Count |
   | ----------------------------- | ----- |
   | Total Journeys                | [N]   |
   | End User Journeys             | [N]   |
   | Staff User Journeys           | [N]   |
   | Admin Journeys                | [N]   |
   | System Journeys               | [N]   |
   | External Integration Journeys | [N]   |
   | Resolved Gaps                 | [N]   |
   | Unresolved Gaps               | [N]   |

   ### Critical Journeys (Prioritize for Development)

   1. [Journey ID]: [Journey Title]
   2. [Journey ID]: [Journey Title]

   ### Unresolved Gaps (Require Future Clarification)

   1. [GAP-ID]: [Brief description]
   ```

---

## Step 5: Interactive Journey Review (MANDATORY)

**After generating journeys, present each journey summary to the user for review.**

This step ensures the user can validate, adjust, or add to the journeys before finalization.

### 5.1 Present Journey Summaries by Actor Type

For each actor type, present a condensed summary table:

```markdown
## Journey Review: End User Journeys (7 total)

| ID       | Journey                   | Trigger                  | Key Steps                                  | Needs Review? |
| -------- | ------------------------- | ------------------------ | ------------------------------------------ | ------------- |
| EUSR-001 | Scan Location QR & Submit | Patron scans QR          | Scan → Form → Submit → SMS                 |               |
| EUSR-002 | Scan Category QR & Submit | Patron scans category QR | Scan → Form (category pre-filled) → Submit |               |
| EUSR-003 | Submit with Photo         | Patron adds photo        | Take/select photo → Compress → Upload      |               |
| ...      | ...                       | ...                      | ...                                        |               |

**Questions for you:**

1. Are there any End User journeys missing that should be added?
2. Do any of these journeys need adjustment or more detail?
3. Are the triggers and key steps accurate?

Please respond with:

- "Looks good" to approve this section
- Or describe what needs to be added/changed
```

### 5.2 Repeat for Each Actor Type

Present summaries in this order, waiting for user feedback after each:

1. **End User Journeys** → Wait for feedback
2. **Staff User Journeys** → Wait for feedback
3. **Admin Journeys** → Wait for feedback
4. **System Journeys** → Wait for feedback
5. **External Integration Journeys** → Wait for feedback

### 5.3 Collect Adjustments

For each adjustment requested:

```markdown
## Adjustment Request Received

**Actor Type:** [e.g., End User]
**Request:** [User's description of change]

### Proposed Changes:

- [ ] Add new journey: [Journey description]
- [ ] Modify journey [ID]: [What to change]
- [ ] Remove journey [ID]: [Reason]
- [ ] Add missing steps to [ID]: [Steps to add]

**Implementing changes...**
```

### 5.4 Final Confirmation

After all actor types reviewed:

```markdown
## Journey Review Complete

### Changes Made:

| Actor Type | Added | Modified | Removed |
| ---------- | ----- | -------- | ------- |
| End User   | [N]   | [N]      | [N]     |
| Staff User | [N]   | [N]      | [N]     |
| Admin      | [N]   | [N]      | [N]     |
| System     | [N]   | [N]      | [N]     |
| External   | [N]   | [N]      | [N]     |

### Final Journey Count: [N] (was [N] before review)

**Documentation updated at:** `.claude/docs/{feature-name}-user-journeys.md`

Would you like to:

1. Proceed to validation
2. Review any section again
3. Add more journeys
```

---

## Step 6: Validation

After generation, validate the output:

1. **Completeness Check**
   - Verify all actor types are represented (or explicitly noted as N/A)
   - Confirm technical entry points are mapped
   - Check cross-references are valid

2. **Usability Check**
   - Can a development agent understand each journey?
   - Are success and error paths clear?
   - Are gaps actionable or clearly marked as TBD?

3. **Report Validation Result**

   ```markdown
   ## Validation Result

   | Check                      | Status       |
   | -------------------------- | ------------ |
   | All actor types covered    | [Pass/Issue] |
   | Technical mapping complete | [Pass/Issue] |
   | Cross-references valid     | [Pass/Issue] |
   | Agent-ready documentation  | [Pass/Issue] |

   **Overall Status:** [Ready for Use | Needs Revision]
   ```

---

## Output Location

**Journey documentation is saved to:**

```
.claude/docs/{feature-name}-user-journeys.md
```

This location integrates with other discovery documentation and can be referenced by:

- `/feature` command for implementation planning
- `/prepare-stories` command for story creation
- Development agents for implementation context

---

## Usage Examples

### Analyze a Specific Feature

```
/user-journeys PIR QR Code feature
```

### Analyze a Module

```
/user-journeys Incident Management module
```

### Full System Analysis

```
/user-journeys entire WeTrack system
```

### Analyze with Focus on Integration

```
/user-journeys external API integrations for incidents
```

---

## Integration with Other Workflows

### Recommended Sequence

```
/discover [feature]        -> Creates .claude/docs/{feature}.md
/user-journeys [feature]   -> Creates .claude/docs/{feature}-user-journeys.md
/prepare-stories [feature] -> Uses journeys for acceptance criteria
/feature [feature]         -> Executes development
```

### For Story Refinement

Journey documentation provides:

- Acceptance criteria context
- Error path test scenarios
- Integration touchpoints
- Actor-specific requirements

### For Code Review

Journey documentation helps reviewers verify:

- All paths are implemented
- Error handling matches documented paths
- Actor permissions are enforced
- Integration contracts are honored

---

## Error Handling

### No Documentation Found

```markdown
No documentation found for "$ARGUMENTS".

**Options:**

1. Run `/discover $ARGUMENTS` to generate documentation first
2. Provide specific file paths to analyze
3. Describe the feature for direct journey analysis (limited scope)
```

### Incomplete Documentation

```markdown
Documentation for "$ARGUMENTS" appears incomplete.

**Missing Elements:**

- [List of missing information]

**Options:**

1. Proceed with available information (gaps will be noted)
2. Provide additional context now
3. Update documentation first with `/discover`
```

### Too Many Unresolved Gaps

```markdown
Journey analysis identified [N] unresolved gaps.

**Recommendation:**
Before proceeding with development:

1. Address critical gaps marked with [CRITICAL]
2. Review gaps with product owner
3. Update source documentation

**Continue anyway?** (yes/no)
```

> **Memory**: Agents should consult and update their `.claude/agent-memory/` between sessions.
