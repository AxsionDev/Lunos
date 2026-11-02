package tech.lunos.ide.core

import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SessionStateTest {
    private fun event(type: String, properties: String) = ServerEvent(type, JsonParser.parseString(properties).asJsonObject)

    @Test
    fun `subagents and their state are tracked, nested ones too (Dynamic workflows)`() {
        val state = SessionState("ses_main")
        assertEquals(Change.SUBAGENTS, state.handle(event("session.created", """{"sessionID":"ses_a","info":{"id":"ses_a","parentID":"ses_main","title":"explore the API"}}""")))
        state.handle(event("session.created", """{"sessionID":"ses_b","info":{"id":"ses_b","parentID":"ses_a","title":"read tests"}}"""))
        // Another session's subagent isn't ours.
        assertEquals(Change.NONE, state.handle(event("session.created", """{"sessionID":"ses_x","info":{"id":"ses_x","parentID":"ses_other"}}""")))
        state.handle(event("message.part.updated", """{"sessionID":"ses_a","part":{"id":"prt_1","sessionID":"ses_a","messageID":"msg_1","type":"tool","tool":"grep","state":{"status":"running","title":"Calc"}}}"""))
        state.handle(event("session.status", """{"sessionID":"ses_a","status":{"type":"idle"}}"""))

        assertEquals(listOf("ses_a", "ses_b"), state.subagents.keys.toList())
        assertEquals("idle", state.subagents["ses_a"]!!.status)
        assertEquals("grep · Calc · running", state.subagents["ses_a"]!!.activity)
        assertEquals("busy", state.subagents["ses_b"]!!.status)
    }

    @Test
    fun `approvals from the session or a subagent wait until answered here or in the TUI`() {
        val state = SessionState("ses_main")
        state.seed(listOf(SessionInfo("ses_a", "sub", "ses_main", 0)), mapOf("ses_main" to "busy"), emptyList())
        assertTrue(state.busy)
        state.handle(event("permission.asked", """{"id":"per_1","sessionID":"ses_a","permission":"edit","patterns":["Calc.cs"],"metadata":{},"always":["*"]}"""))
        assertEquals(listOf("per_1"), state.permissions.keys.toList())
        // Answered anywhere (e.g. the TUI attached to the same server): the event removes it.
        assertEquals(Change.PERMISSIONS, state.handle(event("permission.replied", """{"sessionID":"ses_a","requestID":"per_1","reply":"once"}""")))
        assertTrue(state.permissions.isEmpty())
    }

    @Test
    fun `transcript, model and the idle transition that triggers the review`() {
        val state = SessionState("ses_main")
        state.handle(event("message.updated", """{"sessionID":"ses_main","info":{"id":"msg_u","sessionID":"ses_main","role":"user"}}"""))
        state.handle(event("message.part.updated", """{"sessionID":"ses_main","part":{"id":"prt_u","sessionID":"ses_main","messageID":"msg_u","type":"text","text":"Refactor"}}"""))
        state.handle(event("session.status", """{"sessionID":"ses_main","status":{"type":"busy"}}"""))
        assertEquals(Change.MODEL, state.handle(event("message.updated", """{"sessionID":"ses_main","info":{"id":"msg_a","sessionID":"ses_main","role":"assistant","providerID":"mistral","modelID":"devstral","agent":"build"}}""")))
        state.handle(event("message.part.updated", """{"sessionID":"ses_main","part":{"id":"prt_a","sessionID":"ses_main","messageID":"msg_a","type":"text","text":"Done."}}"""))
        state.handle(event("message.part.updated", """{"sessionID":"ses_main","part":{"id":"prt_s","sessionID":"ses_main","messageID":"msg_a","type":"text","text":"hidden","synthetic":true}}"""))

        assertEquals(listOf("user" to "Refactor", "assistant" to "Done."), state.entries.values.map { it.role to it.text })
        assertEquals("mistral/devstral", state.model)
        assertEquals("msg_u", state.lastUserMessage)
        assertEquals(Change.IDLE, state.handle(event("session.status", """{"sessionID":"ses_main","status":{"type":"idle"}}""")))
    }
}

class LunosServerTest {
    @Test
    fun `binary from the setting, else PATH, never opencode`() {
        val files = setOf("/opt/lunos/bin/lunos", "/usr/bin/opencode", "C:\\npm\\lunos.cmd")
        val exists = { file: File -> file.path in files }
        assertEquals("/opt/lunos/bin/lunos", LunosServer.resolveBinary(null, mapOf("PATH" to "/usr/bin:/opt/lunos/bin"), false, exists))
        assertEquals(null, LunosServer.resolveBinary(null, mapOf("PATH" to "/usr/bin"), false, exists))
        assertEquals(null, LunosServer.resolveBinary("/missing/lunos", mapOf("PATH" to "/opt/lunos/bin"), false, exists))
    }

    @Test
    fun `listening line and attach command`() {
        assertEquals("http://127.0.0.1:4317", LunosServer.listeningUrl("opencode server listening on http://127.0.0.1:4317"))
        assertEquals(null, LunosServer.listeningUrl("Warning: something"))
        assertEquals(
            listOf("/bin/lunos", "attach", "http://127.0.0.1:1", "--dir", "/work", "--session", "ses_1"),
            LunosServer.attachCommand("/bin/lunos", "http://127.0.0.1:1", File("/work"), "ses_1"),
        )
        assertEquals("cmd.exe", LunosServer.attachCommand("C:\\npm\\lunos.cmd", "u", File("/w"), null).first())
    }
}

class PromptContextTest {
    @Test
    fun `selection reference and problems`() {
        val root = File("/work/app")
        assertEquals("@src/Calc.cs#L4-8", PromptContext.reference(File("/work/app/src/Calc.cs"), root, Selection(4, 8)))
        assertEquals("@src/Calc.cs#L4", PromptContext.reference(File("/work/app/src/Calc.cs"), root, Selection(4, 4)))
        val parts = PromptContext.parts("Fix", null, root, null, listOf(Problem("src/Calc.cs", 3, "ERROR", "CS1002: ; expected")))
        assertEquals(2, parts.size())
        assertEquals("Problems reported by the IDE:\n- src/Calc.cs:3 [ERROR] CS1002: ; expected", parts[1].asJsonObject["text"].asString)
    }
}
