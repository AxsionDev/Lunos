package tech.lunos.ide.core

import java.io.File
import java.net.ServerSocket
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

// Starts the local Lunos server an IDE talks to (XCOD-333, PROTOCOL.md "Starting"): `lunos serve` on
// 127.0.0.1 and a free port, protected by a random password, in the project directory, so the
// organisation's managed config and locks apply exactly as in the TUI. No IntelliJ imports.

class LunosServer private constructor(val process: Process, val url: String, val password: String) {
    fun stop() {
        process.destroy()
        if (!process.waitFor(3, TimeUnit.SECONDS)) process.destroyForcibly()
    }

    companion object {
        const val INSTALL_COMMAND = "npm i -g lunos-ai@latest --allow-scripts=lunos-ai"

        fun start(binary: String, directory: File, caller: String, timeoutSeconds: Long = 30, env: Map<String, String> = emptyMap()): LunosServer {
            val password = randomPassword()
            val port = ServerSocket(0).use { it.localPort }
            val builder = ProcessBuilder(command(binary, listOf("serve", "--hostname", "127.0.0.1", "--port", port.toString())))
                .directory(directory)
                .redirectErrorStream(true)
            builder.environment()["OPENCODE_SERVER_PASSWORD"] = password
            builder.environment()["OPENCODE_CALLER"] = caller
            builder.environment().putAll(env)
            val process = builder.start()
            val reader = process.inputStream.bufferedReader()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(timeoutSeconds)
            val output = StringBuilder()
            while (System.nanoTime() < deadline) {
                val line = reader.readLine() ?: break
                output.appendLine(line)
                val url = listeningUrl(line) ?: continue
                // Keep draining the output so the server never blocks on a full pipe.
                Thread({ runCatching { reader.forEachLine { } } }, "lunos-server-output").apply { isDaemon = true }.start()
                return LunosServer(process, url, password)
            }
            process.destroyForcibly()
            throw IllegalStateException("Lunos didn't start:\n${output.toString().take(2000)}")
        }

        /** "opencode server listening on http://127.0.0.1:4096" → the URL. */
        fun listeningUrl(line: String): String? = Regex("""listening on (https?://\S+)""").find(line)?.groupValues?.get(1)

        /** The command for the TUI attached to this server in the IDE's terminal. The password goes in the environment, never the command line. */
        fun attachCommand(binary: String, url: String, directory: File, sessionID: String?) =
            command(binary, listOfNotNull("attach", url, "--dir", directory.path, sessionID?.let { "--session" }, sessionID))

        /**
         * The `lunos` executable: the setting if set, otherwise the first `lunos` on PATH. Never
         * `opencode`, which would start upstream opencode under the Lunos name (as sdks/vscode/src/cli.ts).
         */
        fun resolveBinary(setting: String?, env: Map<String, String>, windows: Boolean, exists: (File) -> Boolean = { it.isFile }): String? {
            val configured = setting?.trim().orEmpty()
            if (configured.isNotEmpty()) return configured.takeIf { exists(File(it)) }
            val path = env["PATH"] ?: env["Path"] ?: ""
            val names = if (windows) (env["PATHEXT"] ?: ".EXE;.CMD;.BAT").split(";").filter { it.isNotEmpty() }.map { "lunos" + it.lowercase() } else listOf("lunos")
            return path.split(if (windows) ";" else ":").filter { it.isNotEmpty() }
                .flatMap { dir -> names.map { File(dir, it) } }
                .firstOrNull(exists)?.path
        }

        private fun command(binary: String, args: List<String>): List<String> {
            // npm installs `lunos.cmd` on Windows, which only runs through cmd.exe.
            if (binary.endsWith(".cmd", ignoreCase = true) || binary.endsWith(".bat", ignoreCase = true))
                return listOf("cmd.exe", "/c", binary) + args
            return listOf(binary) + args
        }

        private fun randomPassword(): String {
            val bytes = ByteArray(24)
            SecureRandom().nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
