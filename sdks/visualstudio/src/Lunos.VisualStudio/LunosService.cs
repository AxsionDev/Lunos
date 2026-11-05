using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Lunos.Core;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace Lunos.VisualStudio
{
    /// <summary>
    /// One Lunos server per solution (XCOD-333): <c>lunos serve</c> started on first use in the solution
    /// (or open folder) directory, or an existing one when LUNOS_SERVER_URL is set. Holds the open
    /// session's state, fed by the event stream, and raises <see cref="Changed"/> on the UI thread.
    /// </summary>
    public sealed class LunosService : IDisposable
    {
        private readonly LunosPackage _package;
        private readonly SemaphoreSlim _connect = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource _disposed = new CancellationTokenSource();
        private LunosClient? _client;

        public LunosService(LunosPackage package) => _package = package;

        public event Action<Change>? Changed;

        public LunosServer? Server { get; private set; }
        public string Root { get; private set; } = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        public SessionState? State { get; private set; }
        /// <summary>Approval mode in this IDE (XCOD-310's Manual / Auto): Auto answers "once" to every request.</summary>
        public bool AutoApprove { get; set; }
        /// <summary>The changes of the last prompt, waiting for review.</summary>
        public IReadOnlyList<FileDiff> PendingReview { get; private set; } = Array.Empty<FileDiff>();

        public string? Binary() => LunosServer.ResolveBinary(
            _package.Options.LunosPath,
            Environment.GetEnvironmentVariables().Cast<DictionaryEntry>().ToDictionary(e => (string)e.Key, e => (string?)e.Value, StringComparer.OrdinalIgnoreCase),
            windows: true);

        public async Task<LunosClient> ConnectAsync()
        {
            if (_client != null) return _client;
            await _connect.WaitAsync();
            try
            {
                if (_client != null) return _client;
                Root = await SolutionDirectoryAsync() ?? Root;
                var attach = Environment.GetEnvironmentVariable("LUNOS_SERVER_URL");
                if (!string.IsNullOrEmpty(attach))
                {
                    var password = Environment.GetEnvironmentVariable("LUNOS_SERVER_PASSWORD") ?? Environment.GetEnvironmentVariable("OPENCODE_SERVER_PASSWORD");
                    _client = new LunosClient(attach!, password, Root);
                }
                else
                {
                    var binary = Binary() ?? throw new InvalidOperationException(
                        $"The Lunos CLI isn't installed or isn't on your PATH. Install it with: {LunosServer.InstallCommand}, or set its path in Tools | Options | Lunos.");
                    Server = await LunosServer.StartAsync(binary, Root, "visualstudio");
                    _client = new LunosClient(Server.Url, Server.Password, Root);
                }
                _ = Task.Run(() => EventLoopAsync(_client));
                return _client;
            }
            finally
            {
                _connect.Release();
            }
        }

        /// <summary>Top-level sessions of this solution, newest first: the same list as the TUI's /sessions.</summary>
        public async Task<IReadOnlyList<SessionInfo>> SessionsAsync() =>
            (await (await ConnectAsync()).SessionsAsync()).Where(s => s.ParentId == null).OrderByDescending(s => s.Updated).ToList();

        public async Task OpenAsync(string sessionId)
        {
            var client = await ConnectAsync();
            var state = new SessionState(sessionId);
            state.Seed(await client.ChildrenAsync(sessionId), await client.StatusAsync(), await client.PermissionsAsync());
            State = state;
            PendingReview = Array.Empty<FileDiff>();
            await FireAsync(Change.Session, Change.Transcript, Change.Subagents, Change.Permissions);
        }

        public async Task<SessionInfo> NewSessionAsync(string? title = null)
        {
            var session = await (await ConnectAsync()).CreateSessionAsync(title);
            await OpenAsync(session.Id);
            return session;
        }

        /// <summary>Sends a prompt with the IDE context to the open session, creating one if there's none.</summary>
        public async Task SendAsync(string text, string? file, Selection? selection, IReadOnlyList<Problem>? problems = null)
        {
            var client = await ConnectAsync();
            var sessionId = State?.SessionId ?? (await NewSessionAsync(text.Split('\n')[0].Trim() is var t && t.Length > 60 ? t.Substring(0, 60) : t)).Id;
            await client.PromptAsync(sessionId, PromptContext.Parts(text, file, Root, selection, problems ?? Array.Empty<Problem>()));
        }

        public async Task ReplyAsync(string requestId, string reply) => await (await ConnectAsync()).ReplyAsync(requestId, reply);

        public async Task AbortAsync()
        {
            if (State == null) return;
            await (await ConnectAsync()).AbortAsync(State.SessionId);
        }

        public async Task ClearReviewAsync()
        {
            PendingReview = Array.Empty<FileDiff>();
            await FireAsync(Change.Status);
        }

        private async Task EventLoopAsync(LunosClient client)
        {
            while (!_disposed.IsCancellationRequested)
            {
                try
                {
                    await client.EventsAsync(e =>
                    {
                        _ = HandleAsync(e);
                        return !_disposed.IsCancellationRequested;
                    }, _disposed.Token);
                }
                catch (Exception) when (!_disposed.IsCancellationRequested)
                {
                    // The stream closes when the server restarts or the machine sleeps: reconnect.
                }
                try { await Task.Delay(1000, _disposed.Token); } catch (OperationCanceledException) { return; }
            }
        }

        private async Task HandleAsync(ServerEvent e)
        {
            var state = State;
            if (state == null) return;
            Change change;
            lock (state) change = state.Handle(e);
            if (change == Change.Permissions && AutoApprove)
                foreach (var request in state.Permissions) await ReplyAsync(request.Id, "once");
            if (change == Change.Idle) _ = Task.Run(() => LoadReviewAsync(state));
            if (change != Change.None) await FireAsync(change);
        }

        private async Task LoadReviewAsync(SessionState state)
        {
            // The prompt the user sent: its diff covers its whole turn, background subagents' merges included.
            string? message;
            lock (state) message = state.SubagentsBusy() ? null : state.PromptMessage;
            if (message == null) return;
            // The diff is normally there at idle; a few retries cover a slow snapshot.
            var diffs = new List<FileDiff>();
            for (var attempt = 0; attempt < 5 && diffs.Count == 0 && !_disposed.IsCancellationRequested; attempt++)
            {
                if (attempt > 0) await Task.Delay(500);
                diffs = (await (await ConnectAsync()).DiffAsync(state.SessionId, message)).Where(d => !string.IsNullOrEmpty(d.Patch)).ToList();
            }
            // Not for a session that is no longer open, and not twice for the same changes (a turn with a
            // background subagent goes idle more than once).
            if (diffs.Count == 0 || State != state || SameDiffs(diffs, PendingReview)) return;
            PendingReview = diffs;
            await FireAsync(Change.Status);
            await _package.JoinableTaskFactory.SwitchToMainThreadAsync();
            VsShellUtilities.ShowMessageBox(_package, $"Lunos changed {diffs.Count} file(s). Review them in the Lunos window (Review changes) to accept or reject each hunk.",
                "Lunos", OLEMSGICON.OLEMSGICON_INFO, OLEMSGBUTTON.OLEMSGBUTTON_OK, OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
        }

        private static bool SameDiffs(IReadOnlyList<FileDiff> a, IReadOnlyList<FileDiff> b) =>
            a.Count == b.Count && a.Zip(b, (x, y) => x.File == y.File && x.Patch == y.Patch).All(same => same);

        private async Task FireAsync(params Change[] changes)
        {
            await _package.JoinableTaskFactory.SwitchToMainThreadAsync();
            foreach (var change in changes) Changed?.Invoke(change);
        }

        /// <summary>The solution's folder, or the open folder; null with nothing open.</summary>
        private async Task<string?> SolutionDirectoryAsync()
        {
            await _package.JoinableTaskFactory.SwitchToMainThreadAsync();
            var solution = (IVsSolution?)await _package.GetServiceAsync(typeof(SVsSolution));
            if (solution == null) return null;
            solution.GetSolutionInfo(out var directory, out _, out _);
            return string.IsNullOrEmpty(directory) ? null : Path.GetFullPath(directory).TrimEnd('\\');
        }

        public void Dispose()
        {
            _disposed.Cancel();
            _client?.Dispose();
            Server?.Dispose();
        }
    }
}
