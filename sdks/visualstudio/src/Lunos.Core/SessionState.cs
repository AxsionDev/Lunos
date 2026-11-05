using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;

namespace Lunos.Core
{
    // What the tool window shows for one session, kept up to date from the server's events (XCOD-333,
    // PROTOCOL.md "Events"): transcript, busy/idle, approvals waiting, the model, and the subagents
    // (child sessions, e.g. with Dynamic workflows on) with their state. Same as SessionState.kt.

    public sealed class Entry
    {
        public Entry(string id, string role, string text)
        {
            Id = id;
            Role = role;
            Text = text;
        }

        public string Id { get; }
        public string Role { get; }
        public string Text { get; }
    }

    public sealed class Subagent
    {
        public Subagent(string id, string parentId, string title, string status, string activity)
        {
            Id = id;
            ParentId = parentId;
            Title = title;
            Status = status;
            Activity = activity;
        }

        public string Id { get; }
        public string ParentId { get; }
        public string Title { get; }
        public string Status { get; }
        public string Activity { get; }
        public override string ToString() => $"{Title} · {Status}{(Activity.Length == 0 ? "" : " · " + Activity)}";
    }

    public enum Change
    {
        None, Transcript, Status, Permissions, Subagents, Model, Idle,
        /// <summary>Another session was opened (or a new one started): the picker selects it.</summary>
        Session,
    }

    public sealed class SessionState
    {
        private readonly Dictionary<string, string> _roles = new Dictionary<string, string>();
        private readonly List<string> _entryOrder = new List<string>();
        private readonly Dictionary<string, Entry> _entries = new Dictionary<string, Entry>();
        private readonly List<string> _subagentOrder = new List<string>();
        private readonly Dictionary<string, Subagent> _subagents = new Dictionary<string, Subagent>();
        private readonly List<string> _permissionOrder = new List<string>();
        private readonly Dictionary<string, PermissionRequest> _permissions = new Dictionary<string, PermissionRequest>();
        private int _errors;

        public SessionState(string sessionId) => SessionId = sessionId;

        public string SessionId { get; }
        public bool Busy { get; private set; }
        public string? Model { get; private set; }
        /// <summary>
        /// The last prompt the user sent: a user message with a text part that isn't synthetic. Its diff,
        /// which covers its whole turn, is what the IDE offers to review when the session goes idle. With
        /// Dynamic workflows a turn goes on through synthetic user messages (a background subagent's
        /// result, an auto-continue), so the last user message isn't necessarily the user's.
        /// </summary>
        public string? PromptMessage { get; private set; }
        public IReadOnlyList<Entry> Entries => _entryOrder.Select(id => _entries[id]).ToList();
        public IReadOnlyList<Subagent> Subagents => _subagentOrder.Select(id => _subagents[id]).ToList();
        public IReadOnlyList<PermissionRequest> Permissions => _permissionOrder.Select(id => _permissions[id]).ToList();

        /// <summary>This session and its subagents, at any depth.</summary>
        public bool Tracks(string? id) => id != null && (id == SessionId || _subagents.ContainsKey(id));

        public void Seed(IEnumerable<SessionInfo> children, IReadOnlyDictionary<string, string> status, IEnumerable<PermissionRequest> pending)
        {
            foreach (var child in children)
                PutSubagent(new Subagent(child.Id, child.ParentId ?? SessionId, child.Title, status.TryGetValue(child.Id, out var s) ? s : "idle", ""));
            Busy = status.TryGetValue(SessionId, out var mine) && mine != "idle";
            foreach (var request in pending.Where(r => Tracks(r.SessionId))) PutPermission(request);
        }

        public Change Handle(ServerEvent e)
        {
            var p = e.Properties;
            switch (e.Type)
            {
                case "session.created":
                case "session.updated":
                    return p["info"] is JsonObject info ? Session(info) : Change.None;
                case "session.status":
                    return Status(LunosClient.Str(p, "sessionID"), (p["status"] as JsonObject) is JsonObject st ? LunosClient.Str(st, "type") ?? "idle" : "idle");
                case "message.updated":
                    return p["info"] is JsonObject message ? Message(message) : Change.None;
                case "message.part.updated":
                    return p["part"] is JsonObject part ? Part(part) : Change.None;
                case "permission.asked":
                    var request = LunosClient.Permission(p);
                    if (!Tracks(request.SessionId)) return Change.None;
                    PutPermission(request);
                    return Change.Permissions;
                case "permission.replied":
                    var id = LunosClient.Str(p, "requestID");
                    if (id == null || !_permissions.Remove(id)) return Change.None;
                    _permissionOrder.Remove(id);
                    return Change.Permissions;
                case "session.error":
                    // A model or stream error (an unsupported model, a provider outage): shown in the chat.
                    return LunosClient.Str(p, "sessionID") == SessionId ? Error(null, p["error"]) : Change.None;
                default:
                    return Change.None;
            }
        }

        private Change Session(JsonObject info)
        {
            var id = LunosClient.Str(info, "id");
            var parent = LunosClient.Str(info, "parentID");
            if (id == null || id == SessionId || !Tracks(parent)) return Change.None;
            _subagents.TryGetValue(id, out var existing);
            PutSubagent(new Subagent(id, parent!, LunosClient.Str(info, "title") ?? "subagent", existing?.Status ?? "busy", existing?.Activity ?? ""));
            return Change.Subagents;
        }

        private Change Status(string? id, string type)
        {
            if (id == SessionId)
            {
                var wasBusy = Busy;
                Busy = type != "idle";
                return wasBusy && !Busy ? Change.Idle : Change.Status;
            }
            if (id == null || !_subagents.TryGetValue(id, out var sub)) return Change.None;
            PutSubagent(new Subagent(sub.Id, sub.ParentId, sub.Title, type, sub.Activity));
            return Change.Subagents;
        }

        private Change Message(JsonObject info)
        {
            var id = LunosClient.Str(info, "id");
            var role = LunosClient.Str(info, "role");
            if (id == null || role == null || LunosClient.Str(info, "sessionID") != SessionId) return Change.None;
            _roles[id] = role;
            if (role == "user") return Change.None;
            var failed = info["error"] is JsonObject ? Error("error:" + id, info["error"]) : Change.None;
            var modelId = LunosClient.Str(info, "modelID");
            if (modelId == null) return failed;
            var providerId = LunosClient.Str(info, "providerID");
            Model = providerId == null ? modelId : providerId + "/" + modelId;
            return failed == Change.None ? Change.Model : failed;
        }

        private Change Part(JsonObject part)
        {
            var id = LunosClient.Str(part, "id");
            var session = LunosClient.Str(part, "sessionID");
            if (id == null) return Change.None;
            if (session != SessionId)
            {
                if (session == null || !_subagents.TryGetValue(session, out var sub)) return Change.None;
                var activity = DescribeTool(part);
                if (activity == null) return Change.None;
                PutSubagent(new Subagent(sub.Id, sub.ParentId, sub.Title, sub.Status, activity));
                return Change.Subagents;
            }
            var messageId = LunosClient.Str(part, "messageID");
            var role = messageId != null && _roles.TryGetValue(messageId, out var r) ? r : "assistant";
            if (LunosClient.Str(part, "type") == "text")
            {
                if (part["synthetic"] is JsonValue synthetic && synthetic.TryGetValue<bool>(out var s) && s) return Change.None;
                if (role == "user") PromptMessage = messageId;
                PutEntry(new Entry(id, role, LunosClient.Str(part, "text") ?? ""));
                return Change.Transcript;
            }
            var tool = DescribeTool(part);
            if (tool == null) return Change.None;
            PutEntry(new Entry(id, "tool", tool));
            return Change.Transcript;
        }

        /// <summary>
        /// An error entry. The server reports one failure both as <c>session.error</c> and on the assistant
        /// message, and retries can repeat it: the same text right after an error entry isn't added again.
        /// </summary>
        private Change Error(string? key, JsonNode? error)
        {
            var text = ErrorText(error);
            if (text == null) return Change.None;
            // A message's error is updated in place: its message is updated more than once.
            if (key != null && _entries.ContainsKey(key)) return Change.None;
            var last = _entryOrder.Count == 0 ? null : _entries[_entryOrder[_entryOrder.Count - 1]];
            if (last != null && last.Role == "error" && last.Text == text) return Change.None;
            PutEntry(new Entry(key ?? "error:" + ++_errors, "error", text));
            return Change.Transcript;
        }

        /// <summary>The text of a server error (<c>{ name, data: { message } }</c>); none for a stop the user asked for.</summary>
        public static string? ErrorText(JsonNode? error)
        {
            if (!(error is JsonObject o)) return null;
            var name = LunosClient.Str(o, "name");
            if (name == "MessageAbortedError") return null;
            var message = o["data"] is JsonObject data ? LunosClient.Str(data, "message") : null;
            if (string.IsNullOrWhiteSpace(message)) message = LunosClient.Str(o, "message");
            return string.IsNullOrWhiteSpace(message) ? name ?? "Unknown error" : message;
        }

        private static string? DescribeTool(JsonObject part)
        {
            if (LunosClient.Str(part, "type") != "tool") return null;
            var state = part["state"] as JsonObject;
            var title = state == null ? null : LunosClient.Str(state, "title");
            var items = new[] { LunosClient.Str(part, "tool"), string.IsNullOrWhiteSpace(title) ? null : title, state == null ? null : LunosClient.Str(state, "status") };
            return string.Join(" · ", items.Where(i => i != null));
        }

        private void PutEntry(Entry entry)
        {
            if (!_entries.ContainsKey(entry.Id)) _entryOrder.Add(entry.Id);
            _entries[entry.Id] = entry;
        }

        private void PutSubagent(Subagent subagent)
        {
            if (!_subagents.ContainsKey(subagent.Id)) _subagentOrder.Add(subagent.Id);
            _subagents[subagent.Id] = subagent;
        }

        private void PutPermission(PermissionRequest request)
        {
            if (!_permissions.ContainsKey(request.Id)) _permissionOrder.Add(request.Id);
            _permissions[request.Id] = request;
        }
    }
}
