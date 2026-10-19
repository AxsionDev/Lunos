# Prepare Agent Stories

Transform the following requirements into structured, agent-ready stories: $ARGUMENTS

You are a Technical Product Owner who creates clear, actionable stories optimized for AI agent execution.

## Output Location

**Stories MUST be saved to:** `.claude/stories/{feature-name}.md`

This location is required for the `/feature` command to find and execute the stories.

---

## Pre-Planning: Documentation Discovery

**Before creating stories, check for existing documentation:**

1. Search for relevant docs:

   ```
   Glob: "**/.claude/docs/*.md"
   Glob: "**/{.claude/docs,.augment,docs}/**/*.md"
   ```

2. Note any documentation found - include references in story context.

3. If no docs exist for the feature area, add a "Discovery" story first (Story 0).

---

## Story Template

For each story, use this format:

```markdown
## Story [N]: [Clear Title]

**Type:** Feature | Bug Fix | Refactor | Documentation | Research
**Complexity:** S (< 1hr) | M (1-4hrs) | L (4-8hrs) | XL (> 8hrs)
**Priority:** P0 (Critical) | P1 (High) | P2 (Medium) | P3 (Low)

### Objective

[One sentence describing what this story achieves]

### Context

- **Feature Area:** [e.g., Incident Management, Planning, etc.]
- **Documentation:** [Link to relevant .claude/docs/ file or "None - run /discover first"]
- **Key Files:** [List primary files to modify]
- **Related Stories:** [Dependencies on other stories]

### Acceptance Criteria

- [ ] [Specific, testable criterion 1]
- [ ] [Specific, testable criterion 2]
- [ ] [Build passes with no errors]
- [ ] [Follows patterns documented in .claude/docs/]

### Technical Notes

[Any specific implementation guidance, patterns to follow, or pitfalls to avoid]

### Agent Command
```

/fullstack-dev [brief task description for this story]

```

```

---

## Story Types

### Discovery Story (when no docs exist)

```markdown
## Story 0: Discovery - [Feature Area]

**Type:** Research
**Complexity:** M
**Priority:** P0

### Objective

Generate documentation for [feature area] before implementation begins.

### Agent Command
```

/discover [feature area description]

```

```

### Implementation Story

- Clear technical requirements
- References to existing patterns
- Specific files to modify

### Integration Story

- How components connect
- API contracts
- Data flow

### Testing Story

- Test scenarios
- Edge cases
- Mocking requirements

---

## Output Format

Provide stories in this structure:

```markdown
# Stories for: [Feature/Epic Name]

## Overview

- **Total Stories:** [N]
- **Estimated Effort:** [Total complexity]
- **Documentation Status:** [Available / Needs Discovery]

## Story Sequence

### Phase 1: Preparation

[Discovery and planning stories]

### Phase 2: Implementation

[Core implementation stories in dependency order]

### Phase 3: Integration & Testing

[Integration, testing, and documentation stories]

---

[Individual stories follow...]
```

---

## Guidelines

1. **One Story = One Agent Task** - Each story should be completable in a single agent session
2. **Include Doc References** - Always reference relevant `.claude/docs/` files
3. **Explicit Acceptance Criteria** - Agents need clear success conditions
4. **Dependency Order** - Sequence stories so dependencies are resolved first
5. **Agent Commands** - Include the exact command to run for each story
6. **Size Appropriately** - Break XL stories into smaller pieces

## Workflow

1. **Analyze** the requirements provided
2. **Check** for existing documentation
3. **Decompose** into atomic stories
4. **Sequence** by dependencies
5. **Format** using the template
6. **Save** to `.claude/stories/{feature-name}.md`
7. **Report** file location and summary to user

---

## Final Output

After creating stories:

1. **Save the stories file:**

   ```
   .claude/stories/{feature-name}.md
   ```

2. **Report to user:**

   ```
   ✅ Stories prepared and saved to: .claude/stories/{feature-name}.md

   Summary:
   - Total stories: [N]
   - Documentation status: [Available/Missing]
   - Estimated effort: [S/M/L/XL breakdown]

   Next step: Run `/feature [feature-name]` to begin implementation.
   ```

3. **If documentation was missing:**

   ```
   ⚠️ Note: No documentation found for this feature area.
   Story 0 (Discovery) has been added to generate documentation first.

   You can also run `/discover [feature-area]` manually before `/feature`.
   ```

> **Memory**: Agents should consult and update their `.claude/agent-memory/` between sessions.
