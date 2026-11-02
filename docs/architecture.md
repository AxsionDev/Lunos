# Lunos Architecture

Lunos is a fork of [opencode](https://github.com/anomalyco/opencode). It is a Bun/TypeScript monorepo (Turbo workspaces, Effect 4, SolidJS) that ships one CLI/TUI binary plus a desktop app. Most packages keep upstream's `@opencode-ai/*` names to keep the merge surface with upstream small. See [Review findings](#review-findings).

> Snapshot of `dev` at `8bad12241f` (2026-10-02). Every arrow below was traced to the file cited next to it. Claims that come from project notes and were not re-verified in code are marked _(from notes)_.

## 1. Runtime view: what runs where

```mermaid
flowchart LR
  subgraph surfaces["Client surfaces"]
    tui["TUI<br/>(opentui + Solid)"]
    run["lunos run<br/>(headless)"]
    acp["ACP<br/>(editor agents)"]
    webui["Web app<br/>packages/app"]
    desk["Desktop<br/>(Electron)"]
  end

  subgraph proc["lunos process (packages/opencode)"]
    worker["TUI Worker thread<br/>cli/tui/worker.ts"]
    http["HTTP server<br/>Effect HttpApi + SSE /event<br/>server/server.ts"]
    sess["Session engine<br/>session/prompt.ts · processor.ts"]
    tools["Tool registry<br/>tool/registry.ts"]
    perm["Permission + plugins<br/>tool hooks"]
    llmrt["LLM seam<br/>session/llm.ts"]
    bus["Bus → event stream"]
  end

  subgraph ext["Side processes / external"]
    db[("SQLite<br/>drizzle via core/database")]
    mcp["MCP servers"]
    lsp["LSP servers"]
    sbx["Sandbox<br/>Docker / Podman"]
    mem["Memory sidecar<br/>(Python)"]
    prov["Model providers<br/>Anthropic, OpenAI, Bedrock,<br/>Gemini, Ollama, ..."]
  end

  tui -- "RPC-fetch<br/>(in-process)" --> worker --> http
  tui -. "attach &lt;url&gt;" .-> http
  run -- "in-process app.fetch" --> http
  acp -- "Server.listen + SDK" --> http
  webui -- "HTTP + SSE<br/>(lunos web / serve)" --> http
  http -. "UI fallback proxy<br/>if UI not embedded" .-> upui["app.opencode.ai<br/>(upstream)"]
  desk -- "utilityProcess.fork<br/>sidecar.js = opencode node build" --> http

  http --> sess
  sess --> llmrt
  sess --> tools
  tools --> perm
  tools --> mcp & lsp & sbx & mem
  llmrt -- "default: AI SDK streamText" --> prov
  llmrt -. "opt-in: @opencode-ai/llm native<br/>OPENCODE_EXPERIMENTAL_NATIVE_LLM" .-> prov
  sess --> db
  sess --> bus -- "SSE" --> http
```

Key facts behind the diagram:

| Edge                        | Evidence                                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TUI ↔ server in a Worker   | `packages/opencode/src/cli/cmd/tui.ts:26,282` creates a `Worker` and a `fetch` that tunnels over RPC                                                                                                                                                        |
| Server is Effect `HttpApi`  | `packages/opencode/src/server/server.ts:6-13`. Routes live in `server/routes/instance/httpapi/handlers/*`                                                                                                                                                   |
| Events are SSE              | `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:9` (`effect/unstable/encoding/Sse`)                                                                                                                                                 |
| LLM default vs native       | `packages/opencode/src/session/llm.ts:224-277`, flag in `src/effect/runtime-flags.ts:58`                                                                                                                                                                    |
| Desktop sidecar             | `packages/desktop/src/main/index.ts:68` defaults to `v1`. `server.ts` forks `sidecar.js`, which imports `virtual:opencode-server` and resolves to `packages/opencode` `dist/node.js` (`electron.vite.config.ts:71`)                                         |
| Desktop v2 sidecar (opt-in) | `OPENCODE_SIDECAR_V2=1` runs `opencode-cli service start` (`desktop/src/main/background-cli.ts:44`). That binary is downloaded from npm `@opencode-ai/cli-*@0.0.0-next-16350` (`desktop/scripts/utils.ts:6,77`), which is published by upstream maintainers |
| `run` / ACP use the server  | `cli/cmd/run.ts:975` calls `Server.Default().app.fetch` in-process. `cli/cmd/acp.ts:25-27` runs `Server.listen` and then `createOpencodeClient`                                                                                                             |
| Web UI source               | The release build embeds `packages/app` as `opencode-web-ui.gen.ts` (`script/build.ts:55,207`). Without it, `server/shared/ui.ts:9,85` proxies to `https://app.opencode.ai`                                                                                 |
| Storage                     | `packages/core/src/database/database.ts:3` (`@opencode-ai/effect-drizzle-sqlite`)                                                                                                                                                                           |

## 2. Package layers (shipped product)

Edges are transitively reduced. If A→B→C, the A→C edge is omitted. Dashed edges are runtime or build links, not `package.json` dependencies.

```mermaid
flowchart BT
  subgraph foundation["Foundation: contracts and primitives"]
    schema["@opencode-ai/schema"]
    protocol["@opencode-ai/protocol<br/>(HttpApi contract)"]
    sdk["@opencode-ai/sdk<br/>(generated from openapi.json)"]
    hrec["@opencode-ai/http-recorder"]
    sqlite["effect-drizzle-sqlite<br/>effect-sqlite-node"]
    codegen["@opencode-ai/httpapi-codegen"]
  end

  subgraph engine["Engine"]
    llm["@opencode-ai/llm<br/>(native provider protocols)"]
    plugin["@opencode-ai/plugin<br/>(plugin API)"]
    core["@opencode-ai/core<br/>v1/* + v2 namespaces<br/>config, session, provider, residency, ..."]
    server["@opencode-ai/server<br/>(v2 HttpApi handlers)"]
    client["@opencode-ai/client<br/>(Promise + Effect client)"]
    codemode["@opencode-ai/codemode"]
  end

  subgraph ui["UI libraries"]
    uilib["@opencode-ai/ui"]
    tuilib["@opencode-ai/tui"]
    sessui["@opencode-ai/session-ui"]
  end

  subgraph apps["Shipped apps"]
    opencode["opencode<br/>(the lunos binary)"]
    app["@opencode-ai/app<br/>(web UI)"]
    desktop["@opencode-ai/desktop<br/>(Electron)"]
  end

  subgraph v2only["v2 track: not on the release path"]
    cli["@opencode-ai/cli<br/>(bin: lunos)"]
    sdknext["@opencode-ai/sdk-next"]
  end

  protocol --> schema
  llm --> schema & hrec
  plugin --> sdk
  core --> llm & plugin & sqlite
  server --> core & protocol
  client --> server & codegen
  tuilib --> core & uilib
  sessui --> client & uilib
  opencode --> server & tuilib & codemode
  app --> sessui
  desktop --> app
  desktop -. "forks node build" .-> opencode
  cli --> server & tuilib
  sdknext --> client
```

Peripheral packages not shown: `web` (Astro/Starlight docs site; `opencode` dependency), `slack` (bot on `sdk`), `storybook` (on `session-ui`), `enterprise` (on `core` + `session-ui`), `function`, `eval` (`@lunos/eval`), and `script`.

### Upstream cloud (inherited, SST/AWS + Cloudflare)

```mermaid
flowchart BT
  cmail["console-mail"]
  cres["console-resource"]
  ccore["console-core"] --> cmail & cres
  capp["console-app"] --> ccore
  cfn["console-function"] --> ccore
  csup["console-support"] --> ccore
  score["stats-core"]
  sapp["stats-app"] --> score
  ssrv["stats-server"] --> score
  sst["sst.config.ts + infra/*"] -. deploys .-> capp & cfn & sapp & ssrv
```

All recent commits under `infra/` and `sst.config.ts` are upstream merges, such as `#48309`. The repo has no evidence that Lunos deploys these.

## 3. Request flow: prompt → tool call → permission → UI

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant T as TUI
  participant W as Worker (HttpApi)
  participant S as Session engine
  participant L as LLM seam
  participant P as Provider
  participant R as Tool registry
  participant DB as SQLite

  U->>T: types prompt
  T->>W: POST session prompt (RPC-fetch)
  W->>S: SessionPrompt
  S->>DB: persist user message
  S->>L: stream(messages, tools, system context)
  L->>P: AI SDK streamText (or native, if flag set)
  P-->>L: text / reasoning / tool-call deltas
  L-->>S: normalized LLMEvents
  S-->>T: SSE message.part.updated
  S->>R: execute tool call
  R->>R: plugin tool hooks (before)
  alt permission = ask
    R-->>T: SSE permission.asked
    U->>T: approve / deny
    T->>W: POST permission reply
    W->>R: resume
  end
  R->>R: run tool (optionally in sandbox)
  R-->>S: bounded Model Tool Output
  S->>DB: persist parts
  S->>L: next provider turn (until no continuation)
  S-->>T: SSE session.idle
```

## 4. Where the Lunos additions live

Lunos-authored features are mostly additive directories on the **v1** path in `packages/opencode/src`, plus a few `core` modules. Each row's first commit is an XCOD ticket (`git log --diff-filter=A`):

| Feature                                 | Location                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sandboxed runs (Docker/Podman, egress)  | `opencode/src/sandbox/` · docs: `docs/sandboxed-runs.md`                                  |
| Memory (Python sidecar, recall/notes)   | `opencode/src/memory/`                                                                    |
| Audit log + forwarding                  | `opencode/src/audit/` · `core/src/audit.ts` · docs: `docs/audit-log.md`                   |
| Marketplace (install/review/guard)      | `opencode/src/marketplace/` · `core/src/marketplace.ts` · root `marketplace/`             |
| Data residency / jurisdiction / offline | `core/src/residency.ts`, `jurisdiction.ts`, `offline.ts` · docs: `docs/data-residency.md` |
| Config policy                           | `opencode/src/config/policy.ts` (loaded first in `src/index.ts:4`)                        |
| Dev-cycle mode                          | `opencode/src/session/dev-cycle.ts`                                                       |

## Review findings

Severity is about architectural risk, not code quality. "Trade-off" marks things that look deliberate.

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Evidence                                                                                                                              |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **High** | **The root `CLAUDE.md` is half wrong.** Its agent-fleet sections match `.claude/` (39 agents, 7 skills). Its "Repository Purpose" and "Technology Stack" sections describe a .NET/Angular/SQL Server project. Every Claude session loads it first and gets the wrong stack and commands. `AGENTS.md` and `CONTEXT.md` are accurate.                                                                                                                                                                              | `CLAUDE.md` "Repository Purpose" / "Technology Stack" vs `package.json`                                                               |
| 2   | **High** | **Two runtimes coexist, and only v1 is live.** The binary's session/provider path is v1 (`packages/opencode` + `core/v1/*`), even though its HTTP layer already uses the v2 `HttpApi` and `@opencode-ai/server`. Features built only against v2 session/hook APIs can ship without ever executing. This happened with residency hooks _(from notes: XCOD-93)_. The split runs **through** `core`, not between packages.                                                                                          | `session/llm.ts:3-5` imports `core/v1/permission`, `@/provider/provider`, `core/v1/session`. `opencode` imports `core/v1/session` 29× |
| 3   | **High** | **Lunos features sit on the path upstream is migrating away from.** Upstream is building v2 (`core` session, `cli`, `sdk-next`, desktop "v2 sidecar"). When upstream retires v1, sandbox, memory, audit, marketplace and policy will all need porting at once. This is an inference from the code layout, not a dated upstream plan. Treat it as a planning risk.                                                                                                                                                | §4 table; `desktop/src/main/index.ts:68,339`                                                                                          |
| 4   | Medium   | **Two LLM runtimes.** AI SDK `streamText` is the default. The `@opencode-ai/llm` native runtime is opt-in and silently falls back. Provider fixes may need to be made twice, and behaviour differs by flag.                                                                                                                                                                                                                                                                                                      | `session/llm.ts:224-267`, `runtime-flags.ts:58`                                                                                       |
| 5   | Medium   | **The desktop v2 sidecar runs upstream's binary, not Lunos.** `predev` and the dev-channel `prebuild` download `@opencode-ai/cli-*@0.0.0-next-16350` from npm. npm lists the maintainers as upstream's `thdxr` and `adamelmore`. Dev-channel installers then **ship** that binary via `extraResources`, and `OPENCODE_SIDECAR_V2=1` runs it. That build has none of the Lunos controls (sandbox, residency, audit, policy). It is off by default, and it is a third-party binary pinned by version, not by hash. | `desktop/scripts/utils.ts:6,72-80`, `prebuild.ts:11`, `predev.ts:9`, `electron-builder.config.ts:53-61`                               |
| 6   | Medium   | **Large inherited surface Lunos doesn't operate.** `console/*`, `stats/*`, `enterprise`, `infra/` and `sst.config.ts` are about 370 TS files that still cost typecheck, CI and merge-conflict time. _Trade-off:_ deleting them would increase conflicts on every upstream merge _(from notes: merge, never rebase)_.                                                                                                                                                                                             | `infra/` git log contains only upstream commits                                                                                       |
| 7   | Medium   | **Probable bug (unconfirmed): offline mode disables the _local_ web UI.** `disableEmbeddedWebUi` is `orOffline(...)`, so `LUNOS_OFFLINE=1` makes `embeddedUI()` return `null`. `serveUIEffect` then falls through to the `app.opencode.ai` proxy, which has no offline check of its own. The result is either a broken `lunos web` offline or an outbound call the egress catalogue says is blocked. Confirm with a release binary: `LUNOS_OFFLINE=1 lunos serve`, then request `/` and watch egress.            | `effect/runtime-flags.ts:24`, `server/shared/ui.ts:44-45,83-90`, `core/src/offline.ts:120-126`                                        |
| 8   | Low      | **Mixed naming.** The workspace is `@opencode-ai/*`, the package is `opencode` with bin `opencode`, while `@opencode-ai/cli` has bin `lunos`, and `CONTEXT.md` says "OpenCode". _Trade-off:_ keeping upstream names minimizes the merge surface. A short naming note in `AGENTS.md` would stop agents from "fixing" it.                                                                                                                                                                                          | `packages/opencode/package.json`, `packages/cli/package.json`                                                                         |

**Strengths worth preserving**

- **Contract-first API.** `protocol` defines the `HttpApi`. `openapi.json` → `sdk`, and `httpapi-codegen` → `client`, are generated from it, so UIs track the server whenever `generate` runs.
- **Same API in-process and remote.** The TUI uses the same HTTP surface through a Worker that `attach`, web and desktop use over the network. One code path covers both local and remote use.
- **Clean foundation layer.** `schema` has no internal dependencies and everything flows upward. There are no cycles among the shipped packages.
- **Effect layers throughout.** This explains why runtime env injection must also set `Flag` fields _(from notes)_. It is worth documenting near `core/src/flag`.

## Suggested next steps

1. Rewrite the "Repository Purpose" and "Technology Stack" sections of `CLAUDE.md` to point at `AGENTS.md` and this document. Keep the agent-fleet sections. This is the cheapest and highest-value fix.
2. Add a "live-path check" to the PR template: does this change run on v1 `packages/opencode/src/session`? Prove it with a real run.
3. Track the v1→v2 porting debt per Lunos feature (finding 3) as an epic, so upstream's eventual v1 removal doesn't arrive as a surprise.
