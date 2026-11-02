# Lunos browser extension

Lets Lunos operate your own Chrome, Edge or Brave ("My browser", `browser.mode: "extension"`), when browser control is on. See [docs/browser-control.md](../docs/browser-control.md).

- Connects to Lunos on `ws://127.0.0.1` only, with the pairing code `lunos browser pair` prints. Lunos refuses any connection that isn't from a browser extension or doesn't present the code.
- Relays the DevTools Protocol to the tab Lunos works in, through `chrome.debugger`. Chrome shows "Lunos started debugging this browser" while it does; **Cancel** there, or **Stop** in the popup, ends control at once.
- Cancels any download Lunos didn't confirm with you first.
- Every decision (which sites, what needs your confirmation, what is never done) is made in Lunos, not here.

It isn't published to any extension store. To install it: `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
