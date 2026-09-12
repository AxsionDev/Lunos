# /generate-startup

Scan the project and fill `.claude/PROJECT_STARTUP.md` with detected values.

## Usage

```
/generate-startup
```

## What It Does

1. Scans for frontend frameworks (Angular, React, Vue, Next.js)
2. Scans for backend frameworks (.NET, Node.js, Python)
3. Detects start commands from package.json, *.csproj
4. Finds prerequisites (.nvmrc, global.json, .env.example)
5. Fills PROJECT_STARTUP.md with detected values
6. Asks you to review and adjust
7. Extracts code patterns from the codebase into `.claude/patterns/`

## When to Use

- First time setting up the agent framework in a new project
- After major project restructuring
- When PROJECT_STARTUP.md is missing or outdated

## Agent

Uses: `project-startup-generator`

---

## Execution

Follow the `project-startup-generator` agent workflow:

1. Check if PROJECT_STARTUP.md already has values (offer to overwrite)
2. Scan project for frontend/backend indicators
3. Detect install commands, start commands, and ports
4. Fill the template with detected values
5. Present summary and ask user to review
6. Extract code patterns from codebase into `.claude/patterns/`
7. Present summary including pattern extraction results
