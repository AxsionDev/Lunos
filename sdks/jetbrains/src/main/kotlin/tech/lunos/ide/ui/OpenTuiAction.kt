package tech.lunos.ide.ui

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.util.SystemInfo
import org.jetbrains.plugins.terminal.TerminalToolWindowManager
import tech.lunos.ide.core.LunosServer
import java.io.File
import java.nio.file.Files
import java.nio.file.attribute.PosixFilePermissions

/**
 * "Open Lunos TUI in Terminal" (loaded only with the terminal plugin, lunos-terminal.xml): `lunos attach`
 * to the plugin's server on the panel's session, in a terminal tab. The server password reaches it
 * through a short-lived script readable only by the user, which deletes itself, so it is never on a
 * command line or in shell history.
 */
class OpenTuiAction : DumbAwareAction(), ProjectAction {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        run(e.project ?: return)
    }

    override fun run(project: com.intellij.openapi.project.Project) {
        val service = LunosService.get(project)
        LunosService.onPooled(project) {
            val client = service.connect()
            val binary = service.binary() ?: "lunos"
            val command = LunosServer.attachCommand(binary, client.url, service.root, service.state?.sessionID)
            val password = service.server?.password
            val script = script(command, password)
            // Only the script's path reaches the shell's history.
            val run = if (SystemInfo.isWindows) "cmd.exe /c \"${script.path}\"" else "/bin/sh '${script.path}'"
            ApplicationManager.getApplication().invokeLater {
                TerminalToolWindowManager.getInstance(project).createShellWidget(service.root.path, "Lunos", true, false)
                    .sendCommandToExecute(run)
            }
        }
    }

    private fun script(command: List<String>, password: String?): File {
        if (SystemInfo.isWindows) {
            val file = Files.createTempFile("lunos-tui", ".cmd").toFile()
            val quoted = command.joinToString(" ") { "\"$it\"" }
            // One line: cmd has read it all before `del` removes the file.
            file.writeText("@${if (password != null) "set \"OPENCODE_SERVER_PASSWORD=$password\" & " else ""}del \"%~f0\" & $quoted\r\n")
            return file
        }
        val file = Files.createTempFile("lunos-tui", ".sh", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------"))).toFile()
        val quoted = command.joinToString(" ") { "'" + it.replace("'", "'\\''") + "'" }
        file.writeText(
            "rm -f \"$0\"\n" +
                (if (password != null) "OPENCODE_SERVER_PASSWORD='$password'\nexport OPENCODE_SERVER_PASSWORD\n" else "") +
                "exec $quoted\n",
        )
        return file
    }
}
