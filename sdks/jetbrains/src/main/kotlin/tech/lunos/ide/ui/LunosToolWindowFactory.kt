package tech.lunos.ide.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBSplitter
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import tech.lunos.ide.core.Change
import tech.lunos.ide.core.PermissionRequest
import tech.lunos.ide.core.SessionInfo
import tech.lunos.ide.core.Subagent
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.DefaultListModel
import javax.swing.JButton
import javax.swing.JPanel

private fun <T> renderer(empty: String, text: (T) -> String) = object : SimpleListCellRenderer<T>() {
    override fun customize(list: javax.swing.JList<out T>, value: T?, index: Int, selected: Boolean, hasFocus: Boolean) {
        this.text = if (value == null) empty else text(value)
    }
}

class LunosToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = LunosPanel(project)
        val content = ContentFactory.getInstance().createContent(panel, "", false)
        Disposer.register(content, panel)
        toolWindow.contentManager.addContent(content)
    }
}

/**
 * The chat panel (XCOD-333): session picker, model and approval mode, transcript, subagents,
 * approvals waiting for an answer, the review of the last edits, and the prompt.
 */
class LunosPanel(private val project: Project) : JPanel(BorderLayout()), Disposable {
    private val service = LunosService.get(project)
    private val sessions = ComboBox(DefaultComboBoxModel<SessionInfo>())
    private val indicator = JBLabel()
    private val auto = JBCheckBox("Auto-approve")
    private val transcript = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
    }
    private val subagentModel = DefaultListModel<Subagent>()
    private val subagents = JBList(subagentModel).apply {
        cellRenderer = renderer<Subagent>("") { "${it.title} · ${it.status}${if (it.activity.isEmpty()) "" else " · " + it.activity}" }
        emptyText.text = "No subagents"
    }
    private val approvals = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS) }
    private val review = JButton("Review changes").apply { isVisible = false }
    private val input = JBTextArea(4, 40).apply {
        lineWrap = true
        wrapStyleWord = true
        emptyText.text = "Ask Lunos… (Ctrl+Enter to send)"
    }
    private var loading = false

    init {
        sessions.renderer = renderer<SessionInfo>("No session") { it.title.ifBlank { it.id } }
        // Never as wide as the longest title: the buttons beside it stay visible.
        sessions.prototypeDisplayValue = SessionInfo("", "A session title of a reasonable length", null, 0)
        sessions.addActionListener {
            if (loading) return@addActionListener
            val selected = sessions.selectedItem as? SessionInfo ?: return@addActionListener
            if (selected.id == service.state?.sessionID) return@addActionListener
            LunosService.onPooled(project) { service.open(selected.id) }
        }
        auto.toolTipText = "Approval mode in this IDE: Manual asks for each request; Auto approves them once."
        auto.addActionListener { service.autoApprove = auto.isSelected; refreshIndicator() }

        // The picker takes the room the buttons leave; in a FlowLayout a wide combo pushed them out of sight.
        val picker = JPanel(BorderLayout(4, 0)).apply {
            border = JBUI.Borders.empty(2, 4)
            add(sessions, BorderLayout.CENTER)
            add(JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
                // The panel reloads and selects the new session on the SESSION change open() fires.
                add(button("New") { LunosService.onPooled(project) { service.newSession() } })
                add(button("Refresh") { reloadSessions() })
                add(button("Open in TUI") { OpenTui.open(project) })
            }, BorderLayout.EAST)
        }
        val top = JPanel(BorderLayout()).apply {
            add(picker, BorderLayout.NORTH)
            add(JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
                add(auto)
                add(indicator)
            }, BorderLayout.SOUTH)
        }

        val center = JBSplitter(true, 0.75f)
        center.firstComponent = JBScrollPane(transcript)
        center.secondComponent = JPanel(BorderLayout()).apply {
            add(JBLabel("Subagents").apply { border = JBUI.Borders.empty(2, 4) }, BorderLayout.NORTH)
            add(JBScrollPane(subagents), BorderLayout.CENTER)
        }

        review.addActionListener { ReviewChangesDialog.show(project, service.pendingReview) }
        val bottom = JPanel(BorderLayout())
        bottom.add(JPanel(BorderLayout()).apply {
            add(approvals, BorderLayout.CENTER)
            add(review, BorderLayout.SOUTH)
        }, BorderLayout.NORTH)
        bottom.add(JBScrollPane(input), BorderLayout.CENTER)
        bottom.add(JPanel(FlowLayout(FlowLayout.RIGHT)).apply {
            add(button("Stop") { LunosService.onPooled(project) { service.abort() } })
            add(button("Send") { send() })
        }, BorderLayout.SOUTH)
        input.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ENTER && (e.isControlDown || e.isMetaDown)) {
                    e.consume()
                    send()
                }
            }
        })

        add(top, BorderLayout.NORTH)
        add(center, BorderLayout.CENTER)
        add(bottom, BorderLayout.SOUTH)

        service.onChange({ refresh(it) }, this)
        refreshIndicator()
        reloadSessions()
    }

    private fun send() {
        val text = input.text.trim()
        if (text.isEmpty()) return
        input.text = ""
        LunosService.onPooled(project) { service.send(text, null, null) }
    }

    private fun reloadSessions() {
        LunosService.onPooled(project) {
            val list = service.sessions()
            ApplicationManager.getApplication().invokeLater {
                loading = true
                val model = sessions.model as DefaultComboBoxModel<SessionInfo>
                model.removeAllElements()
                // The open session, even when the list doesn't have it yet (just created, not yet saved).
                val current = service.state?.sessionID
                val shown = if (current == null || list.any { it.id == current }) list
                else listOf(SessionInfo(current, "New session", null, Long.MAX_VALUE)) + list
                shown.forEach(model::addElement)
                model.selectedItem = shown.firstOrNull { it.id == current }
                loading = false
            }
        }
    }

    private fun refresh(change: Change) {
        val state = service.state
        when (change) {
            Change.SESSION -> reloadSessions()
            Change.TRANSCRIPT -> transcript.text = state?.entries?.values?.joinToString("\n\n") {
                when (it.role) {
                    "user" -> "You: ${it.text}"
                    "tool" -> "  [${it.text}]"
                    "error" -> "Error: ${it.text}"
                    else -> "Lunos: ${it.text}"
                }
            } ?: ""
            Change.SUBAGENTS -> {
                subagentModel.clear()
                state?.subagents?.values?.forEach(subagentModel::addElement)
            }
            Change.PERMISSIONS -> {
                approvals.removeAll()
                state?.permissions?.values?.forEach { approvals.add(approvalRow(it)) }
                approvals.revalidate()
                approvals.repaint()
            }
            else -> {}
        }
        review.isVisible = service.pendingReview.isNotEmpty()
        review.text = "Review changes (${service.pendingReview.size} file(s))"
        refreshIndicator()
    }

    private fun refreshIndicator() {
        val state = service.state
        val mode = if (auto.isSelected) "Auto" else "Manual"
        val busy = if (state?.busy == true) " · working…" else ""
        indicator.text = "${state?.model ?: "default model"} · Approval: $mode$busy"
    }

    private fun approvalRow(request: PermissionRequest): JPanel {
        val from = if (request.sessionID == service.state?.sessionID) "" else " (subagent)"
        return JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
            add(JBLabel("Lunos asks: ${request.permission} ${request.patterns.joinToString(", ")}$from"))
            add(button("Allow once") { LunosService.onPooled(project) { service.reply(request.id, "once") } })
            add(button("Always") { LunosService.onPooled(project) { service.reply(request.id, "always") } })
            add(button("Reject") { LunosService.onPooled(project) { service.reply(request.id, "reject") } })
        }
    }

    private fun button(text: String, action: () -> Unit) = JButton(text).apply { addActionListener { action() } }

    override fun dispose() {}
}
