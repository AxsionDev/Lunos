using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using EnvDTE;
using EnvDTE80;
using Lunos.Core;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace Lunos.VisualStudio.Review
{
    /// <summary>
    /// Lunos's edits, file by file and hunk by hunk (XCOD-333). Lunos has already written the files; each
    /// hunk is checked (accepted) by default and unchecking one reverts it. "Show diff" opens the VS diff
    /// viewer (IVsDifferenceService): the file before Lunos against the result of the current choices.
    /// "Apply" writes the result through the open editor buffer when the file is open.
    /// </summary>
    public sealed class ReviewWindow : DialogWindow
    {
        private sealed class FileItem
        {
            public FileItem(FileDiff diff, string path, FilePatch patch, string current)
            {
                Diff = diff;
                Path = path;
                Patch = patch;
                Current = current;
                Accept = patch.Hunks.Select(_ => true).ToList();
            }

            public FileDiff Diff { get; }
            public string Path { get; }
            public FilePatch Patch { get; }
            public string Current { get; }
            public List<bool> Accept { get; }
        }

        private readonly LunosPackage _package;
        private readonly List<FileItem> _items;
        private FileItem? _selected;

        private ReviewWindow(LunosPackage package, List<FileItem> items)
        {
            _package = package;
            _items = items;
            Title = "Review Lunos Changes";
            Width = 720;
            Height = 520;
            HasMinimizeButton = false;
            WindowStartupLocation = WindowStartupLocation.CenterOwner;
            SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);

            var tree = new TreeView();
            foreach (var item in items)
            {
                var fileNode = new TreeViewItem { Header = item.Diff.File, IsExpanded = true, Tag = item, FontWeight = FontWeights.Bold };
                for (var i = 0; i < item.Patch.Hunks.Count; i++)
                {
                    var index = i;
                    var hunk = item.Patch.Hunks[i];
                    var preview = (hunk.Added.FirstOrDefault() ?? hunk.Removed.FirstOrDefault() ?? "").Trim();
                    var box = new CheckBox
                    {
                        IsChecked = true,
                        Content = $"Line {hunk.Line}: -{hunk.Removed.Count} +{hunk.Added.Count}  {(preview.Length > 60 ? preview.Substring(0, 60) : preview)}",
                        FontWeight = FontWeights.Normal,
                    };
                    box.Click += (_, __) => item.Accept[index] = box.IsChecked == true;
                    fileNode.Items.Add(new TreeViewItem { Header = box, Tag = item });
                }
                tree.Items.Add(fileNode);
            }
            tree.SelectedItemChanged += (_, e) => _selected = (e.NewValue as TreeViewItem)?.Tag as FileItem;

            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(4) };
            buttons.Children.Add(MakeButton("Show diff", () => { ThreadHelper.ThrowIfNotOnUIThread(); ShowDiff(_selected ?? _items[0]); }));
            buttons.Children.Add(MakeButton("Apply choices", Apply));
            buttons.Children.Add(MakeButton("Cancel", Close));
            var root = new DockPanel();
            DockPanel.SetDock(buttons, Dock.Bottom);
            root.Children.Add(buttons);
            root.Children.Add(tree);
            Content = root;
        }

        public static async Task ShowAsync(LunosPackage package, IReadOnlyList<FileDiff> diffs)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var dte = (DTE2?)await package.GetServiceAsync(typeof(DTE));
            // Unsaved edits in the files would make the patch not fit: save them first.
            var items = new List<FileItem>();
            foreach (var diff in diffs)
            {
                if (string.IsNullOrEmpty(diff.Patch)) continue;
                var path = Path.IsPathRooted(diff.File) ? diff.File : Path.Combine(package.Lunos.Root, diff.File.Replace('/', '\\'));
                OpenDocument(dte, path)?.Save();
                var patch = FilePatch.Parse(diff.Patch!);
                if (patch.Hunks.Count == 0) continue;
                var current = File.Exists(path) ? FilePatch.WithoutBom(File.ReadAllText(path)) : "";
                try
                {
                    patch.Before(current);
                    items.Add(new FileItem(diff, path, patch, current));
                }
                catch (StalePatchException e)
                {
                    VsShellUtilities.ShowMessageBox(package, $"{diff.File}: {e.Message}. It's left as it is.", "Lunos",
                        OLEMSGICON.OLEMSGICON_WARNING, OLEMSGBUTTON.OLEMSGBUTTON_OK, OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
                }
            }
            if (items.Count == 0)
            {
                VsShellUtilities.ShowMessageBox(package, "There are no Lunos changes to review.", "Lunos",
                    OLEMSGICON.OLEMSGICON_INFO, OLEMSGBUTTON.OLEMSGBUTTON_OK, OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
                return;
            }
            new ReviewWindow(package, items).ShowModal();
        }

        private void ShowDiff(FileItem item)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var name = Path.GetFileName(item.Path);
            var dir = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "lunos-review", Guid.NewGuid().ToString("N"))).FullName;
            var left = Path.Combine(dir, "before." + name);
            var right = Path.Combine(dir, "result." + name);
            File.WriteAllText(left, item.Patch.Before(item.Current), new UTF8Encoding(false));
            File.WriteAllText(right, item.Patch.Apply(item.Current, item.Accept), new UTF8Encoding(false));
            var service = (IVsDifferenceService)Package.GetGlobalService(typeof(SVsDifferenceService));
            service.OpenComparisonWindow2(left, right, $"{item.Diff.File}: Lunos", item.Path, "Before Lunos", "With your choices", null, null,
                (uint)(__VSDIFFSERVICEOPTIONS.VSDIFFOPT_LeftFileIsTemporary | __VSDIFFSERVICEOPTIONS.VSDIFFOPT_RightFileIsTemporary));
        }

        private void Apply()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var dte = (DTE2)Package.GetGlobalService(typeof(DTE));
            foreach (var item in _items)
            {
                var content = item.Patch.Apply(item.Current, item.Accept);
                // Unchanged files (every hunk accepted) are left alone: that also keeps an accepted deletion deleted.
                if (content != item.Current) Write(dte, item, content);
            }
            _package.JoinableTaskFactory.RunAsync(() => _package.Lunos.ClearReviewAsync()).FileAndForget("lunos/review");
            Close();
        }

        private static void Write(DTE2 dte, FileItem item, string content)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            // A new file with every hunk rejected: remove it.
            if (content.Length == 0 && item.Diff.Status == "added")
            {
                OpenDocument(dte, item.Path)?.Close(vsSaveChanges.vsSaveChangesNo);
                if (File.Exists(item.Path)) File.Delete(item.Path);
                return;
            }
            var document = OpenDocument(dte, item.Path);
            if (document?.Object("TextDocument") is TextDocument text)
            {
                // Through the editor buffer, so undo works and VS doesn't ask to reload.
                text.StartPoint.CreateEditPoint().ReplaceText(text.EndPoint, content, (int)vsEPReplaceTextOptions.vsEPReplaceTextKeepMarkers);
                document.Save();
                return;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(item.Path)!);
            File.WriteAllText(item.Path, content, Encoding(item.Path));
        }

        private static Document? OpenDocument(DTE2? dte, string path)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (dte == null) return null;
            foreach (Document document in dte.Documents)
                if (string.Equals(document.FullName, path, StringComparison.OrdinalIgnoreCase)) return document;
            return null;
        }

        /// <summary>Keeps a UTF-8 BOM if the file had one.</summary>
        private static Encoding Encoding(string path)
        {
            if (!File.Exists(path)) return new UTF8Encoding(false);
            var head = new byte[3];
            using (var stream = File.OpenRead(path)) stream.Read(head, 0, 3);
            return new UTF8Encoding(head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF);
        }

        private static Button MakeButton(string text, Action action)
        {
            var button = new Button { Content = text, Margin = new Thickness(4, 0, 0, 0), Padding = new Thickness(10, 2, 10, 2) };
            button.Click += (_, __) => action();
            return button;
        }
    }
}
