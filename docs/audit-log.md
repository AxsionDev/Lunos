# The audit log

A local, append-only record of what Lunos did on a machine: which models it called, which tools it
ran, what it was allowed or refused, and what it installed. It is written for security and
compliance reviews after an incident or during an audit, using your own tools. Nothing is sent to
ITService EOOD.

**Release status:** v1.18.39 and earlier record model calls and share uploads (the residency fields, see
[data residency](data-residency.md#the-audit-log)). Everything else on this page (the other
events, the hash chain, `lunos audit verify` and `export`, `"audit": { "enabled": true }` and SIEM
forwarding) is **from v1.18.40**.

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

| Key            | Default                                                                       | Meaning                                                                                                             |
| -------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `enabled`      | `false`, or on when a residency policy audits                                 | Write the log                                                                                                       |
| `path`         | `residency.auditPath`, else `residency-egress.log` in the Lunos log directory | Where the log lives. `audit.path` wins over `residency.auditPath`                                                   |
| `redact`       | none                                                                          | Regular expressions masked as `[redacted]` in every recorded string, on top of the built-in secret patterns         |
| `max_bytes`    | 10 MB                                                                         | Rotate the active file at this size; rotated files are `<path>.<timestamp>`                                         |
| `max_age_days` | 90                                                                            | Delete rotated files older than this                                                                                |
| `forward`      | none                                                                          | Also send every line to a SIEM; `region` declares where it processes data (see [Forwarding](#forwarding-to-a-siem)) |

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

| Event                           | Fields                                                                                                                                                                              | When                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.call`                    | `providerID`, `region`, `basis`, `host`, `allowed: true`                                                                                                                            | Each outbound model request                                                                                                                                                                                   |
| `model.denied`                  | same, `allowed: false`                                                                                                                                                              | A model the residency policy refused, before any connection                                                                                                                                                   |
| `share.upload` / `share.denied` | same, with a `share:` provider id                                                                                                                                                   | A share upload allowed / refused by the residency policy                                                                                                                                                      |
| `tool.run`                      | `tool`, `agent`, `session`, `command` (shell tools only), `paths`, `server` (MCP)                                                                                                   | Each tool the agent runs                                                                                                                                                                                      |
| `permission.decision`           | `session`, `permission`, `patterns`, `decision`: `asked`, `denied by rule`, `denied`, `allowed once`, `allowed always`                                                              | Each permission check that wasn't silently allowed, and each answer                                                                                                                                           |
| `mcp.connect`                   | `server`, `transport`, `host` (remote) or `command` (local), `allowed`, `reason`                                                                                                    | Each MCP server connection attempt                                                                                                                                                                            |
| `marketplace.install`           | `kind`, `name`, `marketplace`, `path` or `package`                                                                                                                                  | Each marketplace entry installed                                                                                                                                                                              |
| `marketplace.refused`           | `name` / `source`, `key`, `reason`                                                                                                                                                  | An install or marketplace add that was refused                                                                                                                                                                |
| `policy.override_refused`       | `key`, `via`                                                                                                                                                                        | An attempt to change a key the organisation policy locks                                                                                                                                                      |
| `upgrade`                       | `method`, `from`, `version`, `allowed`                                                                                                                                              | Each `lunos update` (or `upgrade`) attempt                                                                                                                                                                    |
| `audit.forward_refused`         | `via`, `host`, `region`, `allowed: false`, `reason`                                                                                                                                 | A forwarding destination the residency policy denies                                                                                                                                                          |
| `memory.remember`               | `session`, `agent`, `scope`, `id`, `source`, `kind`, `chars`, `expires`, `replaces`                                                                                                 | A fact saved to long-term memory. Was `memory.write` before XCOD-136: update SIEM rules that match it                                                                                                         |
| `memory.recall`                 | `session`, `source` (`turn`, `tool`, `cli`, `tui`), `scopes`, `count`, `ids`, `history`                                                                                             | Memory recalled into a turn or searched. The ids of the facts returned; never the query                                                                                                                       |
| `memory.forget`                 | `scope`, `id`, `session`, `source`                                                                                                                                                  | A fact removed                                                                                                                                                                                                |
| `memory.outdate`                | `scope`, `id`, `by`, `session`, `source`                                                                                                                                            | A fact marked outdated, and the id of the fact that replaced it                                                                                                                                               |
| `memory.purge`                  | `scope`, `count`, `reason` (`command` or `expired`), `ids` (expired), `source`                                                                                                      | `lunos memory purge`, or expired facts deleted after the grace period                                                                                                                                         |
| `memory.verify_failed`          | `scope`, `source`, `count`, `ids`, `lines`, or `reason` (`key`, `unreadable`)                                                                                                       | Ledger lines that failed the integrity check (quarantined): at memory start and on `lunos memory verify`, once per distinct finding per process; or a ledger that couldn't be read                            |
| `memory.export`                 | `scopes`, `facts`, `format`, `zip`, `encrypted`, `index`, `graph`, `quarantined`                                                                                                    | A memory bundle written by `lunos memory export`. Never the content, the path or the passphrase                                                                                                               |
| `memory.import`                 | `kind`, `sha256`, `encrypted`, `facts`, `notes`, `note_paragraphs`, `new`, `duplicate`, `conflict`, `rejected`, `failed`, `scopes`                                                  | An approved `lunos memory import`, including one that wrote nothing: what it found and wrote, and the SHA-256 of what it read. Never the text, the path or the passphrase                                     |
| `memory.denied`                 | `setting` (`memory.backend`), `host`, `jurisdiction`, `region`, `reason`                                                                                                            | An external memory database refused by the residency policy before any connection (XCOD-134). Never credentials                                                                                               |
| `memory.source_query`           | `session`, `name`, `type` (`graph`, `mcp`), `host`, `status` (`ok`, `timeout`, `error`), `latency_ms`, `count`, `withheld`                                                          | One query to an external memory source (XCOD-135): how many results it added and how many the screens withheld. `host` is the graph's host or `mcp:<server>`. Never the query or a result                     |
| `memory.source_denied`          | `name`, `type`, `host`, `jurisdiction`, `region`, `reason`                                                                                                                          | An external memory source refused before it was contacted: no jurisdiction, or one the residency policy doesn't allow. Once per source per process                                                            |
| `sandbox.create`                | `id`, `project`, `image`, `digest`, `cpus`, `memory`, `pids`, `tmp`, `on_finish`                                                                                                    | A sandbox created, before it starts (XCOD-157). Written by the host                                                                                                                                           |
| `sandbox.attach`                | same as `sandbox.create`, without `on_finish`                                                                                                                                       | `lunos sandbox attach` restarted a kept sandbox                                                                                                                                                               |
| `sandbox.finish`                | same, plus `outcome` (`succeeded`, `failed`), `commit`, `files` (a count), `on_finish`                                                                                              | The results were handed back, before the lifecycle policy applies. Never file names or contents                                                                                                               |
| `sandbox.retain`                | same, plus `reason` (`on_finish`, `handoff failed`, `start failed`, `interrupted`, `stopped`), `expires`                                                                            | A sandbox stopped and kept                                                                                                                                                                                    |
| `sandbox.destroy`               | same, plus `reason` (`on_finish`, `requested`)                                                                                                                                      | A sandbox's container and volumes removed                                                                                                                                                                     |
| `sandbox.prune`                 | same, plus `expires`                                                                                                                                                                | A kept sandbox removed because its `retain_for` expired                                                                                                                                                       |
| `sandbox.refused`               | `what` (a command, `--no-sandbox`, or `tool`), `tool`, `session`, `reason` (`sandbox.required`), `by` (`managed`, `config`)                                                         | `sandbox.required` refused something on the machine: a command that would run a server, `--no-sandbox`, or an agent tool call outside a sandbox                                                               |
| `sandbox.egress`                | `id`, `kind` (`connect` for HTTPS, `http`), `host`, `port`, `allowed`, `network`                                                                                                    | One connection a sandbox's egress proxy allowed or refused (network `policy` or `none`). Written by the host from the proxy's own log; once per connection, not per request. Never a path, a header or a body |
| `agent.run`                     | `agent`, `job`, `status` (`ok`, `stopped`, `failed`), `reason` (`completed`, `failed`, `time`, `cost`, `steps`), `steps`, `cost`, `seconds`, `denied` (permission names), `sandbox` | An unattended agent run (`lunos agent run`, scheduled or not) finished. Never the prompt, the output or file contents                                                                                         |

### What is never recorded

Prompt text, model output, file contents, patches, tool output, request bodies, environment
variables and MCP headers.

### Fields that can hold user data

- `command`: the shell command line the agent ran.
- `paths`: file and directory paths the agent's tools touched.
- `patterns`: the permission patterns asked about, which are usually paths or command prefixes. For
  `memory`, the pattern is the scope (`project` or `user`), never the fact (from XCOD-136; before,
  it was the fact's text).
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
destination is recorded as `audit.forward_refused`, with the region it was checked as.

**Declaring the destination's region** (XCOD-201, unreleased). To forward off the machine under an
EU-only policy without allowing `"unknown"` (which would also allow model providers in unknown
regions), declare where the destinations process data:

```json
"audit": { "forward": { "syslog": "udp://logs.internal.example:514", "region": "eu" } }
```

`region` is `eu`, `us` or `other`, and covers both `syslog` and `otlp`. A declared region is checked
against `residency.allow` instead of `unknown`, so `"region": "us"` is refused under an EU-only policy
even when `"unknown"` is allowed. Lunos can't verify the declaration. Set it in managed config and
lock it with `"$locked": ["audit.forward"]` (or `"audit"`): then user and project config can't add
or change it, and the policy's destinations are the only ones used. Without a lock, `region` is
whatever the user's own config says.

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
