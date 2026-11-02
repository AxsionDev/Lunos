package tech.lunos.ide.ui

import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.thisLogger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.SystemInfo
import com.intellij.util.EnvironmentUtil
import tech.lunos.ide.core.Change
import tech.lunos.ide.core.FileDiff
import tech.lunos.ide.core.LunosClient
import tech.lunos.ide.core.LunosServer
import tech.lunos.ide.core.Problem
import tech.lunos.ide.core.PromptContext
import tech.lunos.ide.core.Selection
import tech.lunos.ide.core.SessionInfo
import tech.lunos.ide.core.SessionState
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList

/**
 * One Lunos server per project (XCOD-333): started on first use in the project directory, or an
 * existing one when LUNOS_SERVER_URL is set. Holds the open session's state, fed by the event stream,
 * and tells the panel what changed. All network calls run off the EDT; listeners are called on the EDT.
 */
@Service(Service.Level.PROJECT)
class LunosService(private val project: Project) : Disposable {
    val root = File(project.basePath ?: System.getProperty("user.home"))

    @Volatile var client: LunosClient? = null
        private set
    @Volatile var server: LunosServer? = null
        private set
    @Volatile var state: SessionState? = null
        private set
    /** Approval mode in this IDE (XCOD-310's Manual / Auto): Auto answers "once" to every request. */
    @Volatile var autoApprove = false
    /** The changes of the last prompt, waiting for review. */
    @Volatile var pendingReview: List<FileDiff> = emptyList()
        private set

    private val listeners = CopyOnWriteArrayList<(Change) -> Unit>()
    @Volatile private var disposed = false
    @Volatile private var events: Thread? = null

    fun onChange(listener: (Change) -> Unit, parent: Disposable) {
        listeners += listener
        com.intellij.openapi.util.Disposer.register(parent) { listeners -= listener }
    }

    /** Connects (starting `lunos serve` if needed). Blocking: call off the EDT. */
    @Synchronized
    fun connect(): LunosClient {
        client?.let { return it }
        val env = EnvironmentUtil.getEnvironmentMap()
        val attachUrl = env["LUNOS_SERVER_URL"]
        val created = if (attachUrl != null) {
            LunosClient(attachUrl, env["LUNOS_SERVER_PASSWORD"] ?: env["OPENCODE_SERVER_PASSWORD"], root.path)
        } else {
            val binary = binary() ?: throw IllegalStateException(
                "The Lunos CLI isn't installed or isn't on your PATH. Install it with: ${LunosServer.INSTALL_COMMAND}, " +
                    "or set its path in Settings | Tools | Lunos.",
            )
            val started = LunosServer.start(binary, root, "jetbrains")
            server = started
            LunosClient(started.url, started.password, root.path)
        }
        client = created
        startEvents(created)
        return created
    }

    fun binary(): String? = LunosServer.resolveBinary(
        PropertiesComponent.getInstance().getValue(PATH_SETTING),
        EnvironmentUtil.getEnvironmentMap(),
        SystemInfo.isWindows,
    )

    /** Top-level sessions of this project, newest first: the same list as the TUI's /sessions. */
    fun sessions(): List<SessionInfo> = connect().sessions().filter { it.parentID == null }.sortedByDescending { it.updated }

    fun open(sessionID: String) {
        val c = connect()
        val next = SessionState(sessionID)
        next.seed(c.children(sessionID), c.status(), c.permissions())
        state = next
        pendingReview = emptyList()
        fire(Change.TRANSCRIPT)
        fire(Change.SUBAGENTS)
        fire(Change.PERMISSIONS)
    }

    fun newSession(title: String? = null): SessionInfo {
        val session = connect().createSession(title)
        open(session.id)
        return session
    }

    /** Sends a prompt with the IDE context to the open session, creating one if there's none. */
    fun send(text: String, file: File?, selection: Selection?, problems: List<Problem> = emptyList()) {
        val c = connect()
        val session = state?.sessionID ?: newSession(text.lineSequence().first().take(60)).id
        c.prompt(session, PromptContext.parts(text, file, root, selection, problems))
    }

    fun reply(requestID: String, reply: String) = connect().reply(requestID, reply)

    fun abort() {
        val id = state?.sessionID ?: return
        connect().abort(id)
    }

    fun clearReview() {
        pendingReview = emptyList()
        fire(Change.STATUS)
    }

    private fun startEvents(c: LunosClient) {
        events = Thread({
            while (!disposed) {
                runCatching { c.events { event -> handle(event); !disposed } }
                    .onFailure { if (!disposed) thisLogger().info("Lunos event stream closed, reconnecting", it) }
                if (!disposed) Thread.sleep(1000)
            }
        }, "lunos-events").apply {
            isDaemon = true
            start()
        }
    }

    private fun handle(event: tech.lunos.ide.core.ServerEvent) {
        val current = state ?: return
        val change = synchronized(current) { current.handle(event) }
        if (change == Change.PERMISSIONS && autoApprove) {
            current.permissions.keys.toList().forEach { id -> runCatching { connect().reply(id, "once") } }
        }
        if (change == Change.IDLE) loadReview(current)
        if (change != Change.NONE) fire(change)
    }

    private fun loadReview(current: SessionState) {
        val message = current.lastUserMessage ?: return
        // The diff is normally there at idle; a few retries cover a slow snapshot.
        var diffs = emptyList<FileDiff>()
        for (attempt in 0 until 5) {
            diffs = runCatching { connect().diff(current.sessionID, message) }.getOrElse { emptyList() }
                .filter { !it.patch.isNullOrEmpty() }
            if (diffs.isNotEmpty() || disposed) break
            Thread.sleep(500)
        }
        if (diffs.isEmpty()) return
        pendingReview = diffs
        ApplicationManager.getApplication().invokeLater {
            NotificationGroupManager.getInstance().getNotificationGroup("Lunos")
                .createNotification("Lunos changed ${diffs.size} file(s)", "Review the changes and accept or reject each hunk.", NotificationType.INFORMATION)
                .addAction(NotificationAction.createSimpleExpiring("Review changes") { ReviewChangesDialog.show(project, diffs) })
                .notify(project)
        }
    }

    private fun fire(change: Change) {
        ApplicationManager.getApplication().invokeLater({ listeners.forEach { it(change) } }, project.disposed)
    }

    override fun dispose() {
        disposed = true
        events?.interrupt()
        server?.stop()
    }

    companion object {
        const val PATH_SETTING = "lunos.path"

        fun get(project: Project): LunosService = project.getService(LunosService::class.java)

        fun onPooled(project: Project, task: () -> Unit) {
            ApplicationManager.getApplication().executeOnPooledThread {
                runCatching(task).onFailure { error ->
                    ApplicationManager.getApplication().invokeLater {
                        NotificationGroupManager.getInstance().getNotificationGroup("Lunos")
                            .createNotification("Lunos", error.message ?: error.toString(), NotificationType.ERROR)
                            .notify(project)
                    }
                }
            }
        }
    }
}
