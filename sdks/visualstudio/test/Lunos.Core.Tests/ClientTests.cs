using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Lunos.Core;
using Xunit;

namespace Lunos.Core.Tests
{
    // The client against a stand-in handler that records requests: auth, the directory header, paths, bodies.
    public class ClientTests
    {
        private sealed class Seen
        {
            public string Method = "";
            public string Path = "";
            public string? Auth;
            public string? Directory;
            public string Body = "";
        }

        private sealed class FakeServer : HttpMessageHandler
        {
            public readonly List<Seen> Requests = new List<Seen>();

            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                var seen = new Seen
                {
                    Method = request.Method.Method,
                    Path = request.RequestUri!.PathAndQuery,
                    Auth = request.Headers.Authorization?.ToString(),
                    Directory = request.Headers.TryGetValues("x-opencode-directory", out var d) ? d.Single() : null,
                    Body = request.Content == null ? "" : await request.Content.ReadAsStringAsync(),
                };
                lock (Requests) Requests.Add(seen);
                if (seen.Auth != LunosClient.Authorization("opencode", "pw")) return new HttpResponseMessage(HttpStatusCode.Unauthorized);
                var path = request.RequestUri.AbsolutePath;
                var (status, body) = path switch
                {
                    "/session" when seen.Method == "POST" => (200, "{\"id\":\"ses_1\",\"title\":\"From VS\",\"time\":{\"updated\":5}}"),
                    "/session" => (200, "[{\"id\":\"ses_1\",\"title\":\"From VS\",\"time\":{\"updated\":5}},{\"id\":\"ses_2\",\"title\":\"child\",\"parentID\":\"ses_1\"}]"),
                    "/session/ses_1/prompt_async" => (204, ""),
                    "/session/ses_1/diff" => (200, "[{\"file\":\"Calc.cs\",\"patch\":\"@@ -1 +1 @@\\n-a\\n+b\\n\",\"additions\":1,\"deletions\":1}]"),
                    "/session/status" => (200, "{\"ses_2\":{\"type\":\"busy\"}}"),
                    "/permission" => (200, "[{\"id\":\"per_1\",\"sessionID\":\"ses_2\",\"permission\":\"edit\",\"patterns\":[\"Calc.cs\"],\"metadata\":{},\"always\":[\"*\"]}]"),
                    "/permission/per_1/reply" => (200, "true"),
                    "/event" => (200, "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n: heartbeat\n\ndata: {\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_1\",\"status\":{\"type\":\"busy\"}}}\n\n"),
                    _ => (404, "{}"),
                };
                return new HttpResponseMessage((HttpStatusCode)status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
            }
        }

        private readonly FakeServer _server = new FakeServer();
        private LunosClient Client(string password = "pw") => new LunosClient("http://127.0.0.1:4000", password, "C:\\work\\app", handler: _server);

        [Fact]
        public async Task EveryRequestCarriesThePasswordAndTheSolutionDirectory()
        {
            var client = Client();
            await client.SessionsAsync();
            await client.StatusAsync();
            Assert.Equal(new[] { "Basic b3BlbmNvZGU6cHc=" }, _server.Requests.Select(r => r.Auth).Distinct());
            Assert.Equal(new[] { "C:\\work\\app" }, _server.Requests.Select(r => r.Directory).Distinct());
        }

        [Fact]
        public async Task AWrongPasswordIsAnErrorNotAnEmptyList()
        {
            var error = await Assert.ThrowsAsync<LunosApiException>(() => Client("nope").SessionsAsync());
            Assert.Equal(401, error.Status);
        }

        [Fact]
        public async Task SessionsPromptDiffApprovals()
        {
            var client = Client();
            var sessions = await client.SessionsAsync();
            Assert.Equal(new[] { "ses_1", "ses_2" }, sessions.Select(s => s.Id));
            Assert.Equal("ses_1", sessions[1].ParentId);
            Assert.Equal("ses_1", (await client.CreateSessionAsync("From VS")).Id);

            var parts = PromptContext.Parts("Refactor", "C:\\work\\app\\Calc.cs", "C:\\work\\app", new Selection(4, 8), Array.Empty<Problem>());
            await client.PromptAsync("ses_1", parts, "mistral", "devstral");
            var prompt = JsonNode.Parse(_server.Requests.Last(r => r.Path.EndsWith("prompt_async")).Body)!;
            Assert.Equal("devstral", prompt["model"]!["modelID"]!.GetValue<string>());
            Assert.Equal("file:///C:/work/app/Calc.cs?start=4&end=8", prompt["parts"]![1]!["url"]!.GetValue<string>());
            Assert.Equal("Calc.cs", prompt["parts"]![1]!["filename"]!.GetValue<string>());

            var diff = await client.DiffAsync("ses_1", "msg_9");
            Assert.Equal("/session/ses_1/diff?messageID=msg_9", _server.Requests.Last().Path);
            Assert.Equal("Calc.cs", diff.Single().File);

            Assert.Equal("busy", (await client.StatusAsync())["ses_2"]);
            var pending = (await client.PermissionsAsync()).Single();
            Assert.Equal(new[] { "Calc.cs" }, pending.Patterns);
            await client.ReplyAsync(pending.Id, "once");
            Assert.Equal("/permission/per_1/reply", _server.Requests.Last().Path);
            Assert.Equal("once", JsonNode.Parse(_server.Requests.Last().Body)!["reply"]!.GetValue<string>());
        }

        [Fact]
        public async Task EventsStreamUntilTheHandlerStops()
        {
            var types = new List<string>();
            await Client().EventsAsync(e => { types.Add(e.Type); return types.Count < 2; });
            Assert.Equal(new[] { "server.connected", "session.status" }, types);
        }

        [Fact]
        public void SseParserJoinsDataLinesAndIgnoresComments()
        {
            var parser = new SseParser();
            Assert.Null(parser.Feed(": heartbeat"));
            Assert.Null(parser.Feed("data: {\"a\":"));
            Assert.Null(parser.Feed("data: 1}"));
            Assert.Equal("{\"a\":\n1}", parser.Feed(""));
            Assert.Null(parser.Feed(""));
        }
    }

    public class SessionStateTests
    {
        private static ServerEvent Event(string type, string properties) => new ServerEvent(type, JsonNode.Parse(properties)!.AsObject());

        [Fact]
        public void SubagentsAndTheirStateAreTrackedNestedOnesToo()
        {
            var state = new SessionState("ses_main");
            Assert.Equal(Change.Subagents, state.Handle(Event("session.created", "{\"sessionID\":\"ses_a\",\"info\":{\"id\":\"ses_a\",\"parentID\":\"ses_main\",\"title\":\"explore the API\"}}")));
            state.Handle(Event("session.created", "{\"sessionID\":\"ses_b\",\"info\":{\"id\":\"ses_b\",\"parentID\":\"ses_a\",\"title\":\"read tests\"}}"));
            Assert.Equal(Change.None, state.Handle(Event("session.created", "{\"sessionID\":\"ses_x\",\"info\":{\"id\":\"ses_x\",\"parentID\":\"ses_other\"}}")));
            state.Handle(Event("message.part.updated", "{\"sessionID\":\"ses_a\",\"part\":{\"id\":\"prt_1\",\"sessionID\":\"ses_a\",\"messageID\":\"msg_1\",\"type\":\"tool\",\"tool\":\"grep\",\"state\":{\"status\":\"running\",\"title\":\"Calc\"}}}"));
            state.Handle(Event("session.status", "{\"sessionID\":\"ses_a\",\"status\":{\"type\":\"idle\"}}"));

            Assert.Equal(new[] { "ses_a", "ses_b" }, state.Subagents.Select(s => s.Id));
            Assert.Equal("explore the API · idle · grep · Calc · running", state.Subagents[0].ToString());
            Assert.Equal("busy", state.Subagents[1].Status);
        }

        [Fact]
        public void ApprovalsWaitUntilAnsweredHereOrInTheTui()
        {
            var state = new SessionState("ses_main");
            state.Seed(new[] { new SessionInfo("ses_a", "sub", "ses_main", 0) }, new Dictionary<string, string> { ["ses_main"] = "busy" }, Array.Empty<PermissionRequest>());
            Assert.True(state.Busy);
            state.Handle(Event("permission.asked", "{\"id\":\"per_1\",\"sessionID\":\"ses_a\",\"permission\":\"edit\",\"patterns\":[\"Calc.cs\"],\"metadata\":{},\"always\":[\"*\"]}"));
            Assert.Equal(new[] { "per_1" }, state.Permissions.Select(p => p.Id));
            Assert.Equal(Change.Permissions, state.Handle(Event("permission.replied", "{\"sessionID\":\"ses_a\",\"requestID\":\"per_1\",\"reply\":\"once\"}")));
            Assert.Empty(state.Permissions);
        }

        [Fact]
        public void TranscriptModelAndTheIdleTransitionThatTriggersTheReview()
        {
            var state = new SessionState("ses_main");
            state.Handle(Event("message.updated", "{\"sessionID\":\"ses_main\",\"info\":{\"id\":\"msg_u\",\"sessionID\":\"ses_main\",\"role\":\"user\"}}"));
            state.Handle(Event("message.part.updated", "{\"sessionID\":\"ses_main\",\"part\":{\"id\":\"prt_u\",\"sessionID\":\"ses_main\",\"messageID\":\"msg_u\",\"type\":\"text\",\"text\":\"Refactor\"}}"));
            state.Handle(Event("session.status", "{\"sessionID\":\"ses_main\",\"status\":{\"type\":\"busy\"}}"));
            Assert.Equal(Change.Model, state.Handle(Event("message.updated", "{\"sessionID\":\"ses_main\",\"info\":{\"id\":\"msg_a\",\"sessionID\":\"ses_main\",\"role\":\"assistant\",\"providerID\":\"mistral\",\"modelID\":\"devstral\"}}")));
            state.Handle(Event("message.part.updated", "{\"sessionID\":\"ses_main\",\"part\":{\"id\":\"prt_a\",\"sessionID\":\"ses_main\",\"messageID\":\"msg_a\",\"type\":\"text\",\"text\":\"Done.\"}}"));
            state.Handle(Event("message.part.updated", "{\"sessionID\":\"ses_main\",\"part\":{\"id\":\"prt_s\",\"sessionID\":\"ses_main\",\"messageID\":\"msg_a\",\"type\":\"text\",\"text\":\"hidden\",\"synthetic\":true}}"));

            Assert.Equal(new[] { "user:Refactor", "assistant:Done." }, state.Entries.Select(e => e.Role + ":" + e.Text));
            Assert.Equal("mistral/devstral", state.Model);
            Assert.Equal("msg_u", state.PromptMessage);
            Assert.Equal(Change.Idle, state.Handle(Event("session.status", "{\"sessionID\":\"ses_main\",\"status\":{\"type\":\"idle\"}}")));
        }

        [Fact]
        public void TheReviewIsOfTheUsersPromptNotOfASyntheticUserMessageLaterInItsTurn()
        {
            var state = new SessionState("ses_main");
            state.Handle(Event("message.updated", "{\"sessionID\":\"ses_main\",\"info\":{\"id\":\"msg_u\",\"sessionID\":\"ses_main\",\"role\":\"user\"}}"));
            state.Handle(Event("message.part.updated", "{\"sessionID\":\"ses_main\",\"part\":{\"id\":\"prt_u\",\"sessionID\":\"ses_main\",\"messageID\":\"msg_u\",\"type\":\"text\",\"text\":\"Refactor\"}}"));
            // Dynamic workflows: a background subagent's result comes back as a synthetic user message.
            state.Handle(Event("message.updated", "{\"sessionID\":\"ses_main\",\"info\":{\"id\":\"msg_bg\",\"sessionID\":\"ses_main\",\"role\":\"user\"}}"));
            state.Handle(Event("message.part.updated", "{\"sessionID\":\"ses_main\",\"part\":{\"id\":\"prt_bg\",\"sessionID\":\"ses_main\",\"messageID\":\"msg_bg\",\"type\":\"text\",\"text\":\"Background task completed\",\"synthetic\":true}}"));
            Assert.Equal("msg_u", state.PromptMessage);
        }

        [Fact]
        public void AModelErrorIsShownInTheTranscriptOnceAStopTheUserAskedForIsnt()
        {
            var state = new SessionState("ses_main");
            Assert.Equal(Change.Transcript, state.Handle(Event("session.error", "{\"sessionID\":\"ses_main\",\"error\":{\"name\":\"APIError\",\"data\":{\"message\":\"The model is not supported when using Codex with a ChatGPT account.\",\"isRetryable\":false}}}")));
            state.Handle(Event("message.updated", "{\"sessionID\":\"ses_main\",\"info\":{\"id\":\"msg_a\",\"sessionID\":\"ses_main\",\"role\":\"assistant\",\"providerID\":\"openai\",\"modelID\":\"gpt-5.5\",\"error\":{\"name\":\"APIError\",\"data\":{\"message\":\"The model is not supported when using Codex with a ChatGPT account.\",\"isRetryable\":false}}}}"));
            state.Handle(Event("message.updated", "{\"sessionID\":\"ses_main\",\"info\":{\"id\":\"msg_a\",\"sessionID\":\"ses_main\",\"role\":\"assistant\",\"providerID\":\"openai\",\"modelID\":\"gpt-5.5\",\"error\":{\"name\":\"APIError\",\"data\":{\"message\":\"The model is not supported when using Codex with a ChatGPT account.\",\"isRetryable\":false}}}}"));
            Assert.Equal(new[] { "error:The model is not supported when using Codex with a ChatGPT account." }, state.Entries.Select(e => e.Role + ":" + e.Text));
            Assert.Equal(Change.None, state.Handle(Event("session.error", "{\"sessionID\":\"ses_other\",\"error\":{\"name\":\"APIError\",\"data\":{\"message\":\"The model is not supported when using Codex with a ChatGPT account.\",\"isRetryable\":false}}}")));
            Assert.Equal(Change.None, state.Handle(Event("session.error", "{\"sessionID\":\"ses_main\",\"error\":{\"name\":\"MessageAbortedError\",\"data\":{\"message\":\"aborted\"}}}")));
            Assert.Single(state.Entries);
        }
    }

    public class ServerAndContextTests
    {
        [Fact]
        public void BinaryFromTheSettingElsePathNeverOpencode()
        {
            var files = new HashSet<string> { "/opt/lunos/bin/lunos", "/usr/bin/opencode", "C:\\npm\\lunos.cmd" };
            Assert.Equal("/opt/lunos/bin/lunos", LunosServer.ResolveBinary(null, new Dictionary<string, string?> { ["PATH"] = "/usr/bin:/opt/lunos/bin" }, false, files.Contains));
            Assert.Null(LunosServer.ResolveBinary(null, new Dictionary<string, string?> { ["PATH"] = "/usr/bin" }, false, files.Contains));
            Assert.Equal("C:\\npm\\lunos.cmd", LunosServer.ResolveBinary(null, new Dictionary<string, string?> { ["Path"] = "C:\\Windows;C:\\npm", ["PATHEXT"] = ".EXE;.CMD" }, true, files.Contains));
        }

        [Fact]
        public void ListeningLineAndAttachCommand()
        {
            Assert.Equal("http://127.0.0.1:4317", LunosServer.ListeningUrl("opencode server listening on http://127.0.0.1:4317"));
            Assert.Null(LunosServer.ListeningUrl("Warning: something"));
            Assert.Equal(new[] { "cmd.exe", "/c", "C:\\npm\\lunos.cmd", "attach", "http://127.0.0.1:1", "--dir", "C:\\work", "--session", "ses_1" },
                LunosServer.AttachCommand("C:\\npm\\lunos.cmd", "http://127.0.0.1:1", "C:\\work", "ses_1"));
        }

        [Fact]
        public void SelectionReferenceProblemsAndUrls()
        {
            Assert.Equal("@src/Calc.cs#L4-8", PromptContext.Reference("C:\\work\\app\\src\\Calc.cs", "C:\\work\\app", new Selection(4, 8)));
            Assert.Equal("file:///C:/My%20Projects/Calc.cs", PromptContext.FileUrl("C:\\My Projects\\Calc.cs"));
            Assert.Equal("file:///work/app/Calc.cs", PromptContext.FileUrl("/work/app/Calc.cs"));
            var parts = PromptContext.Parts("Fix", null, "C:\\work", null, new[] { new Problem("src/Calc.cs", 3, "Error", "CS1002: ; expected") });
            Assert.Equal("Problems reported by the IDE:\n- src/Calc.cs:3 [Error] CS1002: ; expected", parts[1]!["text"]!.GetValue<string>());
        }
    }
}
