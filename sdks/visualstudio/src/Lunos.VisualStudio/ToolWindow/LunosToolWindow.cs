using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using Lunos.Core;
using Lunos.VisualStudio.Commands;
using Lunos.VisualStudio.Review;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;

namespace Lunos.VisualStudio.ToolWindow
{
    /// <summary>The Lunos tool window (XCOD-333): chat, session picker, model and approval indicator, subagents, approvals.</summary>
    [Guid("c0d1e2f3-0a1b-4c2d-8e3f-4a5b6c7d0333")]
    public sealed class LunosToolWindow : ToolWindowPane
    {
        public LunosToolWindow() : base(null)
        {
            Caption = "Lunos";
        }

        protected override void Initialize()
        {
            base.Initialize();
            Content = new LunosPanel((LunosPackage)Package);
        }
    }

    /// <summary>The panel, built in code (no XAML) and themed with the VS environment colors.</summary>
    public sealed class LunosPanel : DockPanel
    {
        private readonly LunosPackage _package;
        private LunosService Lunos => _package.Lunos;
        private readonly ComboBox _sessions = new ComboBox { MinWidth = 220, Margin = new Thickness(2) };
        private readonly TextBlock _indicator = new TextBlock { Margin = new Thickness(6, 4, 2, 2), VerticalAlignment = VerticalAlignment.Center };
        private readonly CheckBox _auto = new CheckBox { Content = "Auto-approve", Margin = new Thickness(6, 4, 2, 2), VerticalAlignment = VerticalAlignment.Center };
        private readonly TextBox _transcript = new TextBox { IsReadOnly = true, TextWrapping = TextWrapping.Wrap, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, AcceptsReturn = true };
        private readonly ListBox _subagents = new ListBox { MinHeight = 60, MaxHeight = 160 };
        private readonly StackPanel _approvals = new StackPanel();
        private readonly Button _review = new Button { Content = "Review changes", Visibility = Visibility.Collapsed, Margin = new Thickness(2) };
        private readonly TextBox _input = new TextBox { AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 70, ToolTip = "Ask Lunos… (Ctrl+Enter to send)" };
        private bool _loading;

        public LunosPanel(LunosPackage package)
        {
            _package = package;
            SetResourceReference(BackgroundProperty, EnvironmentColors.ToolWindowBackgroundBrushKey);
            TextElement.SetForeground(this, (System.Windows.Media.Brush)FindResource(EnvironmentColors.ToolWindowTextBrushKey));

            var top = new WrapPanel();
            top.Children.Add(_sessions);
            top.Children.Add(MakeButton("New", () => Run(async () => { await Lunos.NewSessionAsync(); await ReloadSessionsAsync(); })));
            top.Children.Add(MakeButton("Refresh", () => Run(ReloadSessionsAsync)));
            top.Children.Add(MakeButton("Open in TUI", () => Run(() => LunosCommands.OpenTuiAsync(_package))));
            top.Children.Add(_auto);
            top.Children.Add(_indicator);
            SetDock(top, Dock.Top);
            Children.Add(top);

            var bottom = new DockPanel();
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            buttons.Children.Add(MakeButton("Stop", () => Run(Lunos.AbortAsync)));
            buttons.Children.Add(MakeButton("Send", Send));
            SetDock(buttons, Dock.Bottom);
            bottom.Children.Add(buttons);
            var reviewAndApprovals = new StackPanel();
            reviewAndApprovals.Children.Add(_approvals);
            reviewAndApprovals.Children.Add(_review);
            SetDock(reviewAndApprovals, Dock.Top);
            bottom.Children.Add(reviewAndApprovals);
            bottom.Children.Add(_input);
            SetDock(bottom, Dock.Bottom);
            Children.Add(bottom);

            var subagents = new DockPanel();
            var label = new TextBlock { Text = "Subagents", Margin = new Thickness(4, 2, 2, 2) };
            SetDock(label, Dock.Top);
            subagents.Children.Add(label);
            subagents.Children.Add(_subagents);
            SetDock(subagents, Dock.Bottom);
            Children.Add(subagents);
            Children.Add(_transcript);

            _sessions.SelectionChanged += (_, __) =>
            {
                if (_loading || !(_sessions.SelectedItem is SessionInfo selected) || selected.Id == Lunos.State?.SessionId) return;
                Run(() => Lunos.OpenAsync(selected.Id));
            };
            _auto.ToolTip = "Approval mode in this IDE: Manual asks for each request; Auto approves them once.";
            _auto.Click += (_, __) => { Lunos.AutoApprove = _auto.IsChecked == true; RefreshIndicator(); };
            _review.Click += (_, __) => Run(() => ReviewWindow.ShowAsync(_package, Lunos.PendingReview));
            _input.PreviewKeyDown += (_, e) =>
            {
                if (e.Key != Key.Enter || (Keyboard.Modifiers & ModifierKeys.Control) == 0) return;
                e.Handled = true;
                Send();
            };

            Lunos.Changed += Refresh;
            RefreshIndicator();
            Run(ReloadSessionsAsync);
        }

        private void Send()
        {
            var text = _input.Text.Trim();
            if (text.Length == 0) return;
            _input.Text = "";
            Run(async () =>
            {
                await Lunos.SendAsync(text, null, null);
                await ReloadSessionsAsync();
            });
        }

        private async System.Threading.Tasks.Task ReloadSessionsAsync()
        {
            var list = await Lunos.SessionsAsync();
            await _package.JoinableTaskFactory.SwitchToMainThreadAsync();
            _loading = true;
            _sessions.ItemsSource = list;
            _sessions.SelectedItem = list.FirstOrDefault(s => s.Id == Lunos.State?.SessionId);
            _loading = false;
        }

        private void Refresh(Change change)
        {
            var state = Lunos.State;
            switch (change)
            {
                case Change.Transcript:
                    _transcript.Text = state == null ? "" : string.Join("\n\n", state.Entries.Select(e =>
                        e.Role == "user" ? "You: " + e.Text : e.Role == "tool" ? "  [" + e.Text + "]" : "Lunos: " + e.Text));
                    _transcript.ScrollToEnd();
                    break;
                case Change.Subagents:
                    _subagents.ItemsSource = state?.Subagents.ToList() ?? new List<Subagent>();
                    break;
                case Change.Permissions:
                    _approvals.Children.Clear();
                    foreach (var request in state?.Permissions ?? Array.Empty<PermissionRequest>()) _approvals.Children.Add(ApprovalRow(request));
                    break;
            }
            _review.Visibility = Lunos.PendingReview.Count > 0 ? Visibility.Visible : Visibility.Collapsed;
            _review.Content = $"Review changes ({Lunos.PendingReview.Count} file(s))";
            RefreshIndicator();
        }

        private void RefreshIndicator()
        {
            var state = Lunos.State;
            _indicator.Text = $"{state?.Model ?? "default model"} · Approval: {(_auto.IsChecked == true ? "Auto" : "Manual")}{(state?.Busy == true ? " · working…" : "")}";
        }

        private UIElement ApprovalRow(PermissionRequest request)
        {
            var row = new WrapPanel();
            var from = request.SessionId == Lunos.State?.SessionId ? "" : " (subagent)";
            row.Children.Add(new TextBlock { Text = $"Lunos asks: {request.Permission} {string.Join(", ", request.Patterns)}{from}", Margin = new Thickness(4, 4, 4, 2) });
            row.Children.Add(MakeButton("Allow once", () => Run(() => Lunos.ReplyAsync(request.Id, "once"))));
            row.Children.Add(MakeButton("Always", () => Run(() => Lunos.ReplyAsync(request.Id, "always"))));
            row.Children.Add(MakeButton("Reject", () => Run(() => Lunos.ReplyAsync(request.Id, "reject"))));
            return row;
        }

        private static Button MakeButton(string text, Action action)
        {
            var button = new Button { Content = text, Margin = new Thickness(2), Padding = new Thickness(6, 1, 6, 1) };
            button.Click += (_, __) => action();
            return button;
        }

        private void Run(Func<System.Threading.Tasks.Task> work) => LunosCommands.Run(_package, work);
    }
}
