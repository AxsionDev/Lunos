import net from "node:net"

// XCOD-157: the sandbox's egress proxy and server relay, run as `lunos sandbox egress` in a separate
// container built from the trusted Lunos image (never `sandbox.image`, which a repository can choose).
//
// The sandbox container sits on an internal Docker network with no route out, so this is its only
// way out. It is also the only way in: an internal network can't publish ports, so the host reaches
// the sandbox server through the relay here.
//
// - Proxy (HTTP_PROXY / HTTPS_PROXY inside the sandbox): CONNECT for HTTPS, absolute-form requests
//   for plain HTTP. A destination not on the allow list gets 403. Once allowed, the connection is
//   piped as bytes to that one upstream, so a client reusing it can't reach another host.
// - Every decision, allowed or refused, is one JSON line on stdout. The host reads these with
//   `docker logs` and writes them to its audit trail: this record is outside the agent's reach,
//   unlike anything written inside the sandbox.

export const PROXY_PORT = 3128
export const RELAY_PORT = 4096
const MAX_HEADER = 64 * 1024

export type Decision = {
  seq: number
  time: string
  kind: "connect" | "http"
  host: string
  port: number
  allowed: boolean
}

/** Whether "host:port" is on the list; an entry ".example.com:443" matches any subdomain. */
export function allowed(list: readonly string[], host: string, port: number) {
  const name = host
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "")
  return list.some((item) => {
    const at = item.lastIndexOf(":")
    const [entryHost, entryPort] = [item.slice(0, at), Number(item.slice(at + 1))]
    if (entryPort !== port) return false
    return entryHost.startsWith(".") ? name.endsWith(entryHost) : name === entryHost
  })
}

/** The destination of a proxy request line, or undefined when it isn't one this proxy serves. */
export function target(
  line: string,
): { kind: Decision["kind"]; host: string; port: number; path?: string } | undefined {
  const [method, uri] = line.split(" ")
  if (!method || !uri) return undefined
  if (method === "CONNECT") {
    const at = uri.lastIndexOf(":")
    const port = Number(uri.slice(at + 1))
    if (at <= 0 || !Number.isInteger(port)) return undefined
    return { kind: "connect", host: uri.slice(0, at), port }
  }
  if (!uri.startsWith("http://")) return undefined
  try {
    const url = new URL(uri)
    return { kind: "http", host: url.hostname, port: Number(url.port || 80), path: url.pathname + url.search }
  } catch {
    return undefined
  }
}

function refuse(socket: net.Socket, status: string, text: string) {
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${text}\n`)
}

export function serve(input: {
  allow: readonly string[]
  /** The sandbox's sandbox.network, named in refusals. */
  mode?: string
  upstream: { host: string; port: number }
  log?: (decision: Decision) => void
  proxyPort?: number
  relayPort?: number
}) {
  const log = input.log ?? ((decision: Decision) => process.stdout.write(JSON.stringify(decision) + "\n"))
  let seq = 0

  const proxy = net.createServer((client) => {
    let head = Buffer.alloc(0)
    client.on("error", () => client.destroy())
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf("\r\n\r\n")
      if (end < 0) {
        if (head.length > MAX_HEADER) refuse(client, "431 Request Header Fields Too Large", "")
        return
      }
      client.off("data", onData)
      const lines = head.subarray(0, end).toString("latin1").split("\r\n")
      const rest = head.subarray(end + 4)
      const dest = target(lines[0])
      if (!dest)
        return refuse(client, "400 Bad Request", "The Lunos sandbox proxy only forwards CONNECT and http:// requests.")
      const ok = allowed(input.allow, dest.host, dest.port)
      log({
        seq: ++seq,
        time: new Date().toISOString(),
        kind: dest.kind,
        host: dest.host,
        port: dest.port,
        allowed: ok,
      })
      if (!ok)
        return refuse(
          client,
          "403 Forbidden",
          `Blocked by the Lunos sandbox network policy: ${dest.host}:${dest.port} is not allowed (sandbox.network "${input.mode ?? "policy"}").`,
        )
      const upstream = net.connect({ host: dest.host, port: dest.port })
      upstream.on("error", () => {
        if (!client.destroyed) refuse(client, "502 Bad Gateway", `Couldn't reach ${dest.host}:${dest.port}.`)
        upstream.destroy()
      })
      client.on("close", () => upstream.destroy())
      upstream.on("connect", () => {
        if (dest.kind === "connect") client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
        else {
          // Origin-form request line, and no proxy-only headers, for the upstream server.
          const headers = lines.slice(1).filter((line) => !/^proxy-(connection|authorization):/i.test(line))
          const [method, , version] = lines[0].split(" ")
          upstream.write([`${method} ${dest.path} ${version}`, ...headers, "", ""].join("\r\n"))
        }
        if (rest.length) upstream.write(rest)
        client.pipe(upstream)
        upstream.pipe(client)
      })
    }
    client.on("data", onData)
  })

  const relay = net.createServer((client) => {
    const upstream = net.connect(input.upstream)
    const close = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on("error", close)
    upstream.on("error", close)
    client.pipe(upstream)
    upstream.pipe(client)
  })

  proxy.listen(input.proxyPort ?? PROXY_PORT, "0.0.0.0")
  relay.listen(input.relayPort ?? RELAY_PORT, "0.0.0.0")
  return {
    proxy,
    relay,
    close: () => Promise.all([proxy, relay].map((server) => new Promise((done) => server.close(done)))),
  }
}

export * as SandboxEgress from "./egress"
