package tech.lunos.ide.core

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.Base64

// The IDE protocol client (XCOD-333, sdks/ide/PROTOCOL.md): the local Lunos server's HTTP API on
// 127.0.0.1, with HTTP basic auth and the project directory on every request. No IntelliJ imports.

data class SessionInfo(val id: String, val title: String, val parentID: String?, val updated: Long)

data class FileDiff(val file: String, val patch: String?, val status: String?)

data class PermissionRequest(val id: String, val sessionID: String, val permission: String, val patterns: List<String>)

data class ServerEvent(val type: String, val properties: JsonObject)

class LunosApiException(val status: Int, message: String) : RuntimeException(message)

class LunosClient(
    val url: String,
    private val password: String?,
    private val directory: String,
    private val username: String = "opencode",
) {
    private val http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()

    fun health(): Boolean = runCatching { get("/global/health").asJsonObject["healthy"]?.asBoolean == true }.getOrDefault(false)

    fun sessions(): List<SessionInfo> = get("/session").asJsonArray.map { session(it.asJsonObject) }

    fun createSession(title: String?, parentID: String? = null): SessionInfo {
        val body = JsonObject()
        if (title != null) body.addProperty("title", title)
        if (parentID != null) body.addProperty("parentID", parentID)
        return session(send("POST", "/session", body).asJsonObject)
    }

    fun children(sessionID: String): List<SessionInfo> =
        get("/session/$sessionID/children").asJsonArray.map { session(it.asJsonObject) }

    /** Busy sessions by id ("busy", "retry"); idle sessions are absent. */
    fun status(): Map<String, String> =
        get("/session/status").asJsonObject.entrySet().associate { it.key to (it.value.asJsonObject["type"]?.asString ?: "idle") }

    fun messages(sessionID: String): JsonArray = get("/session/$sessionID/message").asJsonArray

    /** Sends a prompt; it runs in the background and its progress comes as events. */
    fun prompt(sessionID: String, parts: JsonArray, model: Pair<String, String>? = null, agent: String? = null) {
        val body = JsonObject()
        body.add("parts", parts)
        if (model != null) {
            val m = JsonObject()
            m.addProperty("providerID", model.first)
            m.addProperty("modelID", model.second)
            body.add("model", m)
        }
        if (agent != null) body.addProperty("agent", agent)
        send("POST", "/session/$sessionID/prompt_async", body)
    }

    fun abort(sessionID: String) {
        send("POST", "/session/$sessionID/abort", JsonObject())
    }

    /** The files a user message changed. */
    fun diff(sessionID: String, messageID: String): List<FileDiff> =
        get("/session/$sessionID/diff?messageID=${enc(messageID)}").asJsonArray.map {
            val o = it.asJsonObject
            FileDiff(o.str("file") ?: "", o.str("patch"), o.str("status"))
        }

    fun permissions(): List<PermissionRequest> = get("/permission").asJsonArray.map { permission(it.asJsonObject) }

    /** `reply` is "once", "always" or "reject". */
    fun reply(requestID: String, reply: String, message: String? = null) {
        val body = JsonObject()
        body.addProperty("reply", reply)
        if (message != null) body.addProperty("message", message)
        send("POST", "/permission/$requestID/reply", body)
    }

    /**
     * Streams the server's events (Server-Sent Events) until the connection closes or [onEvent]
     * returns false. Blocking: run it on a background thread.
     */
    fun events(onEvent: (ServerEvent) -> Boolean) {
        val request = request("/event").header("Accept", "text/event-stream").GET().build()
        val response = http.send(request, HttpResponse.BodyHandlers.ofLines())
        if (response.statusCode() != 200) throw LunosApiException(response.statusCode(), "GET /event: ${response.statusCode()}")
        val parser = SseParser()
        response.body().use { lines ->
            val iterator = lines.iterator()
            while (iterator.hasNext()) {
                val data = parser.feed(iterator.next()) ?: continue
                val json = runCatching { JsonParser.parseString(data).asJsonObject }.getOrNull() ?: continue
                val event = ServerEvent(json.str("type") ?: continue, json["properties"]?.takeIf { it.isJsonObject }?.asJsonObject ?: JsonObject())
                if (!onEvent(event)) return
            }
        }
    }

    private fun get(path: String): JsonElement = send("GET", path, null)

    private fun send(method: String, path: String, body: JsonElement?): JsonElement {
        val builder = request(path)
        if (body == null) builder.method(method, HttpRequest.BodyPublishers.noBody())
        else builder.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body.toString()))
        val response = http.send(builder.timeout(Duration.ofSeconds(30)).build(), HttpResponse.BodyHandlers.ofString())
        if (response.statusCode() !in 200..299)
            throw LunosApiException(response.statusCode(), "$method $path: ${response.statusCode()} ${response.body().take(300)}")
        if (response.body().isBlank()) return JsonObject()
        return JsonParser.parseString(response.body())
    }

    private fun request(path: String): HttpRequest.Builder {
        val builder = HttpRequest.newBuilder(URI.create(url.trimEnd('/') + path)).header("x-opencode-directory", directory)
        val authorization = authorization(username, password)
        if (authorization != null) builder.header("Authorization", authorization)
        return builder
    }

    companion object {
        fun authorization(username: String, password: String?): String? {
            if (password.isNullOrEmpty()) return null
            return "Basic " + Base64.getEncoder().encodeToString("$username:$password".toByteArray(StandardCharsets.UTF_8))
        }

        private fun enc(value: String) = URLEncoder.encode(value, StandardCharsets.UTF_8)

        private fun session(o: JsonObject) = SessionInfo(
            id = o.str("id") ?: "",
            title = o.str("title") ?: "",
            parentID = o.str("parentID"),
            updated = o["time"]?.asJsonObject?.get("updated")?.asLong ?: 0,
        )

        fun permission(o: JsonObject) = PermissionRequest(
            id = o.str("id") ?: "",
            sessionID = o.str("sessionID") ?: "",
            permission = o.str("permission") ?: "",
            patterns = o["patterns"]?.takeIf { it.isJsonArray }?.asJsonArray?.map { it.asString } ?: emptyList(),
        )
    }
}

fun JsonObject.str(key: String): String? = get(key)?.takeIf { it.isJsonPrimitive }?.asString

/** Server-Sent Events: collects `data:` lines and returns the payload at each blank line. */
class SseParser {
    private val data = StringBuilder()
    private var has = false

    fun feed(line: String): String? {
        if (line.isEmpty()) {
            if (!has) return null
            val result = data.toString()
            data.setLength(0)
            has = false
            return result
        }
        if (!line.startsWith("data:")) return null
        if (has) data.append('\n')
        data.append(line.removePrefix("data:").removePrefix(" "))
        has = true
        return null
    }
}
