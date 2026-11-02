using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Lunos.Core;
using Xunit;

namespace Lunos.Core.Tests
{
    // The plugin's client and launcher against a real `lunos serve` (XCOD-333): a session started from the
    // IDE is in the list the TUI's /sessions reads, its subagents are listed, and events stream with the
    // password. Runs when LUNOS_E2E_BIN points at a `lunos` (or a script running the dev build); passes
    // trivially otherwise. Data goes to a temporary XDG_DATA_HOME, never the user's sessions.
    public class RealServerTests
    {
        [Fact]
        public async Task ASessionStartedInTheIdeIsInTheTuisSessionListWithItsSubagents()
        {
            var binary = Environment.GetEnvironmentVariable("LUNOS_E2E_BIN");
            if (string.IsNullOrEmpty(binary)) return;
            var home = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "lunos-e2e-" + Guid.NewGuid().ToString("N"))).FullName;
            var project = Directory.CreateDirectory(Path.Combine(home, "project")).FullName;
            Process.Start(new ProcessStartInfo("git", "init -q") { WorkingDirectory = project, UseShellExecute = false })!.WaitForExit();
            var env = new Dictionary<string, string>
            {
                ["XDG_DATA_HOME"] = Path.Combine(home, "data"),
                ["XDG_STATE_HOME"] = Path.Combine(home, "state"),
                ["XDG_CACHE_HOME"] = Path.Combine(home, "cache"),
                ["XDG_CONFIG_HOME"] = Path.Combine(home, "config"),
            };
            using var server = await LunosServer.StartAsync(binary!, project, "visualstudio-test", env, TimeSpan.FromMinutes(2));
            try
            {
                using var client = new LunosClient(server.Url, server.Password, project);
                Assert.True(await client.HealthAsync());
                using var wrong = new LunosClient(server.Url, "wrong", project);
                Assert.Equal(401, (await Assert.ThrowsAsync<LunosApiException>(() => wrong.SessionsAsync())).Status);

                var events = new ConcurrentQueue<ServerEvent>();
                using var cts = new CancellationTokenSource();
                var reader = Task.Run(() => client.EventsAsync(e => { events.Enqueue(e); return true; }, cts.Token));
                await Task.Delay(500);

                var session = await client.CreateSessionAsync("Refactor from Visual Studio");
                var child = await client.CreateSessionAsync("explore", session.Id);
                Assert.Contains(await client.SessionsAsync(), s => s.Id == session.Id && s.Title == "Refactor from Visual Studio");
                Assert.Equal(new[] { child.Id }, (await client.ChildrenAsync(session.Id)).Select(s => s.Id));

                var deadline = DateTime.UtcNow.AddSeconds(10);
                while (DateTime.UtcNow < deadline && !events.Any(e => e.Type == "session.created" && (e.Properties["info"] as JsonObject)?["id"]?.GetValue<string>() == child.Id))
                    await Task.Delay(100);
                Assert.Equal("server.connected", events.First().Type);
                var state = new SessionState(session.Id);
                foreach (var e in events) state.Handle(e);
                Assert.Equal(new[] { child.Id }, state.Subagents.Select(s => s.Id));
                cts.Cancel();
            }
            finally
            {
                server.Dispose();
                try { Directory.Delete(home, true); } catch (IOException) { }
            }
        }
    }
}
