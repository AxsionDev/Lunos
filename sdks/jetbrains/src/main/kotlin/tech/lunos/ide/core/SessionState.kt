package tech.lunos.ide.core

import com.google.gson.JsonObject

// What the IDE panel shows for one session, kept up to date from the server's events (XCOD-333,
// PROTOCOL.md "Events"): the transcript, busy/idle, approvals waiting for an answer, the model, and
// the subagents (child sessions, e.g. with Dynamic workflows on) with their state. No IntelliJ imports.

data class Entry(val id: String, val role: String, val text: String)

data class Subagent(val id: String, val parentID: String, val title: String, val status: String, val activity: String)

enum class Change { NONE, TRANSCRIPT, STATUS, PERMISSIONS, SUBAGENTS, MODEL, IDLE,
    /** Another session was opened (or a new one started): the picker selects it. */
    SESSION }

class SessionState(val sessionID: String) {
    val entries = LinkedHashMap<String, Entry>()
    val permissions = LinkedHashMap<String, PermissionRequest>()
    val subagents = LinkedHashMap<String, Subagent>()
    var busy = false
        private set
    var model: String? = null
        private set
    var agent: String? = null
        private set
    /**
     * The last prompt the user sent: a user message with a text part that isn't synthetic. Its diff,
     * which covers its whole turn, is what the IDE offers to review when the session goes idle. With
     * Dynamic workflows a turn goes on through synthetic user messages (a background subagent's
     * result, an auto-continue), so the last user message isn't necessarily the user's.
     */
    var promptMessage: String? = null
        private set
    private val roles = HashMap<String, String>()
    private var errors = 0

    /** This session and its subagents, at any depth. */
    fun tracks(id: String?) = id != null && (id == sessionID || subagents.containsKey(id))

    fun handle(event: ServerEvent): Change {
        val p = event.properties
        return when (event.type) {
            "session.created", "session.updated" -> session(p["info"]?.asJsonObject ?: return Change.NONE)
            "session.status" -> status(p.str("sessionID"), p["status"]?.asJsonObject?.str("type") ?: "idle")
            "message.updated" -> message(p["info"]?.asJsonObject ?: return Change.NONE)
            "message.part.updated" -> part(p["part"]?.asJsonObject ?: return Change.NONE)
            "permission.asked" -> {
                val request = LunosClient.permission(p)
                if (!tracks(request.sessionID)) return Change.NONE
                permissions[request.id] = request
                Change.PERMISSIONS
            }
            "permission.replied" -> if (permissions.remove(p.str("requestID")) != null) Change.PERMISSIONS else Change.NONE
            // A model or stream error (an unsupported model, a provider outage): shown in the chat.
            "session.error" -> if (p.str("sessionID") == sessionID) error(null, p["error"]) else Change.NONE
            else -> Change.NONE
        }
    }

    /** Seeds the state from `GET /permission` and `GET /session/:id/children` when a session is opened. */
    fun seed(children: List<SessionInfo>, status: Map<String, String>, pending: List<PermissionRequest>) {
        children.forEach { subagents[it.id] = Subagent(it.id, it.parentID ?: sessionID, it.title, status[it.id] ?: "idle", "") }
        busy = status[sessionID] != null && status[sessionID] != "idle"
        pending.filter { tracks(it.sessionID) }.forEach { permissions[it.id] = it }
    }

    private fun session(info: JsonObject): Change {
        val id = info.str("id") ?: return Change.NONE
        val parent = info.str("parentID")
        if (!tracks(parent) || id == sessionID) return Change.NONE
        val existing = subagents[id]
        subagents[id] = Subagent(id, parent!!, info.str("title") ?: "subagent", existing?.status ?: "busy", existing?.activity ?: "")
        return Change.SUBAGENTS
    }

    private fun status(id: String?, type: String): Change {
        if (id == sessionID) {
            val wasBusy = busy
            busy = type != "idle"
            return if (wasBusy && !busy) Change.IDLE else Change.STATUS
        }
        val sub = subagents[id] ?: return Change.NONE
        subagents[sub.id] = sub.copy(status = type)
        return Change.SUBAGENTS
    }

    private fun message(info: JsonObject): Change {
        val id = info.str("id") ?: return Change.NONE
        if (info.str("sessionID") != sessionID) return Change.NONE
        val role = info.str("role") ?: return Change.NONE
        roles[id] = role
        if (role == "user") return Change.NONE
        val failed = if (info["error"]?.isJsonObject == true) error("error:$id", info["error"]) else Change.NONE
        val providerID = info.str("providerID")
        val modelID = info.str("modelID") ?: return failed
        model = if (providerID == null) modelID else "$providerID/$modelID"
        agent = info.str("agent") ?: agent
        return if (failed == Change.NONE) Change.MODEL else failed
    }

    private fun part(part: JsonObject): Change {
        val id = part.str("id") ?: return Change.NONE
        val session = part.str("sessionID")
        val type = part.str("type")
        if (session != sessionID) {
            val sub = subagents[session] ?: return Change.NONE
            val activity = describeTool(part) ?: return Change.NONE
            subagents[sub.id] = sub.copy(activity = activity)
            return Change.SUBAGENTS
        }
        val role = roles[part.str("messageID")] ?: "assistant"
        if (type == "text") {
            if (part["synthetic"]?.asBoolean == true) return Change.NONE
            if (role == "user") promptMessage = part.str("messageID")
            entries[id] = Entry(id, role, part.str("text") ?: "")
            return Change.TRANSCRIPT
        }
        val tool = describeTool(part) ?: return Change.NONE
        entries[id] = Entry(id, "tool", tool)
        return Change.TRANSCRIPT
    }

    /**
     * An error entry. The server reports one failure both as `session.error` and on the assistant
     * message, and retries can repeat it: the same text right after an error entry isn't added again.
     */
    private fun error(key: String?, error: com.google.gson.JsonElement?): Change {
        val text = errorText(error) ?: return Change.NONE
        // A message's error is updated in place: its message is updated more than once.
        if (key != null && entries.containsKey(key)) return Change.NONE
        val last = entries.values.lastOrNull()
        if (last?.role == "error" && last.text == text) return Change.NONE
        val id = key ?: "error:${++errors}"
        entries[id] = Entry(id, "error", text)
        return Change.TRANSCRIPT
    }

    private fun describeTool(part: JsonObject): String? {
        if (part.str("type") != "tool") return null
        val state = part["state"]?.asJsonObject
        val title = state?.str("title")?.takeIf { it.isNotBlank() }
        return listOfNotNull(part.str("tool"), title, state?.str("status")).joinToString(" · ")
    }
}

/** The text of a server error (`{ name, data: { message } }`); none for a stop the user asked for. */
fun errorText(error: com.google.gson.JsonElement?): String? {
    if (error == null || !error.isJsonObject) return null
    val o = error.asJsonObject
    val name = o.str("name")
    if (name == "MessageAbortedError") return null
    val data = o["data"]?.takeIf { it.isJsonObject }?.asJsonObject
    val message = data?.str("message")?.takeIf { it.isNotBlank() } ?: o.str("message")?.takeIf { it.isNotBlank() }
    return message ?: name ?: "Unknown error"
}
