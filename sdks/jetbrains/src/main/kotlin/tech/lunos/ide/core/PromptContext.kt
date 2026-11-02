package tech.lunos.ide.core

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import java.io.File

// What the IDE sends with a prompt (XCOD-333, PROTOCOL.md "Context"): the open file, the selected
// lines as a `file` part with ?start=&end= (the server reads those lines into the prompt, as the TUI's
// @file#L4-8 does), and problems (inspections, Error List entries) as text.

data class Selection(val startLine: Int, val endLine: Int)

data class Problem(val file: String, val line: Int, val severity: String, val message: String)

object PromptContext {
    fun parts(text: String, file: File?, root: File, selection: Selection?, problems: List<Problem>): JsonArray {
        val parts = JsonArray()
        parts.add(textPart(text))
        if (file != null) parts.add(filePart(file, root, selection))
        if (problems.isNotEmpty()) parts.add(textPart(describe(problems)))
        return parts
    }

    fun filePart(file: File, root: File, selection: Selection?): JsonObject {
        val part = JsonObject()
        part.addProperty("type", "file")
        part.addProperty("mime", "text/plain")
        part.addProperty("filename", relative(file, root))
        val url = file.toPath().toUri().toString()
        part.addProperty("url", if (selection == null) url else "$url?start=${selection.startLine}&end=${selection.endLine}")
        return part
    }

    fun describe(problems: List<Problem>) =
        "Problems reported by the IDE:\n" + problems.joinToString("\n") { "- ${it.file}:${it.line} [${it.severity}] ${it.message}" }

    /** The TUI's reference syntax for a file and selection, e.g. `@src/Calc.cs#L4-8`. */
    fun reference(file: File, root: File, selection: Selection?): String {
        val base = "@" + relative(file, root)
        if (selection == null) return base
        if (selection.startLine == selection.endLine) return "$base#L${selection.startLine}"
        return "$base#L${selection.startLine}-${selection.endLine}"
    }

    fun relative(file: File, root: File): String =
        runCatching { file.canonicalFile.relativeTo(root.canonicalFile).path }.getOrDefault(file.path).replace(File.separatorChar, '/')

    private fun textPart(text: String): JsonObject {
        val part = JsonObject()
        part.addProperty("type", "text")
        part.addProperty("text", text)
        return part
    }
}
