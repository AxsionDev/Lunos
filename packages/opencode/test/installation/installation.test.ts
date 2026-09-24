import { describe, expect } from "bun:test"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(
  handler: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string } = () =>
    "",
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    const result = handler(std?.command ?? "", std?.args ?? [])
    const output = typeof result === "string" ? { code: 0, stdout: result, stderr: "" } : result
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output.stdout ? Stream.make(encoder.encode(output.stdout)) : Stream.empty,
        stderr: output.stderr ? Stream.make(encoder.encode(output.stderr)) : Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string | { code: number; stdout?: string; stderr?: string },
) {
  const spawnerNode = makeGlobalNode({
    service: ChildProcessSpawner.ChildProcessSpawner,
    layer: mockSpawner(spawnHandler),
    deps: [],
  })
  return LayerNode.compile(Installation.node, [
    [httpClient, mockHttpClient(httpHandler)],
    [CrossSpawnSpawner.node, spawnerNode],
  ])
}

describe("installation", () => {
  describe("latest", () => {
    for (const method of ["npm", "pnpm", "bun", "yarn", "curl", "brew", "scoop", "choco", "unknown"] as const) {
      const calls: string[] = []
      testEffect(
        testLayer((request) => {
          calls.push(request.url)
          return jsonResponse({ version: "1.5.0" })
        }),
      ).effect(`reads the lunos-ai npm registry entry for ${method} installs`, () =>
        Effect.gen(function* () {
          const result = yield* Installation.use.latest(method)
          expect(result).toBe("1.5.0")
          expect(calls).toEqual([`https://registry.npmjs.org/lunos-ai/${InstallationChannel}`])
        }),
      )
    }
  })

  describe("method", () => {
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => (cmd === "npm" ? "/usr/lib\n├── lunos-ai@1.18.38\n" : ""),
      ),
    ).effect("detects a global npm install of lunos-ai", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.method()).toBe("npm")
      }),
    )

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          if (cmd === "npm") return "/usr/lib\n├── opencode-ai@1.18.30\n"
          if (cmd === "brew" || cmd === "scoop" || cmd === "choco") return "opencode"
          return ""
        },
      ),
    ).effect("does not mistake an upstream opencode install for Lunos", () =>
      Effect.gen(function* () {
        expect(yield* Installation.use.method()).toBe("unknown")
      }),
    )
  })

  describe("upgrade", () => {
    const installs: string[][] = []
    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd, args) => {
          installs.push([cmd, ...args])
          return ""
        },
      ),
    ).effect("installs lunos-ai for npm, pnpm and bun", () =>
      Effect.gen(function* () {
        yield* Installation.use.upgrade("npm", "9.9.9")
        yield* Installation.use.upgrade("pnpm", "9.9.9")
        yield* Installation.use.upgrade("bun", "9.9.9")
        const managers = installs.filter((cmd) => cmd.some((arg) => arg.includes("@9.9.9")))
        expect(managers).toEqual([
          ["npm", "install", "-g", "lunos-ai@9.9.9"],
          ["pnpm", "install", "-g", "lunos-ai@9.9.9"],
          ["bun", "install", "-g", "lunos-ai@9.9.9"],
        ])
      }),
    )

    for (const method of ["curl", "brew", "scoop", "choco", "yarn", "unknown"] as const) {
      const spawned: string[] = []
      const fetched: string[] = []
      testEffect(
        testLayer(
          (request) => {
            fetched.push(request.url)
            return new Response("install script", { status: 200 })
          },
          (cmd) => {
            spawned.push(cmd)
            return ""
          },
        ),
      ).effect(`refuses ${method} without running or fetching anything`, () =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(Installation.use.upgrade(method, "9.9.9"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toContain("Lunos isn't published on")
          expect(error.stderr).toContain("npm i -g lunos-ai")
          expect(spawned).toEqual([])
          expect(fetched).toEqual([])
        }),
      )
    }

    testEffect(
      testLayer(
        () => jsonResponse({}),
        (cmd) => {
          if (cmd === "npm") return { code: 1, stderr: "token=secret command output" }
          return ""
        },
      ),
    ).effect("returns sanitized typed errors for failed package upgrades", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Installation.use.upgrade("npm", "9.9.9"))
        expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
        expect(error.stderr).toBe("Upgrade failed for npm (exit code 1).")
        expect(error.message).toBe(error.stderr)
        expect(error.stderr).not.toContain("secret")
        expect(error.stderr).not.toContain("command output")
      }),
    )
  })
})
