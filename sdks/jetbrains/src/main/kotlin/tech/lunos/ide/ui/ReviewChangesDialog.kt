package tech.lunos.ide.ui

import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.DiffRequestPanel
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.ui.CheckboxTree
import com.intellij.ui.CheckedTreeNode
import com.intellij.ui.JBSplitter
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import tech.lunos.ide.core.FileDiff
import tech.lunos.ide.core.FilePatch
import tech.lunos.ide.core.Hunk
import tech.lunos.ide.core.StalePatchException
import java.io.File
import javax.swing.JComponent
import javax.swing.JTree
import javax.swing.tree.DefaultTreeModel

/**
 * Lunos's edits, file by file and hunk by hunk (XCOD-333). Lunos has already written the files; each
 * hunk is checked (accepted) by default and unchecking one reverts it. The right side is the IDE's diff
 * viewer: the file before Lunos against the result of the current choices, updated as boxes change.
 */
class ReviewChangesDialog private constructor(private val project: Project, diffs: List<FileDiff>) : DialogWrapper(project, true) {
    private class FileItem(val diff: FileDiff, val file: File, val patch: FilePatch, val current: String)
    private class HunkItem(val file: FileItem, val index: Int, val hunk: Hunk)

    private val service = LunosService.get(project)
    private val items = diffs.mapNotNull { load(it) }
    private val rootNode = CheckedTreeNode("Changes")
    private val tree: CheckboxTree
    private val diffPanel: DiffRequestPanel = DiffManager.getInstance().createRequestPanel(project, disposable, null)

    init {
        title = "Review Lunos Changes"
        items.forEach { item ->
            val fileNode = CheckedTreeNode(item)
            item.patch.hunks.forEachIndexed { i, hunk -> fileNode.add(CheckedTreeNode(HunkItem(item, i, hunk))) }
            rootNode.add(fileNode)
        }
        tree = CheckboxTree(object : CheckboxTree.CheckboxTreeCellRenderer() {
            override fun customizeRenderer(tree: JTree?, value: Any?, selected: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean) {
                when (val obj = (value as? CheckedTreeNode)?.userObject) {
                    is FileItem -> textRenderer.append(obj.diff.file, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    is HunkItem -> {
                        textRenderer.append("Line ${obj.hunk.line}: ")
                        textRenderer.append("-${obj.hunk.removed.size} +${obj.hunk.added.size}  ", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                        textRenderer.append((obj.hunk.added.firstOrNull() ?: obj.hunk.removed.firstOrNull() ?: "").trim().take(60))
                    }
                    else -> textRenderer.append(obj?.toString() ?: "")
                }
            }
        }, rootNode)
        (tree.model as DefaultTreeModel).reload()
        for (row in 0 until tree.rowCount) tree.expandRow(row)
        tree.addTreeSelectionListener { showSelected() }
        tree.addCheckboxTreeListener(object : com.intellij.ui.CheckboxTreeListener {
            override fun nodeStateChanged(node: CheckedTreeNode) = showSelected()
        })
        setOKButtonText("Apply Choices")
        init()
        if (items.isNotEmpty()) tree.setSelectionRow(1)
    }

    override fun createCenterPanel(): JComponent {
        val splitter = JBSplitter(false, 0.3f)
        splitter.firstComponent = JBScrollPane(tree)
        splitter.secondComponent = diffPanel.component
        splitter.preferredSize = java.awt.Dimension(1100, 650)
        return splitter
    }

    override fun doOKAction() {
        // Unchanged files (every hunk accepted) are left alone: that also keeps an accepted deletion deleted.
        val results = items.map { it to it.patch.apply(it.current, decisions(it)) }.filter { (item, content) -> content != item.current }
        WriteCommandAction.runWriteCommandAction(project, "Apply Lunos Changes", null, {
            results.forEach { (item, content) -> write(item, content) }
        })
        service.clearReview()
        super.doOKAction()
    }

    private fun decisions(item: FileItem): List<Boolean> {
        val fileNode = rootNode.children().toList().map { it as CheckedTreeNode }.first { it.userObject === item }
        return fileNode.children().toList().map { (it as CheckedTreeNode).isChecked }
    }

    private fun showSelected() {
        val node = tree.selectionPath?.lastPathComponent as? CheckedTreeNode ?: return
        val item = when (val obj = node.userObject) {
            is FileItem -> obj
            is HunkItem -> obj.file
            else -> return
        }
        val type = FileTypeManager.getInstance().getFileTypeByFileName(item.file.name)
        val factory = DiffContentFactory.getInstance()
        val before = StringUtil.convertLineSeparators(item.patch.before(item.current))
        val result = StringUtil.convertLineSeparators(item.patch.apply(item.current, decisions(item)))
        diffPanel.setRequest(
            SimpleDiffRequest(item.diff.file, factory.create(project, before, type), factory.create(project, result, type), "Before Lunos", "With your choices"),
        )
    }

    private fun write(item: FileItem, content: String) {
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(item.file)
        // A new file with every hunk rejected: remove it. A deleted file with a hunk rejected: recreate it.
        if (content.isEmpty() && item.diff.status == "added") {
            vf?.delete(this)
            return
        }
        if (vf == null) {
            val parent = VfsUtil.createDirectories(item.file.parentFile.path)
            VfsUtil.saveText(parent.createChildData(this, item.file.name), content)
            return
        }
        val document = FileDocumentManager.getInstance().getDocument(vf)
        if (document == null) {
            VfsUtil.saveText(vf, content)
            return
        }
        // Documents use \n; saving writes the file's own line separator back.
        document.setText(StringUtil.convertLineSeparators(content))
        FileDocumentManager.getInstance().saveDocument(document)
    }

    private fun load(diff: FileDiff): FileItem? {
        val patch = FilePatch.parse(diff.patch ?: return null)
        if (patch.hunks.isEmpty()) return null
        val file = File(service.root, diff.file).takeIf { !File(diff.file).isAbsolute } ?: File(diff.file)
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file)
        vf?.let { v -> FileDocumentManager.getInstance().getDocument(v)?.let { FileDocumentManager.getInstance().saveDocument(it) } }
        val current = if (file.isFile) FilePatch.withoutBom(file.readText()) else ""
        return runCatching { patch.before(current); FileItem(diff, file, patch, current) }
            .getOrElse { error ->
                if (error !is StalePatchException) throw error
                Messages.showWarningDialog(project, "${diff.file}: ${error.message}. It's left as it is.", "Lunos")
                null
            }
    }

    companion object {
        fun show(project: Project, diffs: List<FileDiff>) {
            val dialog = ReviewChangesDialog(project, diffs)
            if (dialog.items.isEmpty()) {
                Disposer.dispose(dialog.disposable)
                Messages.showInfoMessage(project, "There are no Lunos changes to review.", "Lunos")
                return
            }
            dialog.show()
        }
    }
}
