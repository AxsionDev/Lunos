package tech.lunos.ide.core

// Per-hunk accept/reject of a Lunos edit (XCOD-333, sdks/ide/PROTOCOL.md "Hunks").
//
// The server returns each changed file as a unified patch (`GET /session/:id/diff`), with full-file
// context, so one `@@` section holds the whole file. A hunk is a run of consecutive removed/added
// lines. The edit is already on disk, so accepting a hunk keeps it and rejecting one puts its old
// lines back. Every context and added line is checked against the current file first: if the file
// changed since the edit, nothing is applied (StalePatchException).
//
// No IntelliJ imports, so this is unit-tested against the shared fixtures in sdks/ide/fixtures.

class StalePatchException(message: String) : RuntimeException(message)

data class Hunk(
    /** 1-based line of the first added line in the edited file (or where the removal was). */
    val line: Int,
    val removed: List<String>,
    val added: List<String>,
)

class FilePatch internal constructor(private val sections: List<Section>) {
    val hunks: List<Hunk> = buildHunks()

    /** The file with the accepted hunks kept and the others reverted. `accept` has one entry per hunk. */
    fun apply(current: String, accept: List<Boolean>): String {
        require(accept.size == hunks.size) { "expected ${hunks.size} decisions, got ${accept.size}" }
        val tokens = splitLines(current)
        val out = StringBuilder()
        var pos = 0
        var hunk = -1
        for (section in sections) {
            val start = if (section.newLines == 0) section.newStart else section.newStart - 1
            if (start < pos || start > tokens.size) throw StalePatchException("the patch doesn't fit the file")
            tokens.subList(pos, start).forEach(out::append)
            pos = start
            var inChange = false
            for (line in section.lines) {
                if (line.kind == ' ') {
                    inChange = false
                    expect(tokens, pos, line.text)
                    out.append(line.text)
                    pos++
                    continue
                }
                if (!inChange) {
                    inChange = true
                    hunk++
                }
                if (line.kind == '+') {
                    expect(tokens, pos, line.text)
                    pos++
                    if (accept[hunk]) out.append(line.text)
                    continue
                }
                if (!accept[hunk]) out.append(line.text)
            }
        }
        tokens.subList(pos, tokens.size).forEach(out::append)
        return out.toString()
    }

    /** The file as it was before the edit. */
    fun before(current: String) = apply(current, List(hunks.size) { false })

    private fun buildHunks(): List<Hunk> {
        val result = mutableListOf<Hunk>()
        for (section in sections) {
            var line = if (section.newLines == 0) section.newStart + 1 else section.newStart
            var removed = mutableListOf<String>()
            var added = mutableListOf<String>()
            var at = line
            fun flush() {
                if (removed.isEmpty() && added.isEmpty()) return
                result += Hunk(at, removed, added)
                removed = mutableListOf()
                added = mutableListOf()
            }
            for (item in section.lines) {
                if (item.kind == ' ') {
                    flush()
                    line++
                    continue
                }
                if (removed.isEmpty() && added.isEmpty()) at = line
                if (item.kind == '+') {
                    added += item.text
                    line++
                    continue
                }
                removed += item.text
            }
            flush()
        }
        return result
    }

    private fun expect(tokens: List<String>, pos: Int, text: String) {
        if (pos >= tokens.size || tokens[pos] != text)
            throw StalePatchException("the file changed since Lunos edited it (line ${pos + 1})")
    }

    companion object {
        private val header = Regex("""^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@""")

        /** Parses the first file of a unified patch as `formatPatch` (jsdiff) writes it. */
        fun parse(patch: String): FilePatch {
            val sections = mutableListOf<Section>()
            var current: Section? = null
            var started = false
            for (raw in patch.split("\n")) {
                val match = header.find(raw)
                if (match != null) {
                    current = Section(
                        newStart = match.groupValues[3].toInt(),
                        newLines = match.groupValues[4].ifEmpty { "1" }.toInt(),
                    )
                    sections += current
                    started = true
                    continue
                }
                if (current == null) continue
                if (raw.startsWith("\\")) {
                    // "\ No newline at end of file": the line before has no line ending.
                    if (current.lines.isEmpty()) continue
                    val last = current.lines.removeAt(current.lines.lastIndex)
                    current.lines += last.copy(text = last.text.removeSuffix("\n"))
                    continue
                }
                val kind = raw.firstOrNull()
                if (kind != ' ' && kind != '-' && kind != '+') {
                    // A second file's header ends this file's patch.
                    if (started && raw.startsWith("Index: ")) break
                    continue
                }
                current.lines += PatchLine(kind, raw.substring(1) + "\n")
            }
            return FilePatch(sections)
        }

        /**
         * The file's text as the server's patch sees it: a UTF-8 BOM (Visual Studio's default for .cs)
         * stays in the file but isn't in the patch, so it's dropped before applying hunks.
         */
        fun withoutBom(text: String) = text.removePrefix("\uFEFF")

        /** Lines with their line endings kept, so CRLF and a missing final newline survive. */
        fun splitLines(text: String): List<String> {
            if (text.isEmpty()) return emptyList()
            val result = mutableListOf<String>()
            var start = 0
            while (start < text.length) {
                val end = text.indexOf('\n', start)
                if (end < 0) {
                    result += text.substring(start)
                    break
                }
                result += text.substring(start, end + 1)
                start = end + 1
            }
            return result
        }
    }
}

internal data class PatchLine(val kind: Char, val text: String)

internal class Section(val newStart: Int, val newLines: Int) {
    val lines = mutableListOf<PatchLine>()
}
