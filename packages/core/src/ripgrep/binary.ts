import path from "path"
import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "../cross-spawn-spawner"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { which } from "../util/which"
import { Offline } from "../offline"

export namespace RipgrepBinary {
  const VERSION = "15.1.0"
  const PLATFORM = {
    "arm64-darwin": { platform: "aarch64-apple-darwin", extension: "tar.gz" },
    "arm64-linux": { platform: "aarch64-unknown-linux-gnu", extension: "tar.gz" },
    "x64-darwin": { platform: "x86_64-apple-darwin", extension: "tar.gz" },
    "x64-linux": { platform: "x86_64-unknown-linux-musl", extension: "tar.gz" },
    "arm64-win32": { platform: "aarch64-pc-windows-msvc", extension: "zip" },
    "ia32-win32": { platform: "i686-pc-windows-msvc", extension: "zip" },
    "x64-win32": { platform: "x86_64-pc-windows-msvc", extension: "zip" },
  } as const

  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/RipgrepBinary") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const spawner = yield* ChildProcessSpawner

      const run = Effect.fnUntraced(function* (command: string, args: string[]) {
        const handle = yield* spawner.spawn(ChildProcess.make(command, args, { extendEnv: true, stdin: "ignore" }))
        const [stdout, stderr, code] = yield* Effect.all(
          [
            Stream.mkString(Stream.decodeText(handle.stdout)),
            Stream.mkString(Stream.decodeText(handle.stderr)),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        )
        return { stdout, stderr, code }
      }, Effect.scoped)

      const extract = Effect.fnUntraced(function* (
        archive: string,
        config: (typeof PLATFORM)[keyof typeof PLATFORM],
        target: string,
      ) {
        const dir = yield* fs.makeTempDirectoryScoped({ directory: Global.Path.bin, prefix: "ripgrep-" })

        // Windows 10 and later ship bsdtar, which reads zips, as System32\tar.exe. Not the `tar` on
        // PATH: Git for Windows' GNU tar can't. PowerShell's Expand-Archive is the fallback; it can
        // take longer than half a minute on a busy machine (CI runners).
        const systemTar = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : undefined
        const zipTar =
          config.extension === "zip" && systemTar && (yield* fs.isFile(systemTar).pipe(Effect.orDie))
            ? systemTar
            : undefined
        if (zipTar) {
          const result = yield* run(zipTar, ["-xf", archive, "-C", dir])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        if (config.extension === "zip" && !zipTar) {
          const shell = (yield* Effect.sync(() => which("powershell.exe") ?? which("pwsh.exe"))) ?? "powershell.exe"
          const result = yield* run(shell, [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `$global:ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${dir.replaceAll("'", "''")}' -Force`,
          ])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        if (config.extension === "tar.gz") {
          const result = yield* run("tar", ["-xzf", archive, "-C", dir])
          if (result.code !== 0)
            throw new Error(
              result.stderr.trim() || result.stdout.trim() || `ripgrep extraction failed with code ${result.code}`,
            )
        }

        const extracted = path.join(
          dir,
          `ripgrep-${VERSION}-${config.platform}`,
          process.platform === "win32" ? "rg.exe" : "rg",
        )
        if (!(yield* fs.isFile(extracted))) throw new Error(`ripgrep archive did not contain executable: ${extracted}`)

        // Several processes can install at once (turbo runs packages' tests in parallel): copy next to
        // the target under this install's own name, then rename it into place, so no process ever runs
        // a half-copied rg. If another process got there first (Windows won't replace an exe in use),
        // use its copy.
        const staged = `${target}.${path.basename(dir)}`
        yield* fs.copyFile(extracted, staged)
        if (process.platform !== "win32") yield* fs.chmod(staged, 0o755)
        yield* fs.rename(staged, target).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* fs.remove(staged, { force: true }).pipe(Effect.ignore)
              if (!(yield* fs.isFile(target))) return yield* Effect.fail(error)
            }),
          ),
        )
      }, Effect.scoped)

      return Service.of({
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const system = yield* Effect.sync(() => which(process.platform === "win32" ? "rg.exe" : "rg"))
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system

            const target = path.join(Global.Path.bin, `rg${process.platform === "win32" ? ".exe" : ""}`)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target

            const platformKey = `${process.arch}-${process.platform}` as keyof typeof PLATFORM
            const config = PLATFORM[platformKey]
            if (!config) throw new Error(`unsupported platform for ripgrep: ${platformKey}`)

            if (Offline.enabled()) throw new Offline.DisabledError("Downloading ripgrep (install `rg` instead)")
            const filename = `ripgrep-${VERSION}-${config.platform}.${config.extension}`
            const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${filename}`
            yield* Effect.logInfo("downloading ripgrep", { url })
            yield* fs.ensureDir(Global.Path.bin).pipe(Effect.orDie)
            // This install's own directory: a shared archive path let one process overwrite or delete
            // the archive while another was still extracting it (Expand-Archive failing on Windows CI).
            const download = yield* fs.makeTempDirectoryScoped({
              directory: Global.Path.bin,
              prefix: "ripgrep-download-",
            })
            const archive = path.join(download, filename)
            const bytes = yield* HttpClientRequest.get(url).pipe(
              http.execute,
              Effect.flatMap((response) => response.arrayBuffer),
              Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
            )
            if (bytes.byteLength === 0) throw new Error(`failed to download ripgrep from ${url}`)

            yield* fs.writeWithDirs(archive, new Uint8Array(bytes))
            yield* extract(archive, config, target)
            return target
          }).pipe(Effect.scoped),
        ),
      })
    }),
  )

  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node, httpClient, CrossSpawnSpawner.node],
  })
}
