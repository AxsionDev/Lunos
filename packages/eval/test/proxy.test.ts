import { afterAll, describe, expect, test } from "bun:test"
import { Ledger } from "../src/budget"
import type { ApiPrice } from "../src/prices"
import { startProxy, usageFromSse } from "../src/proxy"

const price: ApiPrice = {
  kind: "api",
  input: 2,
  output: 6,
  maxOutputTokens: 1000,
  source: "test",
  checked: "2026-09-27",
}
const seen: { auth: string | null; body: any }[] = []

// Upstream stand-in: streams a reply with a usage chunk, like OpenAI-compatible providers.
const upstream = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = (await request.json()) as any
    seen.push({ auth: request.headers.get("authorization"), body })
    const chunk = (p: object) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", ...p })}\n\n`
    if (!body.stream)
      return Response.json({
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      })
    const parts = [
      chunk({ choices: [{ index: 0, delta: { content: "ok" } }] }),
      chunk({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } }),
      "data: [DONE]\n\n",
    ]
    return new Response(parts.join(""), { headers: { "content-type": "text/event-stream" } })
  },
})
afterAll(() => upstream.stop(true))

function setup(caps = { total: 1, classes: { eu: 1 } }) {
  const ledger = new Ledger(caps)
  const proxy = startProxy({
    ledger,
    token: "t0k",
    routes: [
      {
        id: "mistral",
        model: "mistral/test",
        cls: "eu",
        upstream: `http://127.0.0.1:${upstream.port}/v1`,
        apiKey: "sk-real",
        price,
      },
    ],
  })
  const post = (body: object) =>
    fetch(`http://127.0.0.1:${proxy.port}/t0k/mistral/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer dummy" },
      body: JSON.stringify(body),
    })
  return { ledger, proxy, post }
}

describe("metering proxy", () => {
  test("meters a streamed reply from its usage chunk, with the harness's price", async () => {
    const { ledger, proxy, post } = setup()
    const response = await post({
      model: "test",
      stream: true,
      max_tokens: 500,
      messages: [{ role: "user", content: "hi" }],
    })
    expect(await response.text()).toContain('"content":"ok"')
    expect(ledger.spentTotal()).toBeCloseTo((1000 * 2 + 200 * 6) / 1e6)
    expect(ledger.entries[0]).toMatchObject({ status: "settled", upstream: `127.0.0.1:${upstream.port}` })
    proxy.stop(true)
  })

  test("holds the key: the container's key is replaced, and usage reporting is forced on", async () => {
    const { proxy, post } = setup()
    await (await post({ model: "test", stream: true, messages: [] })).text()
    const last = seen.at(-1)!
    expect(last.auth).toBe("Bearer sk-real")
    expect(last.body.stream_options).toEqual({ include_usage: true })
    proxy.stop(true)
  })

  test("refuses a request whose worst case would pass the cap, before sending it", async () => {
    const { ledger, proxy, post } = setup({ total: 0.001, classes: { eu: 0.001 } })
    const before = seen.length
    const response = await post({ model: "test", stream: true, max_tokens: 1000, messages: [] })
    expect(response.status).toBe(402)
    expect(((await response.json()) as any).error.type).toBe("eval_budget_exceeded")
    expect(seen.length).toBe(before)
    expect(ledger.spentTotal()).toBe(0)
    expect(ledger.entries[0].status).toBe("refused")
    proxy.stop(true)
  })

  test("spend never passes the cap, however many requests are made", async () => {
    const { ledger, proxy, post } = setup({ total: 0.05, classes: { eu: 0.05 } })
    const statuses: number[] = []
    for (let i = 0; i < 40; i++) {
      const response = await post({ model: "test", stream: true, max_tokens: 1000, messages: [] })
      statuses.push(response.status)
      await response.text()
    }
    expect(statuses).toContain(402)
    expect(ledger.spentTotal()).toBeLessThanOrEqual(0.05)
    proxy.stop(true)
  })

  test("a client that disconnects mid-stream still settles its reservation", async () => {
    const { ledger, proxy, post } = setup()
    const response = await post({ model: "test", stream: true, messages: [] })
    await response.body!.cancel()
    await Bun.sleep(50)
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.spentTotal()).toBeGreaterThan(0)
    proxy.stop(true)
  })

  test("a request without the run's token is rejected and costs nothing", async () => {
    const { ledger, proxy } = setup()
    const response = await fetch(`http://127.0.0.1:${proxy.port}/wrong/mistral/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "test", messages: [] }),
    })
    expect(response.status).toBe(404)
    expect(ledger.entries).toHaveLength(0)
    proxy.stop(true)
  })

  test("reads usage from the last usage-bearing SSE chunk", () => {
    expect(usageFromSse('data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n')).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
    })
  })
})
