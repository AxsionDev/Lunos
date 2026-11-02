# Lunos for JetBrains IDEs

Lunos in IntelliJ IDEA, Rider and the other IntelliJ-based IDEs (2025.2 and later). It needs the Lunos
CLI: `npm i -g lunos-ai@latest --allow-scripts=lunos-ai`. If `lunos` isn't on PATH, set its location
in **Settings | Tools | Lunos**.

- **Lunos tool window:**
  - a session picker, listing the same sessions as the TUI's `/sessions`;
  - the model and the approval mode (Manual, or Auto-approve);
  - the chat, the subagents with their state, and approvals with Allow once, Always and Reject.
- **Right-click > Ask Lunos about Selection** (Ctrl+Alt+L): sends the open file and the selected lines
  with the prompt.
- **Right-click > Send Problems to Lunos:** sends the file's errors and warnings from inspections.
- **Review changes:** when a prompt finishes, its edits open hunk by hunk next to the IDE's diff
  viewer. Uncheck a hunk to reject it, then choose **Apply Choices**.
- **Open in TUI:** opens `lunos attach` on the same session in the IDE's terminal.

The plugin talks to a local `lunos serve` that it starts. The protocol is described in
[`../ide/PROTOCOL.md`](../ide/PROTOCOL.md).

## Build

You need JDK 21.

```
./gradlew buildPlugin test verifyPlugin   # the plugin is built to build/distributions/*.zip
./gradlew runIde                          # starts a sandbox IDE with the plugin installed
```

The test `RealServerTest` runs against a real server when `LUNOS_E2E_BIN` points at a `lunos`
executable. That can be a script that runs the dev build: `bun run --cwd packages/opencode src/index.ts "$@"`.

Lunos is not affiliated with JetBrains.
