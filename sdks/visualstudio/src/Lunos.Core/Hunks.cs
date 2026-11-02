using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Lunos.Core
{
    // Per-hunk accept/reject of a Lunos edit (XCOD-333, sdks/ide/PROTOCOL.md "Hunks"). The same
    // algorithm as the JetBrains plugin (sdks/jetbrains/.../core/Hunks.kt), tested against the same
    // fixtures (sdks/ide/fixtures/hunks).
    //
    // The server returns each changed file as a unified patch with full-file context. A hunk is a run
    // of consecutive removed/added lines. The edit is already on disk: accepting a hunk keeps it,
    // rejecting it puts the old lines back. Context and added lines are checked against the current
    // file first; if it changed since the edit, nothing is applied (StalePatchException).

    public sealed class StalePatchException : Exception
    {
        public StalePatchException(string message) : base(message) { }
    }

    public sealed class Hunk
    {
        public Hunk(int line, IReadOnlyList<string> removed, IReadOnlyList<string> added)
        {
            Line = line;
            Removed = removed;
            Added = added;
        }

        /// <summary>1-based line of the first added line in the edited file (or where the removal was).</summary>
        public int Line { get; }
        public IReadOnlyList<string> Removed { get; }
        public IReadOnlyList<string> Added { get; }
    }

    public sealed class FilePatch
    {
        private static readonly Regex Header = new Regex(@"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@");
        private readonly List<Section> _sections;

        private FilePatch(List<Section> sections)
        {
            _sections = sections;
            Hunks = BuildHunks();
        }

        public IReadOnlyList<Hunk> Hunks { get; }

        /// <summary>Parses the first file of a unified patch as jsdiff's formatPatch writes it.</summary>
        public static FilePatch Parse(string patch)
        {
            var sections = new List<Section>();
            Section? current = null;
            var started = false;
            foreach (var raw in patch.Split('\n'))
            {
                var match = Header.Match(raw);
                if (match.Success)
                {
                    current = new Section(
                        int.Parse(match.Groups[3].Value),
                        match.Groups[4].Success ? int.Parse(match.Groups[4].Value) : 1);
                    sections.Add(current);
                    started = true;
                    continue;
                }
                if (current == null) continue;
                if (raw.StartsWith("\\", StringComparison.Ordinal))
                {
                    // "\ No newline at end of file": the line before has no line ending.
                    if (current.Lines.Count == 0) continue;
                    var last = current.Lines[current.Lines.Count - 1];
                    current.Lines[current.Lines.Count - 1] = new PatchLine(last.Kind, last.Text.EndsWith("\n", StringComparison.Ordinal) ? last.Text.Substring(0, last.Text.Length - 1) : last.Text);
                    continue;
                }
                var kind = raw.Length > 0 ? raw[0] : '\0';
                if (kind != ' ' && kind != '-' && kind != '+')
                {
                    // A second file's header ends this file's patch.
                    if (started && raw.StartsWith("Index: ", StringComparison.Ordinal)) break;
                    continue;
                }
                current.Lines.Add(new PatchLine(kind, raw.Substring(1) + "\n"));
            }
            return new FilePatch(sections);
        }

        /// <summary>The file with the accepted hunks kept and the others reverted. One decision per hunk.</summary>
        public string Apply(string current, IReadOnlyList<bool> accept)
        {
            if (accept.Count != Hunks.Count) throw new ArgumentException($"expected {Hunks.Count} decisions, got {accept.Count}");
            var tokens = SplitLines(current);
            var output = new StringBuilder();
            var pos = 0;
            var hunk = -1;
            foreach (var section in _sections)
            {
                var start = section.NewLines == 0 ? section.NewStart : section.NewStart - 1;
                if (start < pos || start > tokens.Count) throw new StalePatchException("the patch doesn't fit the file");
                for (; pos < start; pos++) output.Append(tokens[pos]);
                var inChange = false;
                foreach (var line in section.Lines)
                {
                    if (line.Kind == ' ')
                    {
                        inChange = false;
                        Expect(tokens, pos, line.Text);
                        output.Append(line.Text);
                        pos++;
                        continue;
                    }
                    if (!inChange)
                    {
                        inChange = true;
                        hunk++;
                    }
                    if (line.Kind == '+')
                    {
                        Expect(tokens, pos, line.Text);
                        pos++;
                        if (accept[hunk]) output.Append(line.Text);
                        continue;
                    }
                    if (!accept[hunk]) output.Append(line.Text);
                }
            }
            for (; pos < tokens.Count; pos++) output.Append(tokens[pos]);
            return output.ToString();
        }

        /// <summary>The file as it was before the edit.</summary>
        public string Before(string current) => Apply(current, Enumerable.Repeat(false, Hunks.Count).ToList());

        /// <summary>
        /// The file's text as the server's patch sees it: a UTF-8 BOM (Visual Studio's default for .cs)
        /// stays in the file but isn't in the patch. File.ReadAllText already drops it; text from elsewhere may not.
        /// </summary>
        public static string WithoutBom(string text) => text.Length > 0 && text[0] == '\uFEFF' ? text.Substring(1) : text;

        /// <summary>Lines with their line endings kept, so CRLF and a missing final newline survive.</summary>
        public static List<string> SplitLines(string text)
        {
            var result = new List<string>();
            var start = 0;
            while (start < text.Length)
            {
                var end = text.IndexOf('\n', start);
                if (end < 0)
                {
                    result.Add(text.Substring(start));
                    break;
                }
                result.Add(text.Substring(start, end - start + 1));
                start = end + 1;
            }
            return result;
        }

        private static void Expect(List<string> tokens, int pos, string text)
        {
            if (pos >= tokens.Count || tokens[pos] != text)
                throw new StalePatchException($"the file changed since Lunos edited it (line {pos + 1})");
        }

        private List<Hunk> BuildHunks()
        {
            var result = new List<Hunk>();
            foreach (var section in _sections)
            {
                var line = section.NewLines == 0 ? section.NewStart + 1 : section.NewStart;
                var at = line;
                var removed = new List<string>();
                var added = new List<string>();
                void Flush()
                {
                    if (removed.Count == 0 && added.Count == 0) return;
                    result.Add(new Hunk(at, removed, added));
                    removed = new List<string>();
                    added = new List<string>();
                }
                foreach (var item in section.Lines)
                {
                    if (item.Kind == ' ')
                    {
                        Flush();
                        line++;
                        continue;
                    }
                    if (removed.Count == 0 && added.Count == 0) at = line;
                    if (item.Kind == '+')
                    {
                        added.Add(item.Text);
                        line++;
                        continue;
                    }
                    removed.Add(item.Text);
                }
                Flush();
            }
            return result;
        }

        private readonly struct PatchLine
        {
            public PatchLine(char kind, string text)
            {
                Kind = kind;
                Text = text;
            }

            public char Kind { get; }
            public string Text { get; }
        }

        private sealed class Section
        {
            public Section(int newStart, int newLines)
            {
                NewStart = newStart;
                NewLines = newLines;
            }

            public int NewStart { get; }
            public int NewLines { get; }
            public List<PatchLine> Lines { get; } = new List<PatchLine>();
        }
    }
}
