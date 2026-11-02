using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Lunos.Core
{
    // Starts the local Lunos server the IDE talks to (XCOD-333, PROTOCOL.md "Starting"): `lunos serve` on
    // 127.0.0.1 and a free port with a random password, in the solution directory, so the organisation's
    // managed config and locks apply exactly as in the TUI.
    public sealed class LunosServer : IDisposable
    {
        public const string InstallCommand = "npm i -g lunos-ai@latest --allow-scripts=lunos-ai";
        private static readonly Regex Listening = new Regex(@"listening on (https?://\S+)");
        private readonly Process _process;

        private LunosServer(Process process, string url, string password)
        {
            _process = process;
            Url = url;
            Password = password;
        }

        public string Url { get; }
        public string Password { get; }

        public static async Task<LunosServer> StartAsync(string binary, string directory, string caller, IDictionary<string, string>? env = null, TimeSpan? timeout = null)
        {
            var password = RandomPassword();
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();

            var command = Command(binary, new[] { "serve", "--hostname", "127.0.0.1", "--port", port.ToString() });
            var info = new ProcessStartInfo(command[0], string.Join(" ", command.Skip(1).Select(Quote)))
            {
                WorkingDirectory = directory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            info.EnvironmentVariables["OPENCODE_SERVER_PASSWORD"] = password;
            info.EnvironmentVariables["OPENCODE_CALLER"] = caller;
            if (env != null) foreach (var pair in env) info.EnvironmentVariables[pair.Key] = pair.Value;

            var process = Process.Start(info) ?? throw new InvalidOperationException("Lunos didn't start");
            var ready = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
            var output = new StringBuilder();
            void OnLine(object sender, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                lock (output) output.AppendLine(e.Data);
                var url = ListeningUrl(e.Data);
                if (url != null) ready.TrySetResult(url);
            }
            process.OutputDataReceived += OnLine;
            process.ErrorDataReceived += OnLine;
            process.EnableRaisingEvents = true;
            process.Exited += (_, __) => ready.TrySetException(new InvalidOperationException("Lunos exited:\n" + output));
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            var finished = await Task.WhenAny(ready.Task, Task.Delay(timeout ?? TimeSpan.FromSeconds(30))).ConfigureAwait(false);
            if (finished == ready.Task) return new LunosServer(process, await ready.Task.ConfigureAwait(false), password);
            try { process.Kill(); } catch (InvalidOperationException) { }
            throw new TimeoutException("Lunos didn't start in time:\n" + output);
        }

        /// <summary>"opencode server listening on http://127.0.0.1:4096" → the URL.</summary>
        public static string? ListeningUrl(string line)
        {
            var match = Listening.Match(line);
            return match.Success ? match.Groups[1].Value : null;
        }

        /// <summary>The TUI attached to this server. The password goes in the environment, never the command line.</summary>
        public static IReadOnlyList<string> AttachCommand(string binary, string url, string directory, string? sessionId)
        {
            var args = new List<string> { "attach", url, "--dir", directory };
            if (sessionId != null)
            {
                args.Add("--session");
                args.Add(sessionId);
            }
            return Command(binary, args);
        }

        /// <summary>
        /// The <c>lunos</c> executable: the setting if set, else the first <c>lunos</c> on PATH. Never
        /// <c>opencode</c>, which would start upstream opencode under the Lunos name.
        /// </summary>
        public static string? ResolveBinary(string? setting, IDictionary<string, string?> env, bool windows, Func<string, bool>? exists = null)
        {
            exists ??= File.Exists;
            var configured = setting?.Trim() ?? "";
            if (configured.Length > 0) return exists(configured) ? configured : null;
            env.TryGetValue("PATH", out var path);
            if (path == null) env.TryGetValue("Path", out path);
            env.TryGetValue("PATHEXT", out var pathext);
            var names = windows
                ? (pathext ?? ".EXE;.CMD;.BAT").Split(';').Where(e => e.Length > 0).Select(e => "lunos" + e.ToLowerInvariant()).ToList()
                : new List<string> { "lunos" };
            var separator = windows ? ';' : ':';
            return (path ?? "").Split(separator)
                .Where(dir => dir.Length > 0)
                .SelectMany(dir => names.Select(name => windows ? dir.TrimEnd('\\') + "\\" + name : dir.TrimEnd('/') + "/" + name))
                .FirstOrDefault(exists);
        }

        public static string Quote(string arg) =>
            arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0 ? arg : "\"" + arg.Replace("\"", "\\\"") + "\"";

        private static IReadOnlyList<string> Command(string binary, IEnumerable<string> args)
        {
            // npm installs `lunos.cmd` on Windows, which only runs through cmd.exe.
            var prefix = binary.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || binary.EndsWith(".bat", StringComparison.OrdinalIgnoreCase)
                ? new List<string> { "cmd.exe", "/c", binary }
                : new List<string> { binary };
            return prefix.Concat(args).ToList();
        }

        private static string RandomPassword()
        {
            var bytes = new byte[24];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            return string.Concat(bytes.Select(b => b.ToString("x2")));
        }

        public void Dispose()
        {
            try
            {
                if (!_process.HasExited) _process.Kill();
                _process.WaitForExit(3000);
            }
            catch (InvalidOperationException) { }
            _process.Dispose();
        }
    }
}
