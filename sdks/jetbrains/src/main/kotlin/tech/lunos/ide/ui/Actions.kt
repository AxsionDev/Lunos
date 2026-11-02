package tech.lunos.ide.ui

import com.intellij.codeInsight.daemon.impl.DaemonCodeAnalyzerEx
import com.intellij.codeInsight.daemon.impl.HighlightInfo
import com.intellij.ide.util.PropertiesComponent
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import tech.lunos.ide.core.LunosServer
import tech.lunos.ide.core.Problem
import tech.lunos.ide.core.PromptContext
import tech.lunos.ide.core.Selection
import java.awt.datatransfer.StringSelection
import java.io.File
import javax.swing.JComponent

/** Right-click "Ask Lunos about Selection": the open file and the selected lines go with the prompt. */
class AskAboutSelectionAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)?.let { File(it.path) }
        val selection = selection(editor)
        val service = LunosService.get(project)
        val where = file?.let { PromptContext.reference(it, service.root, selection) } ?: "the selection"
        val text = Messages.showMultilineInputDialog(project, "Ask Lunos about $where", "Ask Lunos", "", null, null) ?: return
        if (text.isBlank()) return
        ToolWindowManager.getInstance(project).getToolWindow("Lunos")?.show()
        LunosService.onPooled(project) { service.send(text, file, selection) }
    }

    companion object {
        /** 1-based, inclusive lines of the selection; null without one. */
        fun selection(editor: Editor): Selection? {
            val model = editor.selectionModel
            if (!model.hasSelection()) return null
            val document = editor.document
            val start = document.getLineNumber(model.selectionStart) + 1
            // A selection ending at the start of a line doesn't include that line.
            val endOffset = model.selectionEnd
            val endLine = document.getLineNumber(endOffset)
            val end = if (endOffset > model.selectionStart && document.getLineStartOffset(endLine) == endOffset) endLine else endLine + 1
            return Selection(start, maxOf(start, end))
        }
    }
}

/** "Send Problems to Lunos": this file's errors and warnings from the IDE's inspections, as context. */
class SendProblemsAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val problems = problems(project, editor, vf)
        if (problems.isEmpty()) {
            Messages.showInfoMessage(project, "The IDE reports no errors or warnings in this file.", "Lunos")
            return
        }
        val text = Messages.showMultilineInputDialog(project, "Send ${problems.size} problem(s) to Lunos", "Lunos", "Fix these problems.", null, null)
            ?: return
        ToolWindowManager.getInstance(project).getToolWindow("Lunos")?.show()
        val service = LunosService.get(project)
        LunosService.onPooled(project) { service.send(text, File(vf.path), AskAboutSelectionAction.selection(editor), problems) }
    }

    private fun problems(project: Project, editor: Editor, vf: VirtualFile): List<Problem> {
        val document = editor.document
        val root = LunosService.get(project).root
        val path = PromptContext.relative(File(vf.path), root)
        val result = mutableListOf<Problem>()
        DaemonCodeAnalyzerEx.processHighlights(document, project, HighlightSeverity.WEAK_WARNING, 0, document.textLength) { info: HighlightInfo ->
            val message = info.description
            if (!message.isNullOrBlank()) {
                result += Problem(path, document.getLineNumber(info.startOffset) + 1, info.severity.name, message)
            }
            true
        }
        return result.distinct()
    }
}

/** Opens the review of the last prompt's edits. */
class ReviewChangesAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        ReviewChangesDialog.show(project, LunosService.get(project).pendingReview)
    }
}

/** An action the panel can run for a project without an AnActionEvent. */
interface ProjectAction {
    fun run(project: Project)
}

/** The TUI on the panel's session, attached to the same server, so approvals can be answered in either. */
object OpenTui {
    fun open(project: Project) {
        // Registered only when the terminal plugin is there (lunos-terminal.xml).
        val action = ActionManager.getInstance().getAction("Lunos.OpenTui") as? ProjectAction
        if (action != null) {
            action.run(project)
            return
        }
        // Without the terminal plugin: the command to run it yourself.
        LunosService.onPooled(project) {
            val service = LunosService.get(project)
            val client = service.connect()
            val binary = service.binary() ?: "lunos"
            val command = LunosServer.attachCommand(binary, client.url, service.root, service.state?.sessionID).joinToString(" ")
            CopyPasteManager.getInstance().setContents(StringSelection(command))
            NotificationGroupManager.getInstance().getNotificationGroup("Lunos")
                .createNotification(
                    "Lunos TUI",
                    "The terminal plugin isn't enabled. The command is on the clipboard; run it with OPENCODE_SERVER_PASSWORD set.",
                    NotificationType.INFORMATION,
                )
                .notify(project)
        }
    }
}

/** Settings | Tools | Lunos: the path to the `lunos` executable when it isn't on PATH. */
class LunosConfigurable : Configurable {
    private val path = JBTextField()

    override fun getDisplayName() = "Lunos"

    override fun createComponent(): JComponent = FormBuilder.createFormBuilder()
        .addLabeledComponent("Path to lunos:", path)
        .addComponentFillVertically(javax.swing.JPanel(), 0)
        .panel

    override fun isModified() = path.text != (PropertiesComponent.getInstance().getValue(LunosService.PATH_SETTING) ?: "")

    override fun apply() = PropertiesComponent.getInstance().setValue(LunosService.PATH_SETTING, path.text.trim(), "")

    override fun reset() {
        path.text = PropertiesComponent.getInstance().getValue(LunosService.PATH_SETTING) ?: ""
    }
}
