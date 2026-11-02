# Dual-Agent Product Brainstorming

Orchestrate a collaborative product brainstorming session using two specialized agents for: $ARGUMENTS

## Instructions

Execute this dual-agent brainstorming workflow sequentially, with user approval gates at critical decision points. This workflow uses Alpha (Ideator) and Beta (Critic) agents to ensure high-confidence, validated product ideas.

---

## Workflow Overview

```
User Request → Clarify → Alpha Ideates → User Checkpoint → Beta Reviews
                                              ↓
                         ← Resolution Rounds (max 3) ←
                                              ↓
                      Consensus → User Approval → Optional PRD
```

---

## Pre-Step: Initialize State Management

Before any brainstorming begins, ensure session state is properly initialized.

### State Directory Check

1. Check if `.agent-state/` directory exists
2. If not, silently run `/state-init` to create the state infrastructure

### Start Brainstorm Session

1. Run `/session-start "Brainstorm: $ARGUMENTS"`
2. Note the session ID for reference throughout the workflow

---

## Step 1: User Intent Clarification

Before launching the ideation agents, clarify the user's intent directly.

### Clarification Questions

Ask the user to clarify (use AskUserQuestion tool):

1. **Scope**: What area of the product should we focus on?
   - Specific feature enhancement
   - New feature area
   - User experience improvement
   - Technical capability
   - Open exploration

2. **Constraints**: Are there any constraints to consider?
   - Technical limitations
   - Budget/resource constraints
   - Timeline requirements
   - Regulatory/compliance needs
   - None - explore freely

3. **Desired Outcome**: What do you want from this session?
   - 1-2 concrete ideas to pursue immediately
   - A range of options to evaluate
   - Exploration of possibilities
   - Validation of an existing idea

### Collect Context

Based on the topic "$ARGUMENTS", gather additional context:

- What problem or opportunity prompted this brainstorm?
- Are there existing features or systems this relates to?
- Who are the target users?

Summarize understanding and confirm with user before proceeding.

---

## Step 2: Alpha Ideation

Use the Task tool with `subagent_type="product-ideator-alpha"` to generate ideas.

### Ideation Prompt

```
## Product Brainstorming Request

### Topic
$ARGUMENTS

### User Context
[Include clarified scope, constraints, and desired outcome from Step 1]

### Your Task
1. Research the codebase thoroughly:
   - Search for related features in `.claude/docs/`, `.augment/`, `docs/`
   - Examine relevant services, controllers, and components
   - Identify current patterns and capabilities

2. Conduct external research:
   - Industry best practices
   - Competitor features
   - Utility/customer portal innovations

3. Generate 3-5 product ideas:
   - Each idea must have evidence from your research
   - Include product fit assessment
   - Note technical considerations
   - State confidence level
   - Pose questions for Beta

4. Produce an Alpha Ideation Report following the format in your agent definition.

Focus on ideas that are:
- Grounded in evidence (not speculation)
- Aligned with the Toplo Customer Portal context
- Technically feasible with the current stack
- Valuable to users and business
```

### Record Alpha's Output

Store Alpha's ideation report for reference:

- Ideas generated
- Evidence cited
- Questions for Beta

---

## Step 3: User Checkpoint

Present Alpha's ideas to the user and ask for direction.

### Present Summary

```markdown
## Alpha Generated [N] Ideas

| #   | Idea   | User Value     | Confidence     | Key Insight     |
| --- | ------ | -------------- | -------------- | --------------- |
| 1   | [Name] | [High/Med/Low] | [High/Med/Low] | [Brief insight] |
| 2   | [Name] | [High/Med/Low] | [High/Med/Low] | [Brief insight] |
| ... | ...    | ...            | ...            | ...             |

### Alpha's Top Recommendation

[Brief description of Alpha's preferred direction]

### Questions Alpha Raised

1. [Question for Beta to investigate]
2. [Concern to validate]
```

### User Decision Point

Ask the user (use AskUserQuestion):

**How would you like to proceed?**

1. **Continue to Beta Review** (Recommended)
   - Have Beta critically review and validate Alpha's ideas
   - Reach consensus before presenting final recommendations

2. **Focus on Specific Ideas**
   - Only have Beta review ideas #[X, Y]
   - Skip ideas that don't interest you

3. **Add Your Own Ideas**
   - Include your own idea for Alpha/Beta to evaluate
   - Provide: [text input for user's idea]

4. **Stop Here**
   - Alpha's ideas are sufficient
   - Skip Beta review and proceed to PRD if desired

Wait for user response before proceeding.

---

## Step 4: Beta Review

Use the Task tool with `subagent_type="product-critic-beta"` to review Alpha's ideas.

### Review Prompt

```
## Product Idea Review Request

### Alpha's Ideation Report
[Include full Alpha report from Step 2]

### User Direction
[Include any user feedback from Step 3]

### Your Task
1. Independently verify Alpha's claims:
   - Check files Alpha cited
   - Verify patterns Alpha mentioned
   - Look for evidence Alpha missed

2. Critically review each idea:
   - What did Alpha get right?
   - What concerns or gaps exist?
   - Product fit reality check

3. Provide verdicts:
   - PROCEED: Idea is sound and feasible
   - REFINE: Good core, needs adjustments
   - DROP: Should not proceed

4. Propose counter-ideas if you found opportunities Alpha missed

5. Produce a Beta Review Report following the format in your agent definition.

Be constructive but rigorous. The goal is validated, high-confidence ideas.
```

---

## Step 5: Resolution (If Needed)

If Beta's review shows disagreements with Alpha, facilitate resolution.

### Check for Consensus

If Beta's report shows "Ready for Consensus: Yes":

- Skip to Step 6 with the consensus

If Beta's report shows "Ready for Consensus: No":

- Continue with resolution rounds

### Resolution Rounds (Max 3)

For each round:

1. **Alpha Response**: Use Task tool with `subagent_type="product-ideator-alpha"`:

   ```
   ## Response to Beta's Review

   ### Beta's Review
   [Include Beta's report]

   ### Your Task
   1. Address Beta's concerns with evidence
   2. Refine ideas based on valid critique
   3. Counter with evidence where you disagree
   4. Work toward consensus

   Produce an Alpha Response following the format in your agent definition.
   ```

2. **Beta Counter-Response**: Use Task tool with `subagent_type="product-critic-beta"`:

   ```
   ## Evaluation of Alpha's Response

   ### Alpha's Response
   [Include Alpha's response]

   ### Your Task
   1. Evaluate if Alpha addressed your concerns
   2. Update your assessments
   3. Check for convergence
   4. Determine if consensus is reached

   Produce an updated Beta Review following the format in your agent definition.
   ```

3. **Check Consensus**: If "Ready for Consensus: Yes", proceed to Step 6

### After 3 Rounds

If consensus not reached after 3 rounds:

```markdown
## Resolution Not Reached

After 3 rounds of dialogue, Alpha and Beta have not reached full consensus.

### Points of Agreement

[What they agree on]

### Remaining Disagreements

| Point   | Alpha's View | Beta's View |
| ------- | ------------ | ----------- |
| [Point] | [View]       | [View]      |

### Recommendation

Present both perspectives to the user for decision.
```

Present to user and ask which direction to pursue.

---

## Step 6: User Approval

Present the consensus (or final state) to the user for approval.

### Consensus Presentation

```markdown
## Brainstorming Consensus Reached

### Ideas Approved for Pursuit

#### 1. [Idea Name] - Priority: [High/Medium]

**Description:** [Clear description]
**Why It's Validated:**

- Alpha's evidence: [Key points]
- Beta's verification: [Key points]
  **Next Steps:** [Recommended action]

#### 2. [Idea Name] - Priority: [High/Medium]

[Same structure]

### Ideas Dropped

| Idea   | Reason                           |
| ------ | -------------------------------- |
| [Name] | [Why both agents agreed to drop] |

### Key Insights

1. [Most important discovery from the session]
2. [Important consideration for implementation]

### Open Questions

- [Question that needs user input]
- [Decision point before implementation]
```

### User Decision Point

Ask the user (use AskUserQuestion):

**Do you approve these ideas for pursuit?**

1. **Approve All**
   - Proceed with all recommended ideas
   - Optionally generate PRD

2. **Approve with Changes**
   - Specify which ideas to pursue
   - Add any additional requirements

3. **Request More Exploration**
   - Specific area to explore further
   - Additional constraints to consider

4. **Start Over**
   - New direction needed
   - Original topic needs reframing

Wait for user approval before proceeding.

---

## Step 7: PRD Generation (Optional)

If user approves ideas and wants documentation, generate a PRD.

### User Decision Point

Ask the user:

**Would you like me to generate a Product Requirements Document (PRD)?**

1. **Yes - Full PRD**
   - Comprehensive PRD with all sections
   - Suitable for development handoff

2. **Yes - Brief PRD**
   - Key sections only
   - Suitable for further discussion

3. **No - Ideas Sufficient**
   - Skip PRD generation
   - End session

### PRD Generation

If user wants a PRD, use the Task tool with `subagent_type="product-brainstorm"`:

```
## PRD Generation Request

### Approved Ideas
[List of approved ideas from consensus]

### Context
- Topic: $ARGUMENTS
- Scope: [From Step 1]
- Constraints: [From Step 1]

### Evidence Summary
[Key evidence from Alpha and Beta reports]

### Your Task
Generate a comprehensive PRD for the approved ideas using your standard PRD template.

The user has already confirmed these ideas through dual-agent validation.
Proceed directly to PRD generation without additional brainstorming.
```

---

## Step 8: Session Closure

Finalize the brainstorming session.

### Compress Context

Run `/compact` to compress the session context for future reference.

### Generate Handoff

Run `/handoff` to create a structured handoff document.

### Final Summary

```markdown
## Brainstorming Session Complete

**Session ID:** [From state management]
**Topic:** $ARGUMENTS

### Ideas Validated

| Idea   | Confidence | Status                    |
| ------ | ---------- | ------------------------- |
| [Name] | High       | Approved                  |
| [Name] | Medium     | Approved with refinements |

### Agents Consulted

- **Alpha (Ideator):** [N] rounds of ideation
- **Beta (Critic):** [N] rounds of review
- **Consensus:** [Reached/Presented both views]

### Artifacts Produced

- ✅ Alpha Ideation Report
- ✅ Beta Review Report
- ✅ Consensus Summary
- [✅/❌] PRD Generated

### Next Steps

1. [First action item]
2. [Second action item]

### State Files Updated

- `.agent-state/sessions/{session-id}/context.yaml`
- `.agent-state/sessions/{session-id}/handoff.md`
```

---

## Error Handling

### Alpha Produces No Ideas

If Alpha cannot generate ideas:

- Ask for more context from user
- Broaden the scope
- Provide specific areas to explore

### Beta Rejects All Ideas

If Beta marks all ideas as DROP:

- Present Beta's reasoning to user
- Ask if user wants Alpha to try again with new direction
- Consider user's own ideas for evaluation

### Endless Disagreement

After 3 resolution rounds without consensus:

- Present both views to user
- Let user decide which direction to pursue
- Document the disagreement for future reference

### User Wants to Pivot

If user changes direction mid-session:

- Acknowledge the pivot
- Optionally save current progress
- Restart from Step 1 with new direction

---

## Quick Reference

### Agents Used

| Agent                   | Purpose                        | Model  |
| ----------------------- | ------------------------------ | ------ |
| `product-ideator-alpha` | Research + generate 3-5 ideas  | opus   |
| `product-critic-beta`   | Verify + challenge + consensus | opus   |
| `product-brainstorm`    | PRD generation                 | sonnet |

### User Checkpoints

1. **After Step 1**: Confirm understanding of scope/constraints
2. **After Step 2**: Continue to Beta or stop with Alpha's ideas
3. **After Step 5**: Approve consensus or request changes
4. **After Step 6**: Generate PRD or end session

### Key Outputs

- Alpha Ideation Report (3-5 ideas with evidence)
- Beta Review Report (verdicts and validation)
- Consensus Summary (agreed direction)
- PRD (optional, if requested)

> **Memory**: Agents should consult and update their `.claude/agent-memory/` between sessions.
