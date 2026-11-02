# The Lunos IDE protocol

How the Lunos IDE plugins talk to Lunos (XCOD-333). The plugins are the JetBrains plugin
(`sdks/jetbrains`) and the Visual Studio extension (`sdks/visualstudio`). The protocol is the local
Lunos server's own HTTP API, the one the TUI uses. It isn't a separate API. That is why a session
started in an IDE is the same session the TUI shows in `/sessions`, and why approvals can be answered
in either place.

The VS Code extension (`sdks/vscode`) still uses `/tui/append-prompt`. Moving it onto this protocol is
a later story.

## Starting

The plugin starts one server per project or solution:

```
lunos serve --hostname 127.0.0.1 --port <free port>
```

- **Working directory:** the project root in JetBrains, or the solution or open-folder directory in
  Visual Studio. Lunos loads the project's and the organisation's managed config from there, so
  locks and policy apply exactly as in the TUI.
- **Environment:**
  - `OPENCODE_SERVER_PASSWORD` is a fresh random 48-hex-character password.
  - `OPENCODE_CALLER` is `jetbrains` or `visualstudio`.
- **Ready:** the server is up when it prints `opencode server listening on http://127.0.0.1:<port>`.

To use a server that is already running instead, set `LUNOS_SERVER_URL`, and set
`LUNOS_SERVER_PASSWORD` (or `OPENCODE_SERVER_PASSWORD`) to its password.

Every request carries two headers:

- `Authorization: Basic base64("opencode:" + password)`. Without it the server answers `401`.
- `x-opencode-directory: <project root>`. This header selects the project instance, which decides
  which sessions are listed and where tools run.

## Calls

| What                                  | Call                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Health                                | `GET /global/health` returns `{ healthy, version }`                                                                                    |
| List sessions (the TUI's `/sessions`) | `GET /session` returns `Session[]`. Top-level sessions have no `parentID`.                                                             |
| Start a session                       | `POST /session` with `{ title?, parentID? }`                                                                                           |
| Attach to a session                   | Use its id in the calls below. `GET /session/:id/message` returns the history.                                                         |
| Subagents of a session                | `GET /session/:id/children`                                                                                                            |
| Busy or idle                          | `GET /session/status` returns `{ [sessionID]: { type: "busy" \| "retry" } }`. Idle sessions are absent.                                |
| Send a prompt with context            | `POST /session/:id/prompt_async` with `{ parts, model?, agent? }`. Returns `204`; progress arrives as events.                          |
| Stop                                  | `POST /session/:id/abort`                                                                                                              |
| Pending approvals                     | `GET /permission` returns `PermissionRequest[]`                                                                                        |
| Answer an approval                    | `POST /permission/:requestID/reply` with `{ reply: "once" \| "always" \| "reject", message? }`                                         |
| A prompt's file changes               | `GET /session/:id/diff?messageID=<user message id>` returns `[{ file, patch, status, additions, deletions }]`                          |
| Events                                | `GET /event` streams Server-Sent Events                                                                                                |
| Open the TUI on the session           | `lunos attach <url> --dir <root> --session <id>`, with `OPENCODE_SERVER_PASSWORD` set in its environment and never on the command line |

The full schema is at `GET /doc` (OpenAPI 3.1).

### Context

A prompt's `parts` are:

1. `{ type: "text", text }`: what the user asked.
2. The open file and the selection:
   `{ type: "file", mime: "text/plain", filename: "<relative path>", url: "file:///abs/path?start=<line>&end=<line>" }`.
   Lines are 1-based and inclusive. The server reads those lines into the prompt, as the TUI does for
   `@file#L4-8`. Leave out `?start=&end=` to send the whole file.
3. Diagnostics, as a text part:

   ```
   Problems reported by the IDE:
   - src/Calc.cs:12 [Error] CS1002: ; expected
   ```

   In JetBrains these are the file's inspection highlights. In Visual Studio they are the selected
   Error List entries.

### Events

Each SSE `data:` line is `{ type, properties }`. The first event is `server.connected`. The plugins
use these:

- **`session.created` / `session.updated`:** `properties.info.parentID` links a subagent to its
  parent. Subagents of subagents are tracked too. With Dynamic workflows on, these are the
  workflow's subagents.
- **`session.status`:** `{ sessionID, status: { type } }`. When the session goes from busy to idle,
  the prompt is finished and its diff is ready for review.
- **`message.updated`:** `info.role`, plus `info.providerID` and `info.modelID` for the model
  indicator. The last user message's id is the `messageID` for the diff.
- **`message.part.updated`:** text parts (skip `synthetic`) and tool parts (`tool`, `state.status`,
  `state.title`). A tool part whose session is a subagent's becomes that subagent's current activity.
- **`permission.asked` / `permission.replied`:** a request appears, and it disappears once anyone
  answers it, whether in the IDE or in a TUI attached to the same server.

### Approvals and approval mode

Requests for the session and for its subagents are shown in the panel with three buttons: Allow once,
Always, and Reject. Auto-approve is the IDE's version of the TUI's Auto mode (XCOD-310): it answers
`once` to each request. The organisation's locks still apply, because the server enforces them.

The TUI sees live approvals only when it is attached to the plugin's server, which is what "Open in
TUI" does. A separate `lunos` started in a terminal runs its own server: it lists the IDE's sessions
through the shared database, but not their live events.

## Hunks: accepting or rejecting an edit piece by piece

Lunos has already written the file when the diff arrives. The plugin offers each change to keep or to
revert:

1. `patch` is a unified diff with full-file context (`formatPatch(structuredPatch(..., { context:
MAX }))`). That gives one `@@` section per file. `patch` can be missing for very large files; such
   files are skipped.
2. A **hunk** is a run of consecutive `-` and `+` lines between context lines.
3. To apply the user's choices, walk the patch against the file as it is now:
   - context lines are copied;
   - `+` lines are kept for accepted hunks and dropped for rejected ones;
   - `-` lines are put back for rejected hunks.
4. Every context and `+` line must match the current file. If it doesn't (the file changed since the
   edit), nothing is applied: the plugin refuses rather than guess.
5. Line endings are kept as they are: CRLF, and a missing final newline (`\ No newline at end of file`).
6. The result is written through the editor's document or buffer, so undo works.

`sdks/ide/fixtures/hunks/*.json` holds, for each fixture, every combination of accepted hunks with the
exact file that must result. `packages/opencode/test/ide/hunk-fixtures.ts` generates the fixtures from
the same `diff` calls the server makes. An independent path, jsdiff's `applyPatch`, produces the
expected results. Both plugins' tests run against these files.
