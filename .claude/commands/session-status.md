# /session-status

Display the current session status and progress.

## Purpose

Shows a summary of the active session including tasks, decisions, context state, and progress metrics.

## Usage

```
/session-status
```

## What It Does

1. **Load active session** from `active-session.yaml`
2. **Read session metadata** from `session.yaml`
3. **Summarize tasks** from `tasks.yaml`
4. **Summarize decisions** from `decisions.yaml`
5. **Report context state** from `context.yaml`
6. **Display formatted status**

## Instructions for Claude

When the user runs `/session-status`:

1. Check if `.agent-state/` exists
2. Read `active-session.yaml` to get current session ID
3. If no active session, report and suggest `/session-start`

4. Load and parse:
   - `.agent-state/sessions/{session-id}/session.yaml`
   - `.agent-state/sessions/{session-id}/tasks.yaml`
   - `.agent-state/sessions/{session-id}/decisions.yaml`
   - `.agent-state/sessions/{session-id}/context.yaml`

5. Format and display:

```
╔══════════════════════════════════════════════════════════════╗
║  SESSION STATUS                                               ║
╠══════════════════════════════════════════════════════════════╣
║  ID:      {session-id}                                        ║
║  Name:    {session name}                                      ║
║  Phase:   {phase}                                             ║
║  Status:  {status}                                            ║
╚══════════════════════════════════════════════════════════════╝

PROGRESS
────────────────────────────────────────────────────────────────
Tasks:     {completed}/{total} completed
           ████████░░░░░░░░░░░░ {percentage}%

By Status:
  ✓ Completed:   {count}
  → In Progress: {count}
  ⊘ Blocked:     {count}
  ○ Pending:     {count}

ACTIVE TASKS
────────────────────────────────────────────────────────────────
{For each in_progress task:}
  [{task-id}] {title}
    Assigned: {agent}

BLOCKED TASKS
────────────────────────────────────────────────────────────────
{For each blocked task:}
  [{task-id}] {title}
    Blocked by: {blocker}
    Reason: {reason}

RECENT DECISIONS
────────────────────────────────────────────────────────────────
{Last 3-5 decisions:}
  [{dec-id}] {title}
    Decision: {decision summary}

KEY FILES
────────────────────────────────────────────────────────────────
{From context.yaml key_files:}
  Frontend: {list}
  Backend:  {list}

CONTEXT STATE
────────────────────────────────────────────────────────────────
  Token Estimate:    ~{tokens}
  Last Compaction:   {timestamp or "Never"}
  Messages Since:    {count}
  Compaction Needed: {Yes/No}

AGENT CHAIN
────────────────────────────────────────────────────────────────
{For each agent in chain:}
  {agent} ({duration}) → {handoff_reason or "active"}

────────────────────────────────────────────────────────────────
Commands: /compact, /handoff, /state-resume
```

6. If no active session:

```
No active session.

Available sessions:
{List sessions in .agent-state/sessions/}

To start a new session:
  /session-start "Your task description"
```

## Output

Formatted status display with progress, tasks, decisions, and context state.
