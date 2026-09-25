# The audit log

A local, append-only record of what Lunos did on a machine: which models it called, which tools it
ran, what it was allowed or refused, and what it installed. It is written for security and
compliance reviews after an incident or during an audit, using your own tools. Nothing is sent to
ITService EOOD.

## Turning it on

The log is on when either is true:

- a data-residency policy is set (`"residency": { "allow": [...] }`), whose audit defaults to on, or
- `"audit": { "enabled": true }` is set, with or without a residency policy.

With neither, no file is written.

```json
{
  "audit": {
    "enabled": true,
    "path": "/var/log/lunos/audit.log",
    "redact": ["/home/[^/]+"],
    "max_bytes": 10485760,
    "max_age_days": 90,
    "forward": { "syslog": "udp://siem.internal:514" }
  }
}
```

| Key            | Default                                                                       | Meaning                                                                                                     |
| -------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `enabled`      | `false`, or on when a residency policy audits                                 | Write the log                                                                                               |
| `path`         | `residency.auditPath`, else `residency-egress.log` in the Lunos log directory | Where the log lives. `audit.path` wins over `residency.auditPath`                                           |
| `redact`       | none                                                                          | Regular expressions masked as `[redacted]` in every recorded string, on top of the built-in secret patterns |
| `max_bytes`    | 10 MB                                                                         | Rotate the active file at this size; rotated files are `<path>.<timestamp>`                                 |
| `max_age_days` | 90                                                                            | Delete rotated files older than this                                                                        |
| `forward`      | none                                                                          | Also send every line to a SIEM (see [Forwarding](#forwarding-to-a-siem))                                    |

An organisation can force the log on and stop developers changing it by locking it in managed
config: `"$locked": ["audit"]` with `"audit": { "enabled": true, ... }` (see the
[deployment guide](deployment/self-hosted.md#organisation-policy-settings-developers-cant-change)).

## Format

One JSON object per line. Every line carries:

| Field       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `v`         | Schema version, currently `1`                                                 |
| `event`     | One of the events below                                                       |
| `timestamp` | ISO 8601, UTC                                                                 |
| `seq`       | 1, 2, 3, … across the whole stream, including rotated files                   |
| `prev`      | SHA-256 of the previous line's exact bytes (64 zeros for the very first line) |

### Events

| Event                            | Fields                                                                                                                 | When                                                                |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `model.call`                     | `providerID`, `region`, `basis`, `host`, `allowed: true`                                                               | Each outbound model request                                         |
| `model.denied`                   | same, `allowed: false`                                                                                                 | A model the residency policy refused, before any connection         |
| `share.upload` / `share.denied`  | same, with a `share:` provider id                                                                                      | A share upload allowed / refused by the residency policy            |
| `tool.run`                       | `tool`, `agent`, `session`, `command` (shell tools only), `paths`, `server` (MCP)                                      | Each tool the agent runs                                            |
| `permission.decision`            | `session`, `permission`, `patterns`, `decision`: `asked`, `denied by rule`, `denied`, `allowed once`, `allowed always` | Each permission check that wasn't silently allowed, and each answer |
| `mcp.connect`                    | `server`, `transport`, `host` (remote) or `command` (local), `allowed`, `reason`                                       | Each MCP server connection attempt                                  |
| `marketplace.install`            | `kind`, `name`, `marketplace`, `path` or `package`                                                                     | Each marketplace entry installed                                    |
| `marketplace.refused`            | `name` / `source`, `key`, `reason`                                                                                     | An install or marketplace add that was refused                      |
| `policy.override_refused`        | `key`, `via`                                                                                                           | An attempt to change a key the organisation policy locks            |
| `upgrade`                        | `method`, `from`, `version`, `allowed`                                                                                 | Each `lunos upgrade` attempt                                        |
| `audit.forward_refused`          | `via`, `host`, `region`, `allowed: false`, `reason`                                                                    | A forwarding destination the residency policy denies                |
| `memory.write` / `memory.forget` | reserved                                                                                                               | Not emitted yet: reserved for graph memory (XCOD-94)                |

### What is never recorded

Prompt text, model output, file contents, patches, tool output, request bodies, environment
variables and MCP headers.

### Fields that can hold user data

- `command`: the shell command line the agent ran.
- `paths`: file and directory paths the agent's tools touched.
- `patterns`: the permission patterns asked about, which are usually paths or command prefixes.
- `session`, `agent`: identifiers, not content.
- `host`, `server`, `name`, `source`, `package`: endpoints and package names.

Before anything is written, key-shaped strings in every field are replaced with `[redacted]`:
`Authorization:` values, `Bearer …` tokens, `…_KEY=` / `TOKEN=` / `password=` style assignments,
`--password` / `--token` arguments, and `sk-…`, `ghp_…`, `AKIA…` and `xox…` tokens. Add your own
patterns under `audit.redact`, for example `"/home/[^/]+"` to mask user names in paths.

### Compatibility with v0

Before schema v1, the residency log held model and share records only, with no `v`, `event`, `seq`
or `prev`. v1 keeps every v0 field with the same name and meaning, so tools that read
`providerID`, `host` and `allowed` keep working. An existing log is extended in place: the first
v1 line chains to the last v0 line.

## Verifying the log

```sh
lunos audit verify
```

Every line's `prev` must equal the SHA-256 of the line before it, across rotated files, oldest
first. `verify` prints the line count on success and exits non-zero naming the first bad line if a
line was **edited, removed or inserted in the middle** of the log.

**What this does and doesn't prove.** The chain is unkeyed and the log is a local file. It can't
detect the last lines being removed, or someone with write access recomputing every hash after an
edit. To make the record hold against a person who controls the machine, forward it to a SIEM
they can't write to: the SIEM's copy anchors the chain, and gaps in `seq` show lines that never
arrived.

## Exporting

```sh
lunos audit export --since 2026-09-01 --format jsonl   # one JSON object per line
lunos audit export --format csv > audit.csv            # opens in a spreadsheet
```

In CSV, a cell that would start with `=`, `+`, `-` or `@` is prefixed with `'` so spreadsheet apps
show it as text instead of running it as a formula (command lines often start with `-`).

## Forwarding to a SIEM

Forwarding is off unless configured. Every line is sent as written, in addition to the local file.

- **Syslog:** `"forward": { "syslog": "udp://siem.internal:514" }`. RFC 5424 over UDP, facility
  13 (log audit), severity informational, app name `lunos`, message ID the event name, and the
  JSON line as the message. Works with rsyslog, syslog-ng, Wazuh, Splunk and Elastic syslog inputs.
- **OTLP logs:** `"forward": { "otlp": "https://collector.internal:4318" }`. OTLP/HTTP JSON to
  `/v1/logs`, one log record per line with the line as the body and the event as an attribute.

Sending never blocks or fails a session: a sink that is down is reported on stderr and the local
file is still written. The destination is checked like any self-hosted endpoint: under a residency
policy it counts as `unknown`, so an EU-only policy refuses it unless `"unknown"` is allowed.
Loopback (`127.0.0.1`, `localhost`) never leaves the machine and is always allowed. A refused
destination is recorded as `audit.forward_refused`.

### Recipe: rsyslog to a file per host

```
module(load="imudp")
input(type="imudp" port="514")
template(name="LunosAudit" type="string" string="/var/log/lunos/%HOSTNAME%.log")
if $app-name == "lunos" then {
  action(type="omfile" dynaFile="LunosAudit" template="RSYSLOG_FileFormat")
  stop
}
```

Each received message ends with the original JSON line, so the per-host files can be checked with
the same hash chain.
