package tech.lunos.ide.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

// The plugin's own client and launcher against a real `lunos serve` (XCOD-333): sessions created from
// the IDE are in the list the TUI's /sessions reads, subagents are listed under them, and events stream
// with the password. Runs when LUNOS_E2E_BIN points at a `lunos` (or a script running the dev build):
//   LUNOS_E2E_BIN=/path/to/lunos ./gradlew test
// Data goes to a temporary XDG_DATA_HOME, never the user's sessions.
class RealServerTest {
    private val binary = System.getenv("LUNOS_E2E_BIN")
    private lateinit var home: File
    private lateinit var project: File
    private var server: LunosServer? = null

    @Before
    fun start() {
        assumeTrue("LUNOS_E2E_BIN not set", !binary.isNullOrEmpty())
        home = Files.createTempDirectory("lunos-e2e-home").toFile()
        project = Files.createTempDirectory("lunos-e2e-project").toFile().canonicalFile
        ProcessBuilder("git", "init", "-q").directory(project).start().waitFor(10, TimeUnit.SECONDS)
        server = LunosServer.start(
            binary!!, project, "jetbrains-test", 120,
            mapOf(
                "XDG_DATA_HOME" to File(home, "data").path,
                "XDG_STATE_HOME" to File(home, "state").path,
                "XDG_CACHE_HOME" to File(home, "cache").path,
                "XDG_CONFIG_HOME" to File(home, "config").path,
            ),
        )
    }

    @After
    fun stop() {
        server?.stop()
        if (::home.isInitialized) home.deleteRecursively()
        if (::project.isInitialized) project.deleteRecursively()
    }

    @Test
    fun `a session started in the IDE is in the TUI's session list, with its subagents`() {
        val s = server!!
        val client = LunosClient(s.url, s.password, project.path)
        assertTrue(client.health())
        assertEquals(401, runCatching { LunosClient(s.url, "wrong", project.path).sessions() }.exceptionOrNull().let { (it as LunosApiException).status })

        val events = CopyOnWriteArrayList<ServerEvent>()
        val reader = Thread { runCatching { client.events { events += it; events.size < 50 } } }.apply { isDaemon = true; start() }
        Thread.sleep(500)

        val session = client.createSession("Refactor from Rider")
        val child = client.createSession("explore", parentID = session.id)
        assertTrue(client.sessions().any { it.id == session.id && it.title == "Refactor from Rider" })
        assertEquals(listOf(child.id), client.children(session.id).map { it.id })
        assertEquals(emptyList<PermissionRequest>(), client.permissions().filter { it.sessionID == session.id })

        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline && events.none { it.type == "session.created" && it.properties["info"]?.asJsonObject?.str("id") == child.id })
            Thread.sleep(100)
        assertEquals("server.connected", events.first().type)
        val state = SessionState(session.id)
        events.forEach { state.handle(it) }
        assertEquals(listOf(child.id), state.subagents.keys.toList())
        reader.interrupt()
    }

    @Test
    fun `a prompt the server can't run shows its error in the panel`() {
        val s = server!!
        val client = LunosClient(s.url, s.password, project.path)
        val session = client.createSession("No provider")
        val state = SessionState(session.id)
        val reader = Thread {
            runCatching { client.events { event -> synchronized(state) { state.handle(event) }; true } }
        }.apply { isDaemon = true; start() }
        Thread.sleep(500)
        // This server has no provider set up (a fresh XDG home): the prompt fails with an error.
        client.prompt(session.id, PromptContext.parts("Hello", null, project, null, emptyList()))
        val deadline = System.currentTimeMillis() + 30_000
        while (System.currentTimeMillis() < deadline && synchronized(state) { state.entries.values.none { it.role == "error" } })
            Thread.sleep(100)
        val errors = synchronized(state) { state.entries.values.filter { it.role == "error" } }
        assertEquals(1, errors.size)
        assertTrue(errors.single().text, errors.single().text.isNotBlank() && errors.single().text != "Unknown error")
        reader.interrupt()
    }
}
