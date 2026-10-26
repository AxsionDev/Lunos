# Bug Triage Reference

For bug-reviewer agents: transform a raw bug description into a structured, AI-friendly Bug Analysis Report that lets a downstream agent investigate efficiently. **Analysis only — do not fix.**

## Categories (backend examples; adapt to stack/layer)

API/Controller · Service Logic · Database/Query · Auth · Performance · Concurrency · Integration · Configuration.
Frontend equivalents: Rendering/Visual · State/Data binding · Routing · Forms/Input · API integration · Performance.

## Analysis process

1. **Parse** the description (use `mcp__MCP_DOCKER__sequentialthinking`): status codes, error messages, endpoint/component names, exception fragments, data symptoms, performance/concurrency indicators ("slow", "sometimes", "intermittent").
2. **Classify** — severity (P0–P3), category, primary affected layer, likely root-cause layer.
3. **Trace data flow** — entry point → each layer → data store → response.
4. **Map affected areas** — Grep/Glob/Read to find the controllers/components/services/queries involved.
5. **Define investigation paths** — ordered, most-likely-cause first, each with specific `file:line`/method, what to look for, and a debug approach (logs, breakpoints, profiler).

## Output: Bug Analysis Report

```markdown
## Bug Analysis Report

### Classification

- **Type / Severity / Affected Layer / Root Cause Layer**

### Symptoms

- [≥2 observable behaviors: error code, message, wrong data]

### Likely Affected Areas

| Priority | File/Service | Reason |

### Data Flow Trace

Request → Controller/Component → Service → Repository/API → Store → Response

### Investigation Paths

1. Check `file:line` · Look for [pattern] · Debug [logs/breakpoint/profiler]
2. ...

### Reproduction Context

- Entry point · Required state (data/auth) · Expected vs Actual · Frequency

### Debugging Tools

- [ ] Logs · [ ] Stack trace · [ ] DB/EF logging · [ ] `mcp__ide__getDiagnostics`
```

## Done when

Bug classified (type/severity/both layers); ≥2 symptoms; data flow traced; ≥1 affected file per layer with reasoning; ≥2 ordered investigation steps.

## Minimum info / escalation

If missing: HTTP status → request exact response; endpoint → request URL; payload → request sample; frequency → always vs intermittent; stack trace → request from logs.

Escalate: too vague after clarification → back to `agent-clarifier`. UI-only symptom → `bug-reviewer-frontend`. Spans both → produce a report for each.
