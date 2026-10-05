import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { NamedError } from "@opencode-ai/core/util/error"
import { describe, expect } from "bun:test"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { errorLayer } from "../../src/server/routes/instance/httpapi/middleware/error"
import { NotFoundError } from "../../src/storage/storage"
import { Provider } from "../../src/provider/provider"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))

function expectUnknownErrorBody(body: unknown) {
  expect(body).toMatchObject({
    name: "UnknownError",
    data: { message: "Unexpected server error. Check server logs for details." },
  })
  expect((body as { data?: { ref?: unknown } }).data?.ref).toMatch(/^err_[0-9a-f-]{8}$/)
}

describe("HttpApi error middleware", () => {
  it.live("returns a safe body for unknown 500 defects", () =>
    Effect.gen(function* () {
      yield* HttpRouter.add("GET", "/boom", Effect.die(new Error("secret stack marker"))).pipe(
        Layer.provide(errorLayer),
        HttpRouter.serve,
        Layer.build,
      )

      const response = yield* HttpClientRequest.get("/boom").pipe(HttpClient.execute)
      const body = yield* response.json

      expect(response.status).toBe(500)
      expectUnknownErrorBody(body)
      expect(JSON.stringify(body)).not.toContain("secret stack marker")
    }),
  )

  it.live("returns a safe body for named defects", () =>
    Effect.gen(function* () {
      yield* HttpRouter.add(
        "GET",
        "/named",
        Effect.die(new NamedError.Unknown({ message: "secret named marker" })),
      ).pipe(Layer.provide(errorLayer), HttpRouter.serve, Layer.build)

      const response = yield* HttpClientRequest.get("/named").pipe(HttpClient.execute)
      const body = yield* response.json

      expect(response.status).toBe(500)
      expectUnknownErrorBody(body)
      expect(JSON.stringify(body)).not.toContain("secret named marker")
    }),
  )

  it.live("returns invalid config defects as structured client errors", () =>
    Effect.gen(function* () {
      const configError = new ConfigErrorV1.InvalidError({
        path: "/tmp/opencode.json",
        issues: [{ message: "Expected object", path: ["provider", "anthropic", "options"] }],
      })

      yield* HttpRouter.add("GET", "/config-error", Effect.die(configError)).pipe(
        Layer.provide(errorLayer),
        HttpRouter.serve,
        Layer.build,
      )

      const response = yield* HttpClientRequest.get("/config-error").pipe(HttpClient.execute)
      const body = yield* response.json
      const serialized = JSON.stringify(body)

      expect(response.status).toBe(400)
      expect(body).toMatchObject({
        name: "ConfigInvalidError",
        data: {
          path: "/tmp/opencode.json",
          issues: [{ message: "Expected object", path: ["provider", "anthropic", "options"] }],
        },
      })
      expect(serialized).toContain("/tmp/opencode.json")
      expect(serialized).toContain("anthropic")
    }),
  )

  it.live("returns remote auth defects as structured client errors", () =>
    Effect.gen(function* () {
      const configError = new ConfigErrorV1.RemoteAuthError({
        url: "https://example.com",
        remote: "https://config.example.com/opencode.json",
      })

      yield* HttpRouter.add("GET", "/remote-auth-error", Effect.die(configError)).pipe(
        Layer.provide(errorLayer),
        HttpRouter.serve,
        Layer.build,
      )

      const response = yield* HttpClientRequest.get("/remote-auth-error").pipe(HttpClient.execute)
      const body = yield* response.json

      expect(response.status).toBe(400)
      expect(body).toEqual(configError.toObject())
    }),
  )

  // XCOD-166: was a generic UnknownError 500, so `lunos run -m <unknown>` couldn't say what was wrong.
  it.live("returns an unknown model as a client error the CLI and TUI can format", () =>
    Effect.gen(function* () {
      const missing = new Provider.ModelNotFoundError({
        providerID: ProviderV2.ID.make("mistral"),
        modelID: ModelV2.ID.make("ministral-14b-latest"),
        suggestions: ["ministral-8b-latest"],
      })
      yield* HttpRouter.add("GET", "/no-model", Effect.die(missing)).pipe(
        Layer.provide(errorLayer),
        HttpRouter.serve,
        Layer.build,
      )

      const response = yield* HttpClientRequest.get("/no-model").pipe(HttpClient.execute)
      const body = yield* response.json

      expect(response.status).toBe(400)
      expect(body).toEqual({
        name: "ProviderModelNotFoundError",
        data: {
          providerID: "mistral",
          modelID: "ministral-14b-latest",
          suggestions: ["ministral-8b-latest"],
          message: "Model not found: mistral/ministral-14b-latest. Did you mean: ministral-8b-latest?",
        },
      })
      const { FormatError } = yield* Effect.promise(() => import("../../src/cli/error"))
      expect(FormatError(body)).toBe(
        [
          "Model not found: mistral/ministral-14b-latest",
          "Did you mean: ministral-8b-latest",
          "Try: `lunos models` to list available models",
          "Or declare it in your config (opencode.json): provider.mistral.models",
        ].join("\n"),
      )
    }),
  )

  it.live("does not map storage not-found defects to 404", () =>
    Effect.gen(function* () {
      yield* HttpRouter.add(
        "GET",
        "/missing",
        Effect.die(new NotFoundError({ message: "Resource not found: secret" })),
      ).pipe(Layer.provide(errorLayer), HttpRouter.serve, Layer.build)

      const response = yield* HttpClientRequest.get("/missing").pipe(HttpClient.execute)
      const body = yield* response.json

      expect(response.status).toBe(500)
      expectUnknownErrorBody(body)
    }),
  )
})
