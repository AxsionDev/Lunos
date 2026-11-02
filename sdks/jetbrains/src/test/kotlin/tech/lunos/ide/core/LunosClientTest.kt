package tech.lunos.ide.core

import com.google.gson.JsonParser
import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.util.Collections

// The client against a stand-in server that records requests: auth, the directory header, paths and bodies.
class LunosClientTest {
    private data class Seen(val method: String, val path: String, val auth: String?, val directory: String?, val body: String)

    private val seen = Collections.synchronizedList(mutableListOf<Seen>())
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/") { exchange ->
            val body = exchange.requestBody.readBytes().decodeToString()
            seen += Seen(
                exchange.requestMethod,
                exchange.requestURI.toString(),
                exchange.requestHeaders.getFirst("Authorization"),
                exchange.requestHeaders.getFirst("x-opencode-directory"),
                body,
            )
            val path = exchange.requestURI.path
            if (exchange.requestHeaders.getFirst("Authorization") != LunosClient.authorization("opencode", "pw")) {
                exchange.sendResponseHeaders(401, -1)
                exchange.close()
                return@createContext
            }
            val (status, response) = when {
                path == "/session" && exchange.requestMethod == "POST" -> 200 to """{"id":"ses_1","title":"From IDE","time":{"updated":5}}"""
                path == "/session" -> 200 to """[{"id":"ses_1","title":"From IDE","time":{"updated":5}},{"id":"ses_2","title":"child","parentID":"ses_1"}]"""
                path == "/session/ses_1/prompt_async" -> 204 to ""
                path == "/session/ses_1/diff" -> 200 to """[{"file":"Calc.cs","patch":"@@ -1 +1 @@\n-a\n+b\n","additions":1,"deletions":1}]"""
                path == "/session/status" -> 200 to """{"ses_2":{"type":"busy"}}"""
                path == "/permission" -> 200 to """[{"id":"per_1","sessionID":"ses_2","permission":"edit","patterns":["Calc.cs"],"metadata":{},"always":["*"]}]"""
                path.startsWith("/permission/") -> 200 to "true"
                path == "/event" -> 200 to "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n" +
                    "data: {\"type\":\"session.status\",\"properties\":{\"sessionID\":\"ses_1\",\"status\":{\"type\":\"busy\"}}}\n\n"
                else -> 404 to "{}"
            }
            val bytes = response.toByteArray()
            exchange.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
            exchange.close()
        }
        start()
    }
    private val url = "http://127.0.0.1:${server.address.port}"
    private val client = LunosClient(url, "pw", "/work/app")

    @After
    fun stop() = server.stop(0)

    @Test
    fun `every request carries the password and the project directory`() {
        client.sessions()
        client.status()
        assertEquals(listOf("Basic b3BlbmNvZGU6cHc="), seen.map { it.auth }.distinct())
        assertEquals(listOf("/work/app"), seen.map { it.directory }.distinct())
    }

    @Test
    fun `a wrong password is an error, not an empty list`() {
        val wrong = LunosClient(url, "nope", "/work/app")
        val error = assertThrows(LunosApiException::class.java) { wrong.sessions() }
        assertEquals(401, error.status)
    }

    @Test
    fun `sessions, prompt, diff, approvals`() {
        assertEquals(listOf("ses_1", "ses_2"), client.sessions().map { it.id })
        assertEquals("ses_1", client.sessions()[1].parentID)
        assertEquals("ses_1", client.createSession("From IDE").id)

        val parts = PromptContext.parts("Refactor", File("/work/app/Calc.cs"), File("/work/app"), Selection(4, 8), emptyList())
        client.prompt("ses_1", parts, "anthropic" to "claude")
        val prompt = JsonParser.parseString(seen.last { it.path.endsWith("prompt_async") }.body).asJsonObject
        assertEquals("claude", prompt["model"].asJsonObject["modelID"].asString)
        assertEquals("file:///work/app/Calc.cs?start=4&end=8", prompt["parts"].asJsonArray[1].asJsonObject["url"].asString)

        val diff = client.diff("ses_1", "msg_9")
        assertEquals("/session/ses_1/diff?messageID=msg_9", seen.last().path)
        assertEquals("Calc.cs", diff.single().file)

        assertEquals(mapOf("ses_2" to "busy"), client.status())
        val pending = client.permissions().single()
        assertEquals(listOf("Calc.cs"), pending.patterns)
        client.reply(pending.id, "once")
        assertEquals("/permission/per_1/reply", seen.last().path)
        assertEquals("once", JsonParser.parseString(seen.last().body).asJsonObject["reply"].asString)
    }

    @Test
    fun `events stream until the handler stops`() {
        val types = mutableListOf<String>()
        client.events { types += it.type; types.size < 2 }
        assertEquals(listOf("server.connected", "session.status"), types)
    }

    @Test
    fun `sse parser joins data lines and ignores comments`() {
        val parser = SseParser()
        assertNull(parser.feed(": heartbeat"))
        assertNull(parser.feed("data: {\"a\":"))
        assertNull(parser.feed("data: 1}"))
        assertEquals("{\"a\":\n1}", parser.feed(""))
        assertNull(parser.feed(""))
    }
}
