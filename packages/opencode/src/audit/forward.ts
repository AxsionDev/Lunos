export * as AuditForward from "./forward"

import dgram from "dgram"
import os from "os"
import { Audit } from "@opencode-ai/core/audit"
import { AuditLog } from "./log"

// XCOD-103: optional forwarding of every audit line to the customer's SIEM, as syslog (RFC 5424
// over UDP) or OTLP logs (HTTP/JSON). Off unless configured. The destination is treated like any
// self-hosted endpoint for the residency policy: region "unknown", so an EU-only policy refuses
// it unless "unknown" is allowed. Loopback never leaves the machine and is always allowed.
// Forwarding never blocks or fails a session: sends are asynchronous, the OTLP queue is bounded,
// and failures are logged.

const MAX_QUEUE = 1000

export function loopback(host: string) {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase()
  return name === "localhost" || name === "::1" || name.startsWith("127.")
}

export function allowed(url: URL, residencyAllow: readonly string[] | undefined) {
  if (!residencyAllow) return true
  if (loopback(url.hostname)) return true
  return residencyAllow.includes("unknown")
}

export function syslogMessage(line: string, event: string, now = new Date()) {
  // PRI 110 = facility 13 (log audit) * 8 + severity 6 (informational).
  return `<110>1 ${now.toISOString()} ${os.hostname() || "-"} lunos ${process.pid} ${event} - ${line}`
}

export function otlpBody(lines: readonly string[]) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "lunos" } }] },
        scopeLogs: [
          {
            scope: { name: "lunos.audit" },
            logRecords: lines.map((line) => {
              const parsed = JSON.parse(line)
              return {
                timeUnixNano: String(Date.parse(parsed.timestamp) * 1_000_000),
                severityText: "INFO",
                body: { stringValue: line },
                attributes: [{ key: "event", value: { stringValue: String(parsed.event ?? "") } }],
              }
            }),
          },
        ],
      },
    ],
  }
}

function parse(target: string) {
  try {
    return new URL(target)
  } catch {
    return undefined
  }
}

let stop: (() => void) | undefined
// Settings are activated more than once per process (global config, then the project's); a
// refused destination is recorded once.
const refused = new Set<string>()

/** (Re)starts forwarding for the active settings. Called on every audit activation. */
export function start(settings: AuditLog.Settings) {
  stop?.()
  stop = undefined
  if (!settings.enabled || !settings.forward) return
  const cleanups: (() => void)[] = []

  const syslog = settings.forward.syslog ? parse(settings.forward.syslog) : undefined
  const otlp = settings.forward.otlp ? parse(settings.forward.otlp) : undefined
  for (const [kind, url] of [
    ["syslog", syslog],
    ["otlp", otlp],
  ] as const) {
    if (!url) continue
    if (!allowed(url, settings.residencyAllow) && !refused.has(url.href)) {
      refused.add(url.href)
      AuditLog.emit("audit.forward_refused", {
        via: kind,
        host: url.host,
        region: "unknown",
        allowed: false,
        reason: "forwarding destination denied by the residency policy",
      })
    }
  }

  if (syslog && allowed(syslog, settings.residencyAllow)) {
    const socket = dgram.createSocket(syslog.hostname.includes(":") ? "udp6" : "udp4")
    socket.unref()
    socket.on("error", (err) => console.error("[audit] syslog forwarding failed:", err.message))
    const port = Number(syslog.port) || 514
    const host = syslog.hostname.replace(/^\[|\]$/g, "")
    cleanups.push(
      Audit.onLine((line, event) => socket.send(syslogMessage(line, event), port, host)),
      () => socket.close(),
    )
  }

  if (otlp && allowed(otlp, settings.residencyAllow)) {
    const endpoint = otlp.pathname.endsWith("/v1/logs") ? otlp.href : new URL("/v1/logs", otlp).href
    let queue: string[] = []
    let sending = false
    const drain = async () => {
      if (sending || !queue.length) return
      sending = true
      const batch = queue
      queue = []
      await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(otlpBody(batch)),
      })
        .then((response) => {
          if (!response.ok) console.error(`[audit] OTLP forwarding failed: HTTP ${response.status}`)
        })
        .catch((err) => console.error("[audit] OTLP forwarding failed:", err?.message ?? err))
      sending = false
      if (queue.length) void drain()
    }
    cleanups.push(
      Audit.onLine((line) => {
        if (queue.length >= MAX_QUEUE) queue.shift()
        queue.push(line)
        void drain()
      }),
    )
  }

  stop = () => cleanups.forEach((cleanup) => cleanup())
}
