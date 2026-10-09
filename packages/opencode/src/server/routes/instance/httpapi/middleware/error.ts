import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Provider } from "@/provider/provider"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      if (
        ConfigErrorV1.JsonError.isInstance(error) ||
        ConfigErrorV1.InvalidError.isInstance(error) ||
        ConfigErrorV1.FrontmatterError.isInstance(error) ||
        ConfigErrorV1.DirectoryTypoError.isInstance(error) ||
        ConfigErrorV1.RemoteAuthError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }

      // XCOD-166: an unknown model is the caller's mistake, not a server error. As { name, data }, the
      // shape the CLI and TUI already format ("Model not found: …", suggestions, what to try).
      if (Provider.ModelNotFoundError.isInstance(error)) {
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {
              name: "ProviderModelNotFoundError",
              data: {
                providerID: error.providerID,
                modelID: error.modelID,
                suggestions: error.suggestions ?? [],
                message: error.message,
              },
            },
            { status: 400 },
          ),
        )
      }

      // XCOD-221: no provider set up is something the user fixes, so say how instead of a 500.
      if (Provider.NoProvidersError.isInstance(error)) {
        return Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { name: "ProviderNoProvidersError", data: { message: error.message } },
            { status: 400 },
          ),
        )
      }

      const ref = `err_${crypto.randomUUID().slice(0, 8)}`

      return Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            new NamedError.Unknown({
              message: "Unexpected server error. Check server logs for details.",
              ref,
            }).toObject(),
            { status: 500 },
          ),
        ),
      )
    }),
  ),
).layer
