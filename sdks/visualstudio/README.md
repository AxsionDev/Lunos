# Lunos for Visual Studio

Lunos in Visual Studio 2022 (17.x) and later. It needs the Lunos CLI:
`npm i -g lunos-ai@latest --allow-scripts=lunos-ai`. If `lunos` isn't on PATH, set its location in
**Tools > Options > Lunos**.

- **View > Other Windows > Lunos** opens the tool window, with:
  - a session picker, listing the same sessions as the TUI's `/sessions`;
  - the model and the approval mode (Manual, or Auto-approve);
  - the chat, the subagents with their state, and approvals with Allow once, Always and Reject.
- **Right-click in the editor > Ask Lunos about Selection** (Ctrl+Alt+L): sends the open file and the
  selected lines with the prompt.
- **Error List > right-click > Send to Lunos:** sends the selected entries, or all the visible ones
  when none are selected.
- **Review changes:** when a prompt finishes, its edits are listed hunk by hunk.
  - **Show diff** opens the file in the Visual Studio diff viewer, comparing it before Lunos with the
    result of your current choices.
  - **Apply choices** writes that result through the editor.
- **Open in TUI** (Tools menu): runs `lunos attach` on the same session in a console window. Visual
  Studio has no public API to run a command in its integrated Terminal.

The extension works on the solution's folder, or on the open folder. The protocol is described in
[`../ide/PROTOCOL.md`](../ide/PROTOCOL.md).

## Layout and build

- `src/Lunos.Core` is netstandard2.0. It holds the protocol client, hunks, prompt context and session
  state, and it builds and is tested on any OS: `dotnet test test/Lunos.Core.Tests`.
- `src/Lunos.VisualStudio` is the VSIX, an in-process VSSDK `AsyncPackage`. It builds only on Windows
  with Visual Studio's MSBuild:

  ```
  msbuild src/Lunos.VisualStudio/Lunos.VisualStudio.csproj /restore /p:Configuration=Release
  ```

  `.github/workflows/ide-plugins.yml` builds it on `windows-2022`.

Lunos is not affiliated with Microsoft.
