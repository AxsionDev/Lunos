// XCOD-119: the metering proxy. Task containers talk to this, never to a provider: it holds the
// API keys, forwards to the real endpoint, meters every request with the harness's own prices,
// and refuses a request whose worst case would pass a cap *before* sending it. Its log of
// upstream hosts is the evidence for where evaluation traffic went (Lunos's audit log sees only
// the proxy's address).
//
// Speaks the OpenAI-compatible chat API (Mistral, Scaleway, OVHcloud, vLLM, OpenAI).

import { BudgetExceeded, type Ledger } from "./budget"
import { cost, worstCase, type ApiPrice, type Usage } from "./prices"

export type Route = {
  /** Path segment the container uses: http://proxy/<id>/v1/chat/completions */
  id: string
  model: string
  cls: string
  /** e.g. https://api.mistral.ai/v1 */
  upstream: string
  apiKey: string
  price: ApiPrice
}

/** OpenAI-style usage from a JSON body or the last usage-bearing SSE chunk. */
export function usageOf(value: unknown): Usage | undefined {
  const usage = (value as { usage?: Record<string, unknown> } | null)?.usage
  if (!usage || typeof usage.prompt_tokens !== "number" || typeof usage.completion_tokens !== "number") return
  const details = usage.prompt_tokens_details as { cached_tokens?: number } | undefined
  return { input: usage.prompt_tokens, output: usage.completion_tokens, cacheRead: details?.cached_tokens ?? 0 }
}

export function usageFromSse(text: string): Usage | undefined {
  let found: Usage | undefined
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    try {
      found = usageOf(JSON.parse(data)) ?? found
    } catch {}
  }
  return found
}

function refusal(message: string) {
  return Response.json(
    { error: { message, type: "eval_budget_exceeded", code: "eval_budget_exceeded" } },
    { status: 402 },
  )
}

export function startProxy(input: { routes: Route[]; ledger: Ledger; port?: number; hostname?: string }) {
  const routes = new Map(input.routes.map((route) => [route.id, route]))
  return Bun.serve({
    hostname: input.hostname ?? "127.0.0.1",
    port: input.port ?? 0,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url)
      const [, id, ...rest] = url.pathname.split("/")
      const route = routes.get(id)
      if (!route) return new Response(`eval proxy: unknown route "${id}"`, { status: 404 })
      const target = `${route.upstream.replace(/\/+$/, "")}/${rest.join("/").replace(/^v1\/?/, "")}${url.search}`
      const upstreamHost = new URL(target).host
      const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${route.apiKey}` })

      if (request.method !== "POST") return fetch(target, { method: request.method, headers })

      const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined
      if (!body) return new Response("eval proxy: request body must be JSON", { status: 400 })
      // Metering needs the usage chunk at the end of a stream.
      if (body.stream) body.stream_options = { ...(body.stream_options as object), include_usage: true }
      const text = JSON.stringify(body)
      const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens) || undefined
      const needed = worstCase(route.price, Buffer.byteLength(text), maxTokens)

      let settle: ReturnType<Ledger["reserve"]>
      try {
        settle = input.ledger.reserve(route.cls, needed)
      } catch (error) {
        if (!(error instanceof BudgetExceeded)) throw error
        input.ledger.refuse(route.model, route.cls, upstreamHost, needed)
        return refusal(error.message)
      }
      const done = (usage: Usage | undefined) =>
        settle({
          model: route.model,
          upstream: upstreamHost,
          usage,
          cost: usage ? cost(route.price, usage) : needed,
          status: usage ? "settled" : "failed",
        })

      const response = await fetch(target, { method: "POST", headers, body: text }).catch((error) => {
        done(undefined)
        throw error
      })
      if (!response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const raw = await response.text()
        let usage: Usage | undefined
        try {
          usage = usageOf(JSON.parse(raw))
        } catch {}
        done(usage)
        return new Response(raw, { status: response.status, headers: { "content-type": "application/json" } })
      }

      // Stream through unchanged while keeping a copy to read the usage chunk. Settles on end, error
      // or client disconnect alike; a stream cut short with no usage chunk is charged its reservation.
      const decoder = new TextDecoder()
      const reader = response.body.getReader()
      let seen = ""
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await reader.read().catch((error) => {
            done(usageFromSse(seen))
            throw error
          })
          if (next.done) {
            done(usageFromSse(seen))
            controller.close()
            return
          }
          seen += decoder.decode(next.value, { stream: true })
          controller.enqueue(next.value)
        },
        async cancel(reason) {
          done(usageFromSse(seen))
          await reader.cancel(reason)
        },
      })
      return new Response(stream, { status: response.status, headers: { "content-type": "text/event-stream" } })
    },
  })
}
