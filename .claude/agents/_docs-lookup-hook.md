# Documentation Lookup Hook

Canonical reference for the **documentation-first** pattern. Agents reference this file for the standard procedure to search `.claude/docs/` before code exploration.

---

## Purpose

The `.claude/docs/` directory contains feature-level architecture documentation produced by the `/discover` command. These docs describe:

- Feature architecture and component relationships
- Data flows and integration points
- Design decisions and trade-offs
- User journeys and interaction patterns

Consulting these docs **before** code exploration saves significant investigation time and provides architectural context that code reading alone cannot reveal.

---

## Standard Lookup Procedure

### Step 1: Extract Keywords

From the task description, bug report, or feature name, extract 2-4 keywords that identify the feature area. Examples:

- "user profile page is broken" → keywords: `user`, `profile`
- "implement QR code scanning" → keywords: `qr`, `code`, `scanning`
- "fix incident report export" → keywords: `incident`, `report`, `export`

### Step 2: Search Documentation Locations (in order)

Search these locations for matching documentation:

1. **`.claude/docs/`** — Feature documentation (from /discover)
2. **`.claude/patterns/`** — Code patterns (from /generate-startup)
3. **`.augment/`**, **`docs/`** — Project reference docs (CODE_STRUCTURE.md, API_ENDPOINTS.md)
4. **`docs/`** — Project documentation directory
5. **`README.md`** — Project root readme

For each location that exists, Glob for `**/*.md` and filter for keyword matches. Also check for:

- `{feature}.md` — Main feature documentation
- `{feature}-user-journeys.md` — User journey documentation
- Related features that might share context

### Step 3: Read and Apply

**If matching docs are found:**

1. Read the most relevant file(s)
2. Extract key context: architecture, data flows, affected components
3. Pass this context to downstream agents or use it to inform investigation
4. Note which docs were consulted in your output

**If no matching docs are found in any location:**

1. Note the documentation gap
2. Proceed with code exploration as normal
3. Suggest running `/discover {feature-area}` after the task completes to fill the gap

---

## Integration Notes

- This hook runs **after** FIRST (state init) and SECOND (project detection)
- It is a **silent** operation — do not ask the user, just search and read
- If `.claude/docs/` does not exist or is empty, skip silently and proceed
- Documentation found here supplements any project documentation found in `.claude/docs/`, `.augment/`, `docs/`, or other project documentation directories
