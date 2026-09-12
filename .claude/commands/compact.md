# /compact

Force context compaction for the current session.

## Purpose

Compacts conversation context to prevent overflow by summarizing messages, extracting key facts, and preserving essential state.

## Usage

```
/compact
/compact --aggressive
```

## Arguments

- `--aggressive` (optional) - Use maximum compression, minimal context retention

## What It Does

1. **Load current session** and context state
2. **Analyze conversation** since last compaction
3. **Segment by task boundaries**
4. **Extract essentials** (outcomes, files, decisions, errors)
5. **Generate hierarchical summary**
6. **Update context.yaml** with compacted state
7. **Report token reduction**

## Instructions for Claude

When the user runs `/compact`:

1. Verify active session exists
2. Load current state from:
   - `.agent-state/sessions/{session-id}/session.yaml`
   - `.agent-state/sessions/{session-id}/context.yaml`
   - `.agent-state/sessions/{session-id}/tasks.yaml`
   - `.agent-state/sessions/{session-id}/decisions.yaml`

3. Determine what needs compaction:
   - Messages since `context_bounds.last_compaction`
   - Current message is `context_bounds.current_message`

4. **Segment the conversation**:
   - Identify task boundaries (task started, completed, blocked)
   - Identify decision points
   - Group into logical segments

5. **For each segment, extract**:
   - Which tasks were worked on
   - What was completed
   - What decisions were made (link to decision IDs)
   - What files were created/modified
   - Any errors and their resolutions

6. **Generate summary for each segment**:
   ```
   Messages {start}-{end}: {1-2 sentence summary}
   ```

7. **Extract queryable facts**:
   - Topic keywords (library, endpoint, pattern, etc.)
   - Fact values
   - Source references

8. **Update context.yaml**:

```yaml
compaction:
  performed_at: "{ISO timestamp}"
  messages_compacted: {count}
  token_reduction_estimate: {estimate}
  compaction_method: "hierarchical_summary"
  message_range:
    from: {last_compaction + 1}
    to: {current_message}

essential_context:
  mission: "{preserve or update}"
  current_state:
    phase: "{current phase}"
    active_tasks: ["{current in_progress tasks}"]
    blocked_tasks: ["{current blocked tasks}"]
    next_milestone: "{next goal}"
    blockers: ["{current blockers}"]
  key_decisions:
    - "{decision 1 summary}"
    - "{decision 2 summary}"
  key_files:
    frontend: [{current frontend files}]
    backend: [{current backend files}]
    # etc.
  active_patterns:
    - pattern: "{pattern being followed}"
      reference: "{file reference}"
  constraints: ["{any hard constraints}"]

conversation_summary:
  # Add new entry
  messages_{start}_to_{end}: |
    {Summary of this segment}

queryable_facts:
  # Merge new facts
  - topic: "{keyword}"
    fact: "{value}"
    source: "{reference}"

recent_errors:
  # Keep last 5 errors
  - error: "{error}"
    resolution: "{resolution}"
    task: "{task-id}"
```

9. **Update session.yaml**:
```yaml
context_bounds:
  last_compaction: {current_message}
  token_estimate: {new_estimate}
metrics:
  compactions_performed: {increment}
```

10. **Report results**:

```
Context Compacted
─────────────────────────────────────────────────────────────

Messages compacted:    {start} to {end} ({count} messages)
Token reduction:       ~{tokens} tokens saved
New token estimate:    ~{estimate}

Summary added:
  messages_{start}_to_{end}: {brief preview}

Facts extracted:       {count} new queryable facts
Decisions preserved:   {count}
Files tracked:         {count}

Compaction complete. Context optimized for agent resumption.
```

## Aggressive Mode

When `--aggressive` is specified:

- Combine multiple segment summaries into single phase summary
- Keep only most recent 3 decisions in key_decisions
- Keep only actively-used files in key_files
- Remove resolved errors from recent_errors
- Target 50% further reduction

## Output

Compaction summary with metrics and preserved state overview.
