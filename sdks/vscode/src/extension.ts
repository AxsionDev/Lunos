// This method is called when your extension is deactivated
export function deactivate() {}

import * as vscode from "vscode"
import * as path from "path"
import { execFile } from "child_process"
import { INSTALL_COMMAND, INSTALL_DOCS, parseVersion, resolveBinary, versionWarning } from "./cli"

const TERMINAL_NAME = "Lunos"

export function activate(context: vscode.ExtensionContext) {
  const commands: Record<string, () => Promise<void>> = {
    openNewTerminal: async () => {
      await openTerminal()
    },
    openTerminal: async () => {
      // A Lunos terminal already exists => focus it
      const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
      if (existingTerminal) {
        existingTerminal.show()
        return
      }

      await openTerminal()
    },
    addFilepathToTerminal: async () => {
      const fileRef = getActiveFile()
      if (!fileRef) {
        return
      }

      const terminal = vscode.window.activeTerminal
      if (!terminal) {
        return
      }

      if (terminal.name === TERMINAL_NAME) {
        // @ts-ignore
        const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
        port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false)
        terminal.show()
      }
    },
  }

  for (const [name, run] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`lunos.${name}`, run))
    // The old command IDs keep custom keybindings working for one release. They aren't
    // contributed in package.json, so they don't appear in the command palette (XCOD-122).
    context.subscriptions.push(vscode.commands.registerCommand(`opencode.${name}`, run))
  }

  async function openTerminal() {
    const binary = resolveBinary({
      setting: vscode.workspace.getConfiguration("lunos").get<string>("path"),
      env: process.env,
      platform: process.platform,
    })
    if (!binary) {
      await showInstallHelp()
      return
    }
    void checkVersion(binary)

    // Create a new terminal in split screen
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env: {
        _EXTENSION_OPENCODE_PORT: port.toString(),
        OPENCODE_CALLER: "vscode",
        // Put the resolved binary first, so `lunos` below is the one we checked, in every shell.
        PATH: `${path.dirname(binary)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    })

    terminal.show()
    terminal.sendText(`lunos --port ${port}`)

    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    // Wait for the terminal to be ready
    let tries = 10
    let connected = false
    do {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await fetch(`http://localhost:${port}/app`)
        connected = true
        break
      } catch {}

      tries--
    } while (tries > 0)

    // If connected, append the prompt to the terminal
    if (connected) {
      await appendPrompt(port, `In ${fileRef}`)
      terminal.show()
    }
  }

  async function showInstallHelp() {
    const copy = "Copy install command"
    const docs = "Installation guide"
    const setPath = "Set lunos.path"
    const choice = await vscode.window.showErrorMessage(
      `The Lunos CLI isn't installed, or isn't on your PATH. Install it with: ${INSTALL_COMMAND}`,
      copy,
      docs,
      setPath,
    )
    if (choice === copy) await vscode.env.clipboard.writeText(INSTALL_COMMAND)
    if (choice === docs) await vscode.env.openExternal(vscode.Uri.parse(INSTALL_DOCS))
    if (choice === setPath) await vscode.commands.executeCommand("workbench.action.openSettings", "lunos.path")
  }

  /** Says which CLI version started, and warns if it's older than this extension supports. */
  async function checkVersion(binary: string) {
    const win = process.platform === "win32"
    const output = await new Promise<string>((resolve) =>
      // shell on Windows: npm installs `lunos.cmd`, which only runs through cmd.exe.
      // Quoted, because with a shell a path like "C:\\Program Files\\..." would split at the space.
      execFile(win ? `"${binary}"` : binary, ["--version"], { timeout: 10_000, shell: win }, (_error, stdout) =>
        resolve(String(stdout)),
      ),
    )
    const version = parseVersion(output)
    vscode.window.setStatusBarMessage(`Started Lunos ${version ? `v${version}` : "(local build)"}`, 10_000)
    const warning = versionWarning(version)
    if (warning) void vscode.window.showWarningMessage(warning)
  }

  async function appendPrompt(port: number, text: string) {
    await fetch(`http://localhost:${port}/tui/append-prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    })
  }

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) {
      return
    }

    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) {
      return
    }

    // Get the relative path from workspace root
    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`
      }
    }

    return filepathWithAt
  }
}
