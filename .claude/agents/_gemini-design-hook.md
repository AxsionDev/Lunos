# Gemini Design MCP Hook

## Purpose

Shared protocol for agents that create Angular HTML/SCSS. Attempt Gemini Design MCP first for premium visual output, with graceful fallback to manual coding.

## Applicability Matrix

| Task Type                       | Use Gemini? | Reason                                      |
| ------------------------------- | ----------- | ------------------------------------------- |
| New component templates (HTML)  | YES         | Gemini excels at layout generation          |
| Component SCSS styling          | YES         | Gemini produces polished, consistent styles |
| Page redesigns / visual refresh | YES         | Feed existing HTML to `modify_frontend`     |
| Adding a UI section to a page   | YES         | Use `snippet_frontend`                      |
| TypeScript services / models    | NO          | Gemini only generates markup + styles       |
| Routing / module configuration  | NO          | Not visual work                             |
| Bug fixes in existing logic     | NO          | Requires precise, targeted edits            |
| Unit tests                      | NO          | Not visual work                             |

## Protocol Steps

### Step 1: Load Gemini Tools

```
ToolSearch: "gemini-design"
```

This loads the deferred MCP tools. They are NOT available until loaded.

### Step 2: Load Design System

Look for design context in this priority order:

1. `design-system.md` in project root
2. `.claude/docs/ui-ux-documentation.md`
3. Existing component SCSS for token/convention reference

Read the file and store its content — you will pass it as the `designSystem` parameter.

### Step 3: Select the Correct Tool

| Scenario                                  | Tool                                       |
| ----------------------------------------- | ------------------------------------------ |
| New page or component from scratch        | `mcp__gemini-design-mcp__create_frontend`  |
| Redesign / update existing component      | `mcp__gemini-design-mcp__modify_frontend`  |
| Add a section or snippet to existing page | `mcp__gemini-design-mcp__snippet_frontend` |

### Step 4: Mandatory Parameters

**Every Gemini call MUST include:**

```
techStack: "Angular 15 + TypeScript + Bootstrap 4 + SCSS + ng-bootstrap"
```

**Every `request` parameter MUST include Angular syntax instructions:**

```
"Create an Angular component template (NOT React/JSX). Use Angular template syntax:
  - *ngIf, *ngFor (NOT {condition && ...} or .map())
  - [property]='value' for binding (NOT property={value})
  - (event)='handler()' for events (NOT onClick={handler})
  - class='name' (NOT className='name')
  [Your actual design request here]"
```

**Pass `designSystem`** with the content loaded in Step 2.

### Step 5: Fallback Mechanism

If the Gemini call fails, **do NOT retry**. Proceed with manual coding.

**Failure conditions (any of these):**

- Error response containing: "token", "limit", "rate", "quota", "unavailable"
- Empty response or response shorter than 50 characters
- Response is predominantly JSX (multiple `className=`, `onClick={`, `.map(`)
- ToolSearch returns no matching tools (Gemini MCP not configured)

**Fallback procedure:**

1. Log: "Gemini Design MCP was attempted but unavailable; falling back to manual coding."
2. Use `.claude/patterns/frontend-patterns.md` for code patterns
3. Reference design tokens from `design-system.md` or project docs
4. Scan existing similar components in the codebase for conventions
5. Hand-code the HTML/SCSS following project patterns
6. Include a note in output: "Note: Gemini was unavailable; HTML/SCSS was hand-coded."

### Step 6: Post-Processing (on successful Gemini response)

**JSX-to-Angular conversion table — fix any leakage:**

| JSX Pattern                  | Angular Replacement                            |
| ---------------------------- | ---------------------------------------------- |
| `className="..."`            | `class="..."`                                  |
| `onClick={...}`              | `(click)="..."`                                |
| `onChange={...}`             | `(change)="..."`                               |
| `{condition && <div>}`       | `<div *ngIf="condition">`                      |
| `{items.map(item => ...)}`   | `<div *ngFor="let item of items">`             |
| `style={{ color: 'red' }}`   | `[ngStyle]="{ color: 'red' }"` or inline style |
| `{variable}` (interpolation) | `{{ variable }}`                               |
| `htmlFor="..."`              | `for="..."`                                    |
| Self-closing `<div />`       | `<div></div>`                                  |

**Hardcoded color replacement:**

- Replace any hardcoded hex color values with project CSS custom properties (e.g., `--vd-*` tokens or Bootstrap variables) where a matching token exists.

## Browser Verification & Debugging Hierarchy

After generating or fixing code via Gemini (Tier 1), you may need to verify results in the browser or debug runtime issues. Follow this priority order:

### Tier 2: Chrome DevTools MCP (Primary Browser Tool)

Load via `ToolSearch: "chrome-devtools"` before use.

| Tool                                          | Purpose                                    |
| --------------------------------------------- | ------------------------------------------ |
| `mcp__chrome-devtools__take_snapshot`         | Capture page DOM / accessibility tree      |
| `mcp__chrome-devtools__take_screenshot`       | Visual screenshot of the page              |
| `mcp__chrome-devtools__list_console_messages` | Check for JS runtime errors                |
| `mcp__chrome-devtools__evaluate_script`       | Run JS to inspect computed styles or state |
| `mcp__chrome-devtools__navigate_page`         | Navigate to a URL                          |
| `mcp__chrome-devtools__resize_page`           | Test responsive breakpoints                |

### Tier 3: Playwright MCP (Last Resort — When Chrome DevTools Is Unavailable)

Load via `ToolSearch: "+playwright browser"` before use.

| Playwright Tool                                               | Equivalent Chrome DevTools Tool |
| ------------------------------------------------------------- | ------------------------------- |
| `mcp__plugin_playwright_playwright__browser_snapshot`         | `take_snapshot`                 |
| `mcp__plugin_playwright_playwright__browser_take_screenshot`  | `take_screenshot`               |
| `mcp__plugin_playwright_playwright__browser_console_messages` | `list_console_messages`         |
| `mcp__plugin_playwright_playwright__browser_network_requests` | `list_network_requests`         |
| `mcp__plugin_playwright_playwright__browser_click`            | (interaction — Tier 3 only)     |
| `mcp__plugin_playwright_playwright__browser_type`             | (interaction — Tier 3 only)     |
| `mcp__plugin_playwright_playwright__browser_navigate`         | `navigate_page`                 |

**Fallback condition:** If Chrome DevTools tools are not available (ToolSearch returns no results for "chrome-devtools"), fall back to the equivalent Playwright tools listed above.

---

## Tool Selection by Task Type

| Task                       | Tier 1: Gemini                         | Tier 2: Chrome DevTools            | Tier 3: Playwright                            |
| -------------------------- | -------------------------------------- | ---------------------------------- | --------------------------------------------- |
| **Generate HTML/SCSS**     | `create_frontend` / `snippet_frontend` | —                                  | —                                             |
| **Fix/redesign markup**    | `modify_frontend`                      | —                                  | —                                             |
| **Verify rendered output** | —                                      | `take_snapshot`, `take_screenshot` | `browser_snapshot`, `browser_take_screenshot` |
| **Debug console errors**   | —                                      | `list_console_messages`            | `browser_console_messages`                    |
| **Inspect network calls**  | —                                      | `list_network_requests`            | `browser_network_requests`                    |
| **Test responsive layout** | —                                      | `resize_page` + `take_snapshot`    | `browser_resize` + `browser_snapshot`         |
| **Click/type interaction** | —                                      | —                                  | `browser_click`, `browser_type`               |
| **Navigate to page**       | —                                      | `navigate_page`                    | `browser_navigate`                            |

---

## Bug-Fix Browser Workflow: Reproduce → Fix → Verify

When fixing a frontend bug with UI impact, you MUST follow this three-phase workflow. Do NOT skip the reproduction phase.

### Phase A: Reproduce (Pre-Fix Baseline) — MANDATORY for UI bugs

**Before any code changes**, capture the broken state as evidence:

1. **Navigate** — `navigate_page` (Tier 2) or `browser_navigate` (Tier 3)
2. **Screenshot** — `take_screenshot` (Tier 2) or `browser_take_screenshot` (Tier 3) → `bug-pre-fix-baseline.png`
3. **Snapshot** — `take_snapshot` (Tier 2) or `browser_snapshot` (Tier 3)
4. **Console errors** — `list_console_messages` (Tier 2) or `browser_console_messages` (Tier 3)
5. **Network state** (if relevant) — `list_network_requests` (Tier 2) or `browser_network_requests` (Tier 3)

**Skip condition:** If the bug has NO UI/visual impact (backend-only), skip Phase A and note: "Pre-fix browser baseline skipped: no UI impact."

### Phase B: Fix

Apply the fix using the appropriate method (Gemini Tier 1, manual code edit, etc.).

### Phase C: Verify (Post-Fix Comparison) — MANDATORY for UI bugs

**After the fix**, verify AND compare against baseline:

1. **Refresh / re-navigate** to the bug location
2. **Screenshot** → `bug-post-fix-verified.png`
3. **Snapshot** — capture fixed DOM state
4. **Console errors** — confirm pre-fix errors are gone
5. **Network state** — confirm pre-fix failures are resolved
6. **Produce Before/After Comparison** table in your report

---

## Quick Reference (copy into agent sections)

```
## UI Tool Hierarchy — Gemini → ChromeDevTools → Playwright

| Tier | Tool | Load Via | Use For |
|------|------|----------|---------|
| **1 (Primary)** | Gemini Design MCP | `ToolSearch: "gemini-design"` | Generate/fix HTML, SCSS, visual markup |
| **2 (Fallback)** | Chrome DevTools MCP | `ToolSearch: "chrome-devtools"` | Browser verification, DOM inspection, screenshots, console, network |
| **3 (Last Resort)** | Playwright MCP | `ToolSearch: "+playwright browser"` | Full browser interaction when Chrome DevTools is unavailable |

**Escalation:** Try Tier 1 first. If Gemini fails or doesn't apply → use Tier 2. If Chrome DevTools is unavailable → fall back to Tier 3.

Steps:
1. ToolSearch: "gemini-design" → load Gemini tools
2. Read design-system.md (or .claude/docs/ui-ux-documentation.md) → load design context
3. Call appropriate Gemini tool (create/modify/snippet) with techStack + Angular syntax + designSystem
4. If Gemini fails → fall back to manual HTML/SCSS using project patterns
5. If Gemini succeeds → post-process: fix JSX→Angular syntax, replace hardcoded colors
6. **For bug fixes:** Reproduce → Fix → Verify (see "Bug-Fix Browser Workflow" above)
7. **For new features:** Verify in browser → ToolSearch: "chrome-devtools" (Tier 2) or ToolSearch: "+playwright browser" (Tier 3 fallback)
```

See `.claude/agents/_gemini-design-hook.md` for the full protocol.
