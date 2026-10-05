# /state-resume

Resume a session with context recovery.

## Purpose

Loads compacted context from the active session to prime an agent for continued work after interruption or handoff.

## Usage

```
/state-resume
/state-resume {session-id}
```

## Arguments

- `$ARGUMENTS` (optional) - Specific session ID to resume (defaults to active session)

## What It Does

1. **Load active session** or specified session
2. **Read compacted context** from context.yaml
3. **Load task state** from tasks.yaml
4. **Load recent decisions** from decisions.yaml
5. **Read handoff notes** if available
6. **Generate context injection** for agent priming
7. **Update session status** to active

## Instructions for Claude

When the user runs `/state-resume`:

1. **Determine session**:
   - If session ID provided in arguments, use that
   - Otherwise, read from `active-session.yaml`
   - If no active session, list available and ask user to choose

2. **Load state files**:
   - `.agent-state/sessions/{session-id}/session.yaml`
   - `.agent-state/sessions/{session-id}/context.yaml`
   - `.agent-state/sessions/{session-id}/tasks.yaml`
   - `.agent-state/sessions/{session-id}/decisions.yaml`
   - `.agent-state/sessions/{session-id}/handoff.md` (if exists)

3. **Generate context injection payload**:

```
═══════════════════════════════════════════════════════════════
SESSION RESUMED: {session name}
═══════════════════════════════════════════════════════════════

MISSION
───────────────────────────────────────────────────────────────
{essential_context.mission}

CURRENT STATE
───────────────────────────────────────────────────────────────
Phase:    {current_state.phase}
Status:   {session status}

Active Tasks:
{For each active task:}
  [{task-id}] {title}
    Assigned: {agent}
    Context: {context_summary preview}

Blocked Tasks:
{For each blocked task:}
  [{task-id}] {title}
    Blocked by: {reason}

Next Milestone: {next_milestone}

KEY DECISIONS
───────────────────────────────────────────────────────────────
{For each key decision:}
• {decision summary}

KEY FILES
───────────────────────────────────────────────────────────────
{Grouped by category from key_files}

CONSTRAINTS
───────────────────────────────────────────────────────────────
{List constraints}

PATTERNS IN USE
───────────────────────────────────────────────────────────────
{For each active_pattern:}
• {pattern} (see: {reference})

RECENT CONTEXT
───────────────────────────────────────────────────────────────
{Last entry from conversation_summary}

{If handoff.md exists:}
HANDOFF NOTES
───────────────────────────────────────────────────────────────
Previous Agent: {from handoff}
Notes: {handoff notes}

QUICK FACTS
───────────────────────────────────────────────────────────────
{For each queryable_fact:}
• {topic}: {fact}

═══════════════════════════════════════════════════════════════
Context loaded. Ready to continue work.
Commands: /session-status, /compact, /handoff
═══════════════════════════════════════════════════════════════
```

4. **Update session state**:

```yaml
# In session.yaml
status: "active"
updated_at: "{now}"

agent_chain:
  # Add new agent entry
  - agent: "{current agent type or 'resumed'}"
    started_at: "{now}"
    ended_at: null
    handoff_reason: null
    tasks_completed: []
```

5. **Update active-session.yaml** if resuming different session:

```yaml
session_id: "{session-id}"
resumed_at: "{now}"
```

6. **Confirm understanding**:
   - After displaying context, ask: "Context loaded. Ready to continue?"
   - Or proceed directly if context is clear

## Fallback: No Session Found

```
No Active Session
─────────────────────────────────────────────────────────────

Available sessions:
{List from .agent-state/sessions/}

  {session-id}
    Name: {name}
    Status: {status}
    Last Updated: {timestamp}

To resume a specific session:
  /state-resume {session-id}

To start a new session:
  /session-start "Your task description"
```

## Output

Formatted context injection with mission, tasks, decisions, files, and patterns ready for agent to continue work.
