using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;

namespace Lunos.Core
{
    // The IDE protocol client (XCOD-333, sdks/ide/PROTOCOL.md): the local Lunos server's HTTP API on
    // 127.0.0.1, with HTTP basic auth and the solution directory on every request. Same calls as the
    // JetBrains plugin's LunosClient.kt.

    public sealed class SessionInfo
    {
        public SessionInfo(string id, string title, string? parentId, long updated)
        {
            Id = id;
            Title = title;
            ParentId = parentId;
            Updated = updated;
        }

        public string Id { get; }
        public string Title { get; }
        public string? ParentId { get; }
        public long Updated { get; }
        public override string ToString() => string.IsNullOrWhiteSpace(Title) ? Id : Title;
    }

    public sealed class FileDiff
    {
        public FileDiff(string file, string? patch, string? status)
        {
            File = file;
            Patch = patch;
            Status = status;
        }

        public string File { get; }
        public string? Patch { get; }
        public string? Status { get; }
    }

    public sealed class PermissionRequest
    {
        public PermissionRequest(string id, string sessionId, string permission, IReadOnlyList<string> patterns)
        {
            Id = id;
            SessionId = sessionId;
            Permission = permission;
            Patterns = patterns;
        }

        public string Id { get; }
        public string SessionId { get; }
        public string Permission { get; }
        public IReadOnlyList<string> Patterns { get; }
    }

    public sealed class ServerEvent
    {
        public ServerEvent(string type, JsonObject properties)
        {
            Type = type;
            Properties = properties;
        }

        public string Type { get; }
        public JsonObject Properties { get; }
    }

    public sealed class LunosApiException : Exception
    {
        public LunosApiException(int status, string message) : base(message) => Status = status;
        public int Status { get; }
    }

    public sealed class LunosClient : IDisposable
    {
        private readonly HttpClient _http;
        private readonly string _directory;

        public LunosClient(string url, string? password, string directory, string username = "opencode", HttpMessageHandler? handler = null)
        {
            Url = url.TrimEnd('/');
            _directory = directory;
            _http = handler == null ? new HttpClient() : new HttpClient(handler);
            _http.Timeout = Timeout.InfiniteTimeSpan;
            var authorization = Authorization(username, password);
            if (authorization != null) _http.DefaultRequestHeaders.Authorization = AuthenticationHeaderValue.Parse(authorization);
        }

        public string Url { get; }

        public static string? Authorization(string username, string? password)
        {
            if (string.IsNullOrEmpty(password)) return null;
            return "Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(username + ":" + password));
        }

        public async Task<bool> HealthAsync(CancellationToken ct = default)
        {
            try
            {
                return (await GetAsync("/global/health", ct).ConfigureAwait(false))?["healthy"]?.GetValue<bool>() == true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        public async Task<IReadOnlyList<SessionInfo>> SessionsAsync(CancellationToken ct = default) =>
            Array(await GetAsync("/session", ct).ConfigureAwait(false)).Select(Session).ToList();

        public async Task<SessionInfo> CreateSessionAsync(string? title, string? parentId = null, CancellationToken ct = default)
        {
            var body = new JsonObject();
            if (title != null) body["title"] = title;
            if (parentId != null) body["parentID"] = parentId;
            return Session((await SendAsync(HttpMethod.Post, "/session", body, ct).ConfigureAwait(false))!.AsObject());
        }

        public async Task<IReadOnlyList<SessionInfo>> ChildrenAsync(string sessionId, CancellationToken ct = default) =>
            Array(await GetAsync($"/session/{sessionId}/children", ct).ConfigureAwait(false)).Select(Session).ToList();

        /// <summary>Busy sessions by id ("busy", "retry"); idle sessions are absent.</summary>
        public async Task<IReadOnlyDictionary<string, string>> StatusAsync(CancellationToken ct = default)
        {
            var node = (await GetAsync("/session/status", ct).ConfigureAwait(false))?.AsObject() ?? new JsonObject();
            return node.ToDictionary(kv => kv.Key, kv => kv.Value?["type"]?.GetValue<string>() ?? "idle");
        }

        /// <summary>Sends a prompt; it runs in the background and its progress comes as events.</summary>
        public Task PromptAsync(string sessionId, JsonArray parts, string? providerId = null, string? modelId = null, string? agent = null, CancellationToken ct = default)
        {
            var body = new JsonObject { ["parts"] = parts };
            if (providerId != null && modelId != null) body["model"] = new JsonObject { ["providerID"] = providerId, ["modelID"] = modelId };
            if (agent != null) body["agent"] = agent;
            return SendAsync(HttpMethod.Post, $"/session/{sessionId}/prompt_async", body, ct);
        }

        public Task AbortAsync(string sessionId, CancellationToken ct = default) =>
            SendAsync(HttpMethod.Post, $"/session/{sessionId}/abort", new JsonObject(), ct);

        /// <summary>The files a user message changed.</summary>
        public async Task<IReadOnlyList<FileDiff>> DiffAsync(string sessionId, string messageId, CancellationToken ct = default) =>
            Array(await GetAsync($"/session/{sessionId}/diff?messageID={Uri.EscapeDataString(messageId)}", ct).ConfigureAwait(false))
                .Select(o => new FileDiff(Str(o, "file") ?? "", Str(o, "patch"), Str(o, "status")))
                .ToList();

        public async Task<IReadOnlyList<PermissionRequest>> PermissionsAsync(CancellationToken ct = default) =>
            Array(await GetAsync("/permission", ct).ConfigureAwait(false)).Select(Permission).ToList();

        /// <summary><paramref name="reply"/> is "once", "always" or "reject".</summary>
        public Task ReplyAsync(string requestId, string reply, string? message = null, CancellationToken ct = default)
        {
            var body = new JsonObject { ["reply"] = reply };
            if (message != null) body["message"] = message;
            return SendAsync(HttpMethod.Post, $"/permission/{requestId}/reply", body, ct);
        }

        /// <summary>Streams the server's events until the connection closes, <paramref name="onEvent"/> returns false, or cancellation.</summary>
        public async Task EventsAsync(Func<ServerEvent, bool> onEvent, CancellationToken ct = default)
        {
            using var request = Request(HttpMethod.Get, "/event");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
            using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) throw new LunosApiException((int)response.StatusCode, $"GET /event: {(int)response.StatusCode}");
            using var stream = await response.Content.ReadAsStreamAsync().ConfigureAwait(false);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var parser = new SseParser();
            while (!ct.IsCancellationRequested)
            {
                var line = await reader.ReadLineAsync().ConfigureAwait(false);
                if (line == null) return;
                var data = parser.Feed(line);
                if (data == null) continue;
                JsonObject? json;
                try
                {
                    json = JsonNode.Parse(data) as JsonObject;
                }
                catch (System.Text.Json.JsonException)
                {
                    continue;
                }
                var type = json == null ? null : Str(json, "type");
                if (json == null || type == null) continue;
                var properties = json["properties"] as JsonObject ?? new JsonObject();
                if (!onEvent(new ServerEvent(type, properties))) return;
            }
        }

        public void Dispose() => _http.Dispose();

        internal static string? Str(JsonObject o, string key) =>
            o[key] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

        internal static PermissionRequest Permission(JsonObject o) => new PermissionRequest(
            Str(o, "id") ?? "",
            Str(o, "sessionID") ?? "",
            Str(o, "permission") ?? "",
            (o["patterns"] as JsonArray)?.Select(p => p?.GetValue<string>() ?? "").ToList() ?? new List<string>());

        private static SessionInfo Session(JsonObject o) => new SessionInfo(
            Str(o, "id") ?? "",
            Str(o, "title") ?? "",
            Str(o, "parentID"),
            o["time"]?["updated"] is JsonValue updated && updated.TryGetValue<long>(out var value) ? value : 0);

        private static IEnumerable<JsonObject> Array(JsonNode? node) =>
            (node as JsonArray)?.OfType<JsonObject>() ?? Enumerable.Empty<JsonObject>();

        private Task<JsonNode?> GetAsync(string path, CancellationToken ct) => SendAsync(HttpMethod.Get, path, null, ct);

        private async Task<JsonNode?> SendAsync(HttpMethod method, string path, JsonNode? body, CancellationToken ct)
        {
            using var request = Request(method, path);
            if (body != null) request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            using var response = await _http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            var text = response.Content == null ? "" : await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
                throw new LunosApiException((int)response.StatusCode, $"{method} {path}: {(int)response.StatusCode} {(text.Length > 300 ? text.Substring(0, 300) : text)}");
            return string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
        }

        private HttpRequestMessage Request(HttpMethod method, string path)
        {
            var request = new HttpRequestMessage(method, Url + path);
            request.Headers.Add("x-opencode-directory", _directory);
            return request;
        }
    }

    /// <summary>Server-Sent Events: collects <c>data:</c> lines and returns the payload at each blank line.</summary>
    public sealed class SseParser
    {
        private readonly StringBuilder _data = new StringBuilder();
        private bool _has;

        public string? Feed(string line)
        {
            if (line.Length == 0)
            {
                if (!_has) return null;
                var result = _data.ToString();
                _data.Clear();
                _has = false;
                return result;
            }
            if (!line.StartsWith("data:", StringComparison.Ordinal)) return null;
            if (_has) _data.Append('\n');
            var value = line.Substring(5);
            _data.Append(value.StartsWith(" ", StringComparison.Ordinal) ? value.Substring(1) : value);
            _has = true;
            return null;
        }
    }
}
