# Browser & computer control

Lunos can operate a web browser for you. It can check the app it just built, click through an admin console, reproduce a UI bug or collect information from pages. You stay in control the whole time:

- it's off until you turn it on;
- it asks before it acts on each site;
- it confirms with you before anything that submits, sends, buys, downloads or deletes;
- some things it never does;
- you can stop it at once;
- every action is in the audit log.

Computer control (desktop apps, mouse and keyboard) isn't available yet. It will use the same approvals, stop key and audit trail.

## Turn it on

`/settings` › **Permissions** › **Browser & computer** › `browser.enabled` → `true`. Or in `opencode.json`:

```json
{ "browser": { "enabled": true } }
```

Only the **qa** and **general** agents get the browser tool. Build hands browser checks to qa: Build starts the dev server, and qa opens it in the browser, clicks through the change and reports what it saw. To give another agent the tool, allow it in that agent's permissions, e.g. `"agent": { "build": { "permission": { "browser": "ask" } } }`.

An organisation turns browser control off by locking it in managed config:

```json
{ "browser": { "enabled": false }, "$locked": ["browser.enabled"] }
```

The tool is then absent for every agent, and `/settings` shows **Turned off by your organisation**. An organisation can also lock `browser.mode`, `browser.allow`, `browser.deny`, `browser.deny_categories` and `browser.screenshots`, or `permission.browser`.

## Which browser

| `browser.mode`    | What it controls                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lunos` (default) | **The Lunos browser.** A Chrome, Chromium, Edge or Brave already on your computer, started with a separate profile Lunos keeps in its data folder. Its logins and cookies persist between sessions and never mix with yours. |
| `extension`       | **My browser.** Your own Chrome, Edge or Brave, through the Lunos extension.                                                                                                                                                 |

### The Lunos browser, per OS

Lunos looks for, in this order: Google Chrome, Chromium, Microsoft Edge, Brave.

- **macOS:** in `/Applications` (or `~/Applications`). No extra permissions are needed: Lunos controls the browser through its DevTools connection, not the screen.
- **Windows:** under `Program Files`, `Program Files (x86)` or your `AppData\Local`.
- **Linux:** `google-chrome`, `chromium`, `chromium-browser`, `microsoft-edge` or `brave-browser` in `/usr/bin`, or the Chromium snap.

If yours is elsewhere, set `browser.executable`. `browser.headless: true` runs it without a window. Its DevTools endpoint listens on `127.0.0.1` only, on a port the system picks.

### My browser (the extension)

1. In Chrome, Edge or Brave open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick the `browser-extension` folder of the Lunos source. The extension isn't in any extension store yet.
2. Run `lunos browser pair` in a terminal and paste the code into the extension's popup. The code is a random 256-bit value, kept in a file only you can read. It's never shown to a model.
3. Set `browser.mode` to `extension`.

The extension connects to Lunos on `ws://127.0.0.1:47615` (`browser.port` changes it). That port is never exposed to the network. Lunos accepts only a connection that comes from a browser extension and presents the code. A web page can't connect, even from your own browser. While Lunos works in a tab, Chrome shows "Lunos started debugging this browser".

## Sites

The first time the agent acts on a site, Lunos asks: **Allow once** (until your next message), **Always allow** (this site, until Lunos restarts) or **Deny**. To decide ahead of time:

```json
{
  "browser": {
    "allow": ["localhost", "127.0.0.1", "*.staging.example.com"],
    "deny": ["example-bank.com"]
  }
}
```

`deny` wins over everything. Banking, payment, password-manager and browser or system settings sites are refused by default (`browser.deny_categories`). A site you name in `allow` is allowed even in one of those categories. The site is checked before every action, not only when a page opens. A click or a redirect that lands on a refused site is stopped, and the tab is cleared.

`permission.browser` rules work too, per site: `"permission": { "browser": { "localhost": "allow" } }`. A wildcard `"*": "allow"` rule doesn't approve every site.

## Always asks first

Lunos asks before the agent:

- submits a form (clicks a submit button, or presses Enter in a form field);
- downloads a file;
- clicks anything that sends, posts, publishes, buys, orders, pays, subscribes, signs up, transfers, deletes or removes;
- accepts terms or cookies.

The prompt says exactly what will happen, for example: `Submit the form with "Save profile" (sends the form to https://…/save, POST)`. These prompts are always answered by you, even in Auto-approve. `lunos run --auto` refuses them. A download you didn't confirm is canceled.

## Never done

Whatever the agent is told, and whatever a page says, it never:

- types a password, card number, bank account (IBAN) or ID number, or an API key or token, into any field;
- types into password, card, security-code or one-time-code fields;
- solves a CAPTCHA;
- opens browser or system settings.

It hands those steps to you. Screenshots blur password and card fields.

## Pages are data, not instructions

Everything the agent reads from a page is marked as untrusted content. Text on a page can't change the agent's task, rules or permissions. When a page contains instructions aimed at an AI agent ("ignore your previous instructions…"), Lunos:

- tells the agent not to follow them;
- flags the step in the session ("page has instructions for the agent (not followed)");
- writes a `browser.injection` audit line.

## Stop

- **Stop** on the "Lunos is controlling this browser" indicator, in the corner of every page it controls.
- The **stop key**, pressed in the controlled browser: `ctrl+alt+escape` by default (`browser.stop_key`).
- In My browser: **Stop** in the extension's popup, or **Cancel** on Chrome's debugging bar.
- `Esc` in Lunos interrupts the session as usual.

Stopping ends every browser action at once. Moving the mouse in the controlled browser pauses the agent. Either way, it asks you before it goes on.

## Audit

Every action writes a `browser.action` line to the audit log: action, site, agent, session, how it was approved and the outcome. Refused sites write `browser.denied`, stops write `browser.stop`, and planted instructions write `browser.injection`. See [audit-log.md](audit-log.md). The log never holds page text, what was typed or screenshots.

## What leaves your computer

- **To the model:** what the agent reads, which is the page's accessibility outline or text, and screenshots when it takes one. They go to the model the session uses, under the same `residency` policy as everything else. Under an EU-only policy they go only to EU models: a screenshot to any other model is refused before it's taken.
- **Text first:** the agent reads pages as text, which works with text-only models, including EU ones, and sends less. A screenshot needs a model that can see images. With a text-only model, Lunos refuses the screenshot and the agent reads the page instead.
- **Screenshots aren't kept.** A screenshot is held in memory for the next model request and never written to the session history, the audit log, session sync or shares. Set `browser.screenshots: true` to keep them in the session.
- **Nothing else.** The browser, its profile and the extension connection stay on your computer.

## Sandbox

When the session runs in a sandbox, the agent uses the Lunos browser inside the sandbox, headless. The sandbox image needs Chromium installed. My browser is on your computer, outside the sandbox, so it's refused with a message saying so.
