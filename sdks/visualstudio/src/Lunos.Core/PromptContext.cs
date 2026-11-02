using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;

namespace Lunos.Core
{
    // What the IDE sends with a prompt (XCOD-333, PROTOCOL.md "Context"): the open file, the selected
    // lines as a `file` part with ?start=&end= (the server reads those lines into the prompt), and
    // problems (Error List entries) as text. Same as the JetBrains plugin's PromptContext.kt.

    public sealed class Selection
    {
        public Selection(int startLine, int endLine)
        {
            StartLine = startLine;
            EndLine = endLine;
        }

        /// <summary>1-based, inclusive.</summary>
        public int StartLine { get; }
        public int EndLine { get; }
    }

    public sealed class Problem
    {
        public Problem(string file, int line, string severity, string message)
        {
            File = file;
            Line = line;
            Severity = severity;
            Message = message;
        }

        public string File { get; }
        public int Line { get; }
        public string Severity { get; }
        public string Message { get; }
    }

    public static class PromptContext
    {
        public static JsonArray Parts(string text, string? file, string root, Selection? selection, IReadOnlyList<Problem> problems)
        {
            var parts = new JsonArray { TextPart(text) };
            if (file != null) parts.Add(FilePart(file, root, selection));
            if (problems.Count > 0) parts.Add(TextPart(Describe(problems)));
            return parts;
        }

        public static JsonObject FilePart(string file, string root, Selection? selection)
        {
            var url = FileUrl(file);
            return new JsonObject
            {
                ["type"] = "file",
                ["mime"] = "text/plain",
                ["filename"] = Relative(file, root),
                ["url"] = selection == null ? url : $"{url}?start={selection.StartLine}&end={selection.EndLine}",
            };
        }

        /// <summary>file:///C:/work/app/Calc.cs or file:///work/app/Calc.cs, with spaces and the like escaped.</summary>
        public static string FileUrl(string file)
        {
            var path = file.Replace('\\', '/');
            if (!path.StartsWith("/", StringComparison.Ordinal)) path = "/" + path;
            return "file://" + string.Join("/", path.Split('/').Select(segment => segment.EndsWith(":", StringComparison.Ordinal) ? segment : Uri.EscapeDataString(segment)));
        }

        public static string Describe(IReadOnlyList<Problem> problems) =>
            "Problems reported by the IDE:\n" + string.Join("\n", problems.Select(p => $"- {p.File}:{p.Line} [{p.Severity}] {p.Message}"));

        /// <summary>The TUI's reference syntax, e.g. <c>@src/Calc.cs#L4-8</c>.</summary>
        public static string Reference(string file, string root, Selection? selection)
        {
            var reference = "@" + Relative(file, root);
            if (selection == null) return reference;
            if (selection.StartLine == selection.EndLine) return $"{reference}#L{selection.StartLine}";
            return $"{reference}#L{selection.StartLine}-{selection.EndLine}";
        }

        public static string Relative(string file, string root)
        {
            var full = file.Replace('\\', '/');
            var prefix = root.Replace('\\', '/').TrimEnd('/') + "/";
            return full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? full.Substring(prefix.Length) : full;
        }

        private static JsonObject TextPart(string text) => new JsonObject { ["type"] = "text", ["text"] = text };
    }
}
