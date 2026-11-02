# Lunos for VS Code

Start [Lunos](https://lunos.tech), the EU-sovereign, self-hostable AI coding agent, from VS Code, VSCodium or any other editor that installs from the VS Code Marketplace or Open VSX.

## Install

1. **Install the Lunos CLI.** The extension starts it; it doesn't include it.

   ```bash
   npm i -g lunos-ai@latest --allow-scripts=lunos-ai
   lunos --version
   ```

   npm 12 needs `--allow-scripts=lunos-ai`. Other ways to install are in the [installation guide](https://github.com/AxsionDev/Lunos#installation).

2. **Install this extension.** Search for "Lunos" in the Extensions view: VS Code installs from the VS Code Marketplace, VSCodium from Open VSX.

3. **Open Lunos** with `Cmd+Esc` (macOS) or `Ctrl+Esc` (Windows, Linux).

If the extension can't find `lunos` on your `PATH`, it tells you how to install it. It never starts a different program in its place. To use a `lunos` that isn't on your `PATH`, set **`lunos.path`** to its full path.

## Features

- **Quick launch:** `Cmd+Esc` / `Ctrl+Esc` opens Lunos in a split terminal, or focuses the one already open.
- **New session:** `Cmd+Shift+Esc` / `Ctrl+Shift+Esc`, or the Lunos button in the editor title bar, starts another Lunos terminal.
- **File references:** `Cmd+Option+K` / `Ctrl+Alt+K` adds the current file to the prompt, with the selected lines, for example `@src/app.ts#L37-42`.
- **Version check:** the status bar shows which Lunos CLI version started. The extension warns you if it's older than the oldest version it supports.

## Where your data goes

The extension itself sends nothing anywhere. It starts the Lunos CLI on your machine and talks to it on `localhost`.

The CLI sends prompts and code context only to the model provider **you** configure. Its other outbound calls, such as the model catalogue and the update check, carry no project data. With a data-residency policy it can be restricted to EU providers. There is no Lunos-operated service in the data path.

The details, including what is and isn't claimed, are in the [self-hosted deployment guide](https://github.com/AxsionDev/Lunos/blob/dev/docs/deployment/self-hosted.md).

## Documentation and support

- [Lunos on GitHub](https://github.com/AxsionDev/Lunos) and its [documentation](https://github.com/AxsionDev/Lunos/tree/dev/docs)
- Report issues at [github.com/AxsionDev/Lunos/issues](https://github.com/AxsionDev/Lunos/issues)

Lunos is MIT-licensed. It is a fork of opencode and is not affiliated with the opencode team. See [LICENSE](https://github.com/AxsionDev/Lunos/blob/dev/LICENSE).

## Development

1. `code sdks/vscode`: open the `sdks/vscode` directory in VS Code. **Don't open it from the repo root.**
2. `bun install` in `sdks/vscode`.
3. Press `F5` to launch a VS Code window with the extension loaded.
4. `bun test ./test` runs the unit tests.

`tsc` and `esbuild` watchers rebuild in the background while debugging. To see a change, run **Developer: Reload Window** in the debug window.
