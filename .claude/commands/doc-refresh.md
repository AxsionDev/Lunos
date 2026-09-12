# Documentation Refresh

Update all documentation to reflect implementation reality for: **$ARGUMENTS**

This phase closes the documentation feedback loop — what you document now becomes discovery context for future AI agents.

---

## Prerequisites

- Discovery doc: `.claude/docs/{feature-name}.md`
- User journeys: `.claude/docs/{feature-name}-user-journeys.md`
- Stories: `.claude/stories/{feature-name}.md`
- Implementation must be complete (Phase 4 done)

---

## Execution

### Step 1: Update Discovery Documentation

Read `.claude/docs/{feature-name}.md` and update with implementation reality:

**Sections to update:**
1. **File Structure** - Add all new files created during implementation
2. **Entry Points** - Update with actual controllers, components, services
3. **Dependencies** - Add any new dependencies introduced
4. **Data Flow** - Update with actual implementation flow
5. **API Endpoints** - Add all new endpoints with request/response examples
6. **Key Patterns** - Document any new patterns introduced
7. **Configuration** - Document new config options
8. **Testing** - Update test file locations and key test scenarios

**Sections to add (if missing):**
1. **Implementation Notes** - Decisions made, trade-offs chosen, known limitations
2. **Troubleshooting Guide** - Common issues, how to debug, error messages
3. **Extension Points** - Where to add future enhancements, hooks for customization

### Step 2: Verify User Journeys

Compare implemented behavior against `.claude/docs/{feature-name}-user-journeys.md`:

For each journey verify:
- [ ] Trigger still accurate?
- [ ] Steps match implementation?
- [ ] Success path works as documented?
- [ ] Error paths implemented as documented?
- [ ] Technical entry points correct?

Update if any journey was modified, added, or descoped during implementation.

### Step 3: Update Stories with Completion Status

Update `.claude/stories/{feature-name}.md`:
- Mark each story status: Complete / Deferred / Descoped
- Add implementation notes
- Link to actual files created
- Note deviations from acceptance criteria

### Step 4: Generate AI Agent Quick Reference

Use the Task tool with `subagent_type="ai-docs-generator"`:

```
## AI Documentation Update Request

### Feature Completed
$ARGUMENTS

### Your Tasks

1. **Update Discovery Doc** (`.claude/docs/{feature-name}.md`)
   - Add all new files to file structure
   - Update entry points with actual implementations
   - Add new patterns discovered during implementation

2. **Create AI Agent Quick Start Section**
   Add to the discovery doc:
   - How to understand this feature (key files to read)
   - How to modify this feature (common change patterns)
   - How to extend this feature (extension points)
   - Common pitfalls to avoid

3. **Update Cross-References**
   - Link to related features
   - Update dependent feature documentation
   - Add backlinks from affected modules

4. **Verify Discoverability**
   Ensure an AI agent searching for the feature name, key functionality,
   or common tasks would find the right entry points.
```

### Step 5: Update Project-Wide Documentation

Check and update project-level documentation if applicable:
- Backend reference docs (if new API endpoints)
- Frontend reference docs (if new components)
- Feature index (if exists)
- Configuration guide (if new config options)

### Step 6: Create Implementation Changelog

Save to `.claude/docs/changelog/{feature-name}-{date}.md`:

```markdown
---
type: implementation-record
feature: {feature-name}
completed: {YYYY-MM-DD}
---

# Implementation: {Feature Name}

## Summary
[2-3 sentence summary of what was built]

## Deliverables
| Type | Item | Location |
|------|------|----------|
| [Controller/Service/Component/Migration] | [Name] | [path] |

## API Endpoints Added
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | /api/... | ... |

## Database Changes
[Tables/columns added or modified]

## Patterns Introduced
[Any new patterns future developers should follow]

## Known Limitations
[What this implementation doesn't do]
```

### Step 7: State Checkpoint

Use the Task tool with `subagent_type="state-manager"`:
```
## Phase Checkpoint Request

### Phase Details
- Phase: 5 - Documentation Refresh
- Status: Complete
- Output: Updated docs + changelog

### Decisions to Log
- Docs updated: [List]
- Journeys verified: [N] of [N]
- Stories marked complete: [N] of [N]
- Changelog created: .claude/docs/changelog/{feature-name}-{date}.md

### Your Task
1. Log phase completion to decisions.yaml
2. Update session phase status
3. Mark feature lifecycle as complete
```

---

## Validation Gate

**PASS if:**
- [ ] Discovery doc updated with implementation details (file structure, entry points current)
- [ ] User journeys verified against implementation (no stale journey steps)
- [ ] Stories marked with completion status
- [ ] AI Agent Quick Start section exists in discovery doc
- [ ] Changelog entry created at `.claude/docs/changelog/{feature-name}-{date}.md`
- [ ] All file paths in docs exist in codebase

**FAIL if:**
- [ ] Discovery doc still reflects pre-implementation state
- [ ] Changelog missing
- [ ] File paths in docs reference non-existent files

**On FAIL:** Present issue to user, offer to retry specific sub-steps.

---

## Output

| Artifact | Location |
|----------|----------|
| Updated discovery doc | `.claude/docs/{feature-name}.md` |
| Verified user journeys | `.claude/docs/{feature-name}-user-journeys.md` |
| Completed stories | `.claude/stories/{feature-name}.md` |
| Implementation changelog | `.claude/docs/changelog/{feature-name}-{date}.md` |

---

## User Checkpoint

```markdown
## Phase 5 Complete: Documentation Refresh

### Documentation Updated
| Document | Status | Changes |
|----------|--------|---------|
| Discovery Doc | Updated | +[N] sections, [N] files added |
| User Journeys | Verified | [N] journeys confirmed |
| Stories | Completed | [N] marked complete |
| Changelog | Created | Implementation record added |

### AI Agent Discoverability
- [ ] Quick Start section added
- [ ] Troubleshooting guide added
- [ ] Extension points documented
- [ ] Cross-references updated

---

**Documentation refresh complete.**
Future AI agents running `/discover {feature-name}` will now find accurate, up-to-date information.
```

> **Memory**: Agents should consult and update their `.claude/agent-memory/` between sessions.
