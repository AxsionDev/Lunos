# Browser & computer control

Lunos can operate a web browser for you. It can check the app it just built, click through an admin console, reproduce a UI bug or collect information from pages. You stay in control the whole time:

- it's off until you turn it on;
- it asks before it acts on each site;
- it confirms with you before anything that submits, sends, buys, downloads or deletes;
- some things it never does;
- you can stop it at once;
- every action is in the audit log.

Lunos can also operate desktop apps on macOS and Windows, with screenshots, the mouse, the keyboard and the clipboard. It uses the same approvals, stop key and audit trail. See [Computer control](#computer-control) below.

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
- The **stop key**: `ctrl+alt+escape` by default (`browser.stop_key`). It works in the controlled browser, and on macOS and Windows also from any other app while the agent is driving the browser. Lunos checks it every 40 ms (on macOS this may need **Input Monitoring** for the app Lunos runs in, on some versions). On Linux and inside a sandbox it works in the controlled browser only.
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

## Computer control

Computer control lets the agent operate desktop apps for tasks with no API or command line: a desktop admin tool, an installer, or a native app under test. It sees the screen, moves and clicks the mouse, types, presses keys, opens apps and uses the clipboard. It's a separate switch from browser control, and the same rules keep you in control.

### Turn it on

`/settings` › **Permissions** › **Browser & computer** › `computer.enabled` → `true`. Or:

```json
{ "computer": { "enabled": true } }
```

Only the **qa** and **general** agents get the `computer` tool. An organisation turns it off by locking it:

```json
{ "computer": { "enabled": false }, "$locked": ["computer.enabled"] }
```

The tool is then absent for every agent, and `/settings` says it was turned off by your organisation. `computer.allow`, `computer.deny`, `computer.deny_categories` and `computer.screenshots` can be locked too.

### Set up, per OS

Run `lunos computer status` to see what's missing, and `lunos computer setup` to fix it.

- **macOS:** two permissions, granted to the app Lunos runs in (your terminal, or the Lunos desktop app), not to Lunos itself:
  - **Accessibility** (System Settings › Privacy & Security › Accessibility) lets Lunos move the mouse, type, and read app windows;
  - **Screen & System Audio Recording** lets it take screenshots.

  Turn both on, then quit and reopen that app. `lunos computer setup` opens the right page. Under tmux or a terminal multiplexer, the app is the one that started it: `lunos computer status` names it.

- **Windows:** no permission is needed. Lunos uses SendInput for the mouse and keyboard, UI Automation to read windows, and GDI for screenshots. Apps running as administrator can't be controlled from a normal Lunos.
- **Linux:** not supported yet. On Wayland, apps can't be driven from outside without the desktop's permission portals; X11 support isn't built. Lunos says so instead of trying.

### Text first

The agent reads an app's window through the accessibility tree (`read`): its buttons, fields, values and where each one is. That works with any model, including text-only EU models. A screenshot needs a model that can see images; with a text-only model, Lunos refuses the screenshot and says why, and the agent reads the window instead. Under a residency policy, only models it allows are offered in `/models`.

### Apps

The first time the agent acts on an app, Lunos asks: **Allow once** (until your next message), **Always allow** (until Lunos restarts) or **Deny**. Apps are named by their bundle id on macOS (`com.apple.TextEdit`) or executable on Windows (`notepad.exe`), which an app can't fake the way it can a window title.

```json
{ "computer": { "allow": ["com.apple.TextEdit", "com.example.*"], "deny": ["com.example.admin"] } }
```

Refused by default (`computer.deny_categories`): banking, payment, password-manager (including Keychain Access and Passwords), system-settings and terminal apps. Typing into a terminal would run commands outside Lunos's own shell rules. An app you name in `allow` is allowed even in one of those categories. **The app Lunos runs in is always refused**, whatever the config says: the agent could otherwise answer its own approval prompts.

The app is checked before every action: for a click, the app whose window is under the pointer; for typing, the app with keyboard focus. Lunos checks again while it types, and stops if focus moves to another app. A click that brings a refused app to the front is reported, and nothing more is done there. A screenshot is refused while a password manager, banking or deny-listed app is visible anywhere on screen.

### Always asks first

- a click on anything that submits, sends, buys, pays, deletes, publishes or accepts, as read from the accessibility tree;
- Return in a window whose default button does one of those;
- key combinations that delete (Cmd+Backspace, Shift+Delete…);
- anything the agent itself says can't be undone;
- every clipboard read and write. A key or card number on the clipboard is never sent to the model.

These prompts are always answered by you, even in Auto-approve. `lunos run --auto` refuses them.

### Never done

Whatever the agent is told, and whatever is on screen, it never types into a password field, or anywhere while macOS secure keyboard entry is on. Secure keyboard entry turns on whenever a password field anywhere has focus, and some apps (Terminal's "Secure Keyboard Entry", password managers) turn it on themselves. It never types or copies a password, card number, IBAN, ID number, or API key or token. It never solves CAPTCHAs, never opens system settings and never presses the stop key.

### The screen is data, not instructions

What the agent reads from a window is marked as untrusted. When a screenshot is taken, Lunos also reads the front window's text and checks it. Instructions aimed at an AI agent are shown to you in the session ("the screen has instructions for the agent (not followed)"), the agent is told not to follow them, and a `computer.injection` audit line is written.

### Stop

- **The stop key**, anywhere on the computer: `ctrl+alt+escape` by default (`computer.stop_key`). Lunos checks it every 40 ms, so control ends well within 200 ms. It stops browser control too.
- **Stop** on the "Lunos is controlling your computer" strip at the top of the screen, shown while the agent is in control. The strip never takes keyboard focus.
- **Move the mouse yourself** and the agent pauses (on Windows, any input you make).
- `Esc` in Lunos interrupts the session as usual.

Input is sent a character or a click at a time, and nothing more is sent once you stop. The next action asks you before control resumes. On macOS, reading the stop key may need **Input Monitoring** for the app Lunos runs in, on some versions.

### Audit and what leaves your computer

Every action writes a `computer.action` line: the action, the app, the agent, how it was approved and the outcome. Refused apps write `computer.denied`, stops write `computer.stop`, and planted instructions write `computer.injection`. The log never holds what was typed, the clipboard or screenshots.

Screenshots and window text go to the session's model, under the same `residency` policy as everything else; a screenshot to a model the policy doesn't allow, or to a model Lunos can't identify, is refused before it's taken. Screenshots are held in memory for the next model request and never stored (`computer.screenshots: true` keeps them in the session). On macOS the image passes through a temporary file readable only by you, deleted before the tool returns; on Windows it never touches the disk.

### Sandbox

Computer control acts on your computer, outside any sandbox, so it's refused while the session runs in one, with a message saying so. The browser tool works inside the sandbox.
