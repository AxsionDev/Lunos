using System;
using System.Collections.Generic;
using System.ComponentModel.Design;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using EnvDTE;
using EnvDTE80;
using Lunos.Core;
using Lunos.VisualStudio.Review;
using Lunos.VisualStudio.ToolWindow;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Shell.TableControl;
using Microsoft.VisualStudio.Shell.TableManager;

namespace Lunos.VisualStudio.Commands
{
    /// <summary>The commands in LunosPackage.vsct (XCOD-333).</summary>
    public static class LunosCommands
    {
        public const int OpenToolWindow = 0x0100;
        public const int AskAboutSelection = 0x0101;
        public const int SendErrors = 0x0102;
        public const int ReviewChanges = 0x0103;
        public const int OpenTui = 0x0104;

        public static void Register(LunosPackage package, OleMenuCommandService commands)
        {
            Add(commands, OpenToolWindow, () => Run(package, () => ShowToolWindowAsync(package)));
            Add(commands, AskAboutSelection, () => Run(package, () => AskAboutSelectionAsync(package)));
            Add(commands, SendErrors, () => Run(package, () => SendErrorsAsync(package)));
            Add(commands, ReviewChanges, () => Run(package, () => ReviewWindow.ShowAsync(package, package.Lunos.PendingReview)));
            Add(commands, OpenTui, () => Run(package, () => OpenTuiAsync(package)));
        }

        /// <summary>Runs async work from a UI event; errors are shown, not lost.</summary>
        public static void Run(LunosPackage package, Func<Task> work)
        {
            package.JoinableTaskFactory.RunAsync(async () =>
            {
                try
                {
                    await work();
                }
                catch (Exception e)
                {
                    await package.JoinableTaskFactory.SwitchToMainThreadAsync();
                    VsShellUtilities.ShowMessageBox(package, e.Message, "Lunos", OLEMSGICON.OLEMSGICON_CRITICAL, OLEMSGBUTTON.OLEMSGBUTTON_OK, OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
                }
            }).FileAndForget("lunos/command");
        }

        private static async Task ShowToolWindowAsync(LunosPackage package)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            await package.ShowToolWindowAsync(typeof(LunosToolWindow), 0, true, package.DisposalToken);
        }

        /// <summary>Right-click "Ask Lunos about Selection": the open file and the selected lines go with the prompt.</summary>
        private static async Task AskAboutSelectionAsync(LunosPackage package)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var dte = (DTE2?)await package.GetServiceAsync(typeof(DTE));
            var document = dte?.ActiveDocument;
            if (document == null) return;
            var file = document.FullName;
            var selection = SelectedLines(document);
            await package.Lunos.ConnectAsync();
            var question = Prompt.Ask($"Ask Lunos about {PromptContext.Reference(file, package.Lunos.Root, selection)}", "");
            if (string.IsNullOrWhiteSpace(question)) return;
            await ShowToolWindowAsync(package);
            await package.Lunos.SendAsync(question!, file, selection);
        }

        /// <summary>Error List → "Send to Lunos": the selected entries (or all shown) as context.</summary>
        private static async Task SendErrorsAsync(LunosPackage package)
        {
            await package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var errorList = (IErrorList?)await package.GetServiceAsync(typeof(SVsErrorList));
            if (errorList == null) return;
            await package.Lunos.ConnectAsync();
            var root = package.Lunos.Root;
            var selected = errorList.TableControl.SelectedEntries.ToList();
            var entries = selected.Count > 0 ? selected : errorList.TableControl.Entries.ToList();
            var problems = entries.Select(entry =>
            {
                entry.TryGetValue(StandardTableKeyNames.DocumentName, out string? path);
                entry.TryGetValue(StandardTableKeyNames.Line, out int line);
                entry.TryGetValue(StandardTableKeyNames.ErrorSeverity, out __VSERRORCATEGORY severity);
                entry.TryGetValue(StandardTableKeyNames.ErrorCode, out string? code);
                entry.TryGetValue(StandardTableKeyNames.Text, out string? text);
                var level = severity == __VSERRORCATEGORY.EC_ERROR ? "Error" : severity == __VSERRORCATEGORY.EC_WARNING ? "Warning" : "Message";
                return new Problem(PromptContext.Relative(path ?? "", root), line + 1, level, string.IsNullOrEmpty(code) ? text ?? "" : $"{code}: {text}");
            }).Where(p => p.Message.Length > 0).Distinct().ToList();
            if (problems.Count == 0) return;
            var question = Prompt.Ask($"Send {problems.Count} Error List entr{(problems.Count == 1 ? "y" : "ies")} to Lunos", "Fix these problems.");
            if (string.IsNullOrWhiteSpace(question)) return;
            await ShowToolWindowAsync(package);
            await package.Lunos.SendAsync(question!, null, null, problems);
        }

        /// <summary>
        /// The TUI attached to the extension's server, on the open session, so approvals can be answered in
        /// either. Visual Studio has no public API to start a command in its integrated Terminal, so this opens
        /// a console window. The password is passed in its environment, never on the command line.
        /// </summary>
        public static async Task OpenTuiAsync(LunosPackage package)
        {
            var client = await package.Lunos.ConnectAsync();
            var binary = package.Lunos.Binary() ?? "lunos";
            var command = LunosServer.AttachCommand(binary, client.Url, package.Lunos.Root, package.Lunos.State?.SessionId);
            var info = new ProcessStartInfo("cmd.exe", "/k " + string.Join(" ", command.Select(LunosServer.Quote)))
            {
                UseShellExecute = false,
                WorkingDirectory = package.Lunos.Root,
            };
            if (package.Lunos.Server != null) info.EnvironmentVariables["OPENCODE_SERVER_PASSWORD"] = package.Lunos.Server.Password;
            System.Diagnostics.Process.Start(info);
        }

        /// <summary>1-based, inclusive lines of the selection; null without one.</summary>
        private static Selection? SelectedLines(Document document)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            if (!(document.Selection is TextSelection selection) || selection.IsEmpty) return null;
            var start = selection.TopPoint.Line;
            // A selection ending at the start of a line doesn't include that line.
            var end = selection.BottomPoint.LineCharOffset == 1 && selection.BottomPoint.Line > start ? selection.BottomPoint.Line - 1 : selection.BottomPoint.Line;
            return new Selection(start, end);
        }

        private static void Add(OleMenuCommandService commands, int id, Action run) =>
            commands.AddCommand(new MenuCommand((_, __) => run(), new CommandID(LunosPackage.CommandSet, id)));
    }

    /// <summary>A small multi-line prompt dialog in the VS theme.</summary>
    internal static class Prompt
    {
        public static string? Ask(string title, string initial)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var input = new System.Windows.Controls.TextBox { Text = initial, AcceptsReturn = true, TextWrapping = System.Windows.TextWrapping.Wrap, MinHeight = 100, Margin = new System.Windows.Thickness(8) };
            var ok = new System.Windows.Controls.Button { Content = "Ask", IsDefault = false, Margin = new System.Windows.Thickness(8), Padding = new System.Windows.Thickness(12, 2, 12, 2), HorizontalAlignment = System.Windows.HorizontalAlignment.Right };
            var panel = new System.Windows.Controls.DockPanel();
            System.Windows.Controls.DockPanel.SetDock(ok, System.Windows.Controls.Dock.Bottom);
            panel.Children.Add(ok);
            panel.Children.Add(input);
            var window = new DialogWindow { Title = title, Width = 520, Height = 240, Content = panel, HasMinimizeButton = false };
            string? result = null;
            ok.Click += (_, __) => { result = input.Text; window.Close(); };
            input.Loaded += (_, __) => input.Focus();
            window.ShowModal();
            return result;
        }
    }
}
