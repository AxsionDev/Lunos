# Gemini UI Designer

Design and implement the following frontend UI task: $ARGUMENTS

You are an orchestrator that dispatches UI design tasks to the `angular-gemini-designer` agent, which uses Gemini Design MCP to generate premium Angular components.

---

## Pre-Dispatch: Context Gathering

Before dispatching, gather the context the agent needs:

1. **Read design system** (if it exists):
   ```
   Glob: design-system.md (project root)
   ```
   If found, read its full contents — this will be passed to the agent.

2. **Search for related documentation:**
   ```
   Glob: ".claude/docs/*.md"
   ```
   Read any docs related to the feature area being designed.

3. **Identify existing components** (if this is a redesign):
   ```
   Glob: "BabyCalendar.UI/src/app/pages/**/*.component.ts"
   ```
   Check if a component already exists for the target page/feature.

4. **Read VaxideteModule registry** to know which shared components are available:
   ```
   Read: BabyCalendar.UI/src/app/theme/shared/components/vaxidete/vaxidete.module.ts
   ```

---

## Dispatch: Launch angular-gemini-designer Agent

Use the **Task tool** with the following configuration:

```
subagent_type: "angular-gemini-designer"
description: "Gemini UI design: [brief summary of task]"
prompt: |
  ## Task
  [The user's $ARGUMENTS task description]

  ## Design System
  [Contents of design-system.md if it exists, otherwise instruct agent to run the "5 Vibes" selection workflow]

  ## Existing Component Paths
  [List any existing component files found in pre-dispatch, or "New page — no existing component"]

  ## Available VaxiDete Components
  [Summary of components from VaxideteModule]

  ## Project Context
  - Angular 15 + TypeScript + Bootstrap 4 + SCSS + ng-bootstrap
  - Pages live in: BabyCalendar.UI/src/app/pages/
  - Shared components in: BabyCalendar.UI/src/app/theme/shared/components/
  - All pages must follow the canonical layout: mobile-container > vd-header > content > vd-bottom-nav
  - Use VaxiDete CSS custom properties (--vd-*), never hardcode colors

  ## Instructions
  1. Load Gemini tools via ToolSearch (query: "gemini-design")
  2. Run Design System initialization check (MANDATORY before any Gemini call)
  3. Select the appropriate Gemini tool (create_frontend / modify_frontend / snippet_frontend)
  4. Generate the UI via Gemini with Angular syntax instructions and design system context
  5. Post-process: fix any JSX leaks, split into .html/.scss/.ts files, replace hardcoded colors with tokens
  6. Register the component in its module (import VaxideteModule if vd-* components are used)
  7. Report what was created using the structured output format
```

---

## Post-Dispatch: Verification

After the agent completes, verify the output:

1. **Check generated files exist:**
   ```
   Glob: "BabyCalendar.UI/src/app/pages/**/*.component.{html,scss,ts}"
   ```
   Confirm the expected component files were created.

2. **Verify module registration:**
   ```
   Grep: pattern="Component" in the new module file
   ```
   Ensure the component is declared and VaxideteModule is imported.

3. **Run build check** (if available):
   ```
   cd BabyCalendar.UI && npx ng build --configuration development 2>&1 | head -30
   ```
   Report any compilation errors back to the user.

4. **Browser verification** — Verify generated component using the three-tier hierarchy:
   - **Tier 2 (Primary):** Load Chrome DevTools via `ToolSearch: "chrome-devtools"`, use `take_snapshot` and `take_screenshot` to verify rendered output
   - **Tier 3 (Fallback):** If Chrome DevTools unavailable, load Playwright via `ToolSearch: "+playwright browser"`, use `browser_snapshot` and `browser_take_screenshot`

   See `.claude/agents/_gemini-design-hook.md` for the full protocol.

5. **Summary:** Report to the user what was created, any issues found, and next steps (e.g., wiring up TypeScript logic via `/fullstack-dev`).
