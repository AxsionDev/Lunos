# Lunos for Python

Run Lunos agents from Python: CI jobs, data pipelines, internal tools. You get sessions, streamed
replies, permission requests, subagents, custom tools written in Python, and headless runs with
hard limits. The same EU residency and organisation policy apply as in the TUI, because the Lunos
server enforces them.

```sh
pip install lunos
```

Python 3.10 or later, on macOS, Linux and Windows. `Lunos.start()` and `lunos.run()` use the
installed [`lunos`](https://lunos.tech) command. `Lunos.connect()` needs only a running server.

## Quick start

```python
import lunos
from lunos.events import PermissionRequest, TextDelta, ToolCall

with lunos.Lunos.start() as client:  # runs `lunos serve` in the current directory
    session = client.sessions.create(agent="build")
    for event in session.prompt("Run the tests and tell me what fails"):
        if isinstance(event, TextDelta):
            print(event.text, end="", flush=True)
        elif isinstance(event, ToolCall) and event.status == "running":
            print(f"\n[{event.tool}] {event.title or ''}")
        elif isinstance(event, PermissionRequest):
            # Manual approval (the default): the turn waits for your answer.
            if input(f"\nAllow {event.permission} {event.patterns}? [y/N] ") == "y":
                session.approve(event)
            else:
                session.deny(event, "Not now; tell me what you would have run.")
```

The same with `asyncio`:

```python
import asyncio
import lunos

async def main():
    async with await lunos.AsyncLunos.start() as client:
        session = await client.sessions.create(agent="build")
        async for event in session.prompt("Summarise this repository"):
            if isinstance(event, lunos.events.TextDelta):
                print(event.text, end="")

asyncio.run(main())
```

## Connecting

|                                                           |                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Lunos.start(directory=..., config=..., tools=[...])`     | Starts `lunos serve` on 127.0.0.1 with a random password and stops it on `close()`. `config` is Lunos config for this server only, in the same shape as `lunos.json`. Set `command=` or `$LUNOS_COMMAND` to use a Lunos that isn't on `PATH`. |
| `Lunos.connect(url, token, directory=..., workspace=...)` | Connects to a server that is already running: your own `lunos serve`, a shared one, or Lunos Cloud. `token` is the server password (`OPENCODE_SERVER_PASSWORD`).                                                                              |
| `lunos.tui(project=..., session=...)`                     | Opens the Lunos TUI in this terminal, for example on a session the script started.                                                                                                                                                            |

`AsyncLunos` has the same methods, as coroutines. On connect, the client checks the server's API
version. A different major version raises `IncompatibleServerError`. An older server only warns,
with `LunosCompatibilityWarning`. The SDK version is the Lunos version it was generated from
(`lunos.API_VERSION`).

## Sessions

```python
session = client.sessions.create(
    agent="build",                       # the workflow
    model="mistral/mistral-large-latest",
    directory="/path/to/project",        # default: the client's directory
    approval_mode="manual",              # or "auto"
    permission=[{"permission": "bash", "pattern": "git push*", "action": "deny"}],
)
```

- **`session.prompt(text, files=[...], images=[...], model=..., agent=..., on_permission=...)`**
  streams `lunos.events`:
  - `TextDelta` and `Text`, the reply as it is written and each finished block;
  - `ToolCall`, sent when a call starts and again when it completes or fails;
  - `PermissionRequest`;
  - `SubagentStarted`, after which the subagent's own events follow with `subagent=True`;
  - `StepFinished`, with the step's cost and tokens;
  - `Error`;
  - `Done`, always last, with `text` (the final reply), `cost` and `aborted`.

  A failed turn raises when the stream ends: `SessionError`, `PolicyLockedError` or
  `ResidencyError`.

- **`session.ask(text, ...)`** prompts and returns the final `Done`. Use it with
  `approval_mode="auto"` or `on_permission=`.
- **`session.approve(request, always=False)`** and **`session.deny(request, message=None)`**
  answer a permission request.
- **`session.set_approval_mode("auto" | "manual")`**. Auto approves each `ask` once, like the
  TUI's Auto mode. Rules set to `deny` never ask. If the organisation locks a workflow's approval,
  changing it raises `PolicyLockedError` with the TUI's message.
- **`on_permission=lambda request: ...`** answers requests as they come. Return `True` or
  `"once"`, `"always"`, `False` or `"reject"`, or `None` to leave the request to you.
- Attach files and images with **`files=` / `images=`**. Each item is a path, or
  `lunos.File(data, mime, filename)` for bytes.
- **`session.fork(message_id=None)`**, **`session.abort()`**, **`session.messages()`**,
  **`session.children()`** (its subagents) and **`session.delete()`**.
- **`client.sessions.get(id)`** and **`client.sessions.list()`**.

## Custom tools in Python

```python
@lunos.tool
def ticket_status(key: str) -> dict:
    """Look up a ticket in our tracker."""
    return tracker.get(key)

with lunos.Lunos.start(tools=[ticket_status]) as client:
    session = client.sessions.create()
    print(session.ask("Is XCOD-337 done?").text)
```

The JSON schema comes from the type hints, and the description from the docstring. You can
override both: `@lunos.tool(name=..., description=..., parameters=...)`. Tools can be sync or
async. A string return value is sent to the agent as is, and anything else as JSON. An exception
is reported to the agent as a failed tool call.

The client serves its tools from your process as an MCP server on 127.0.0.1, behind a random
token, and registers it with Lunos. So the agent calls them like any MCP tool, and your
permission rules, policy locks and audit log apply to them.

## Headless runs

```python
report = lunos.run(
    "Fix the failing build",
    agent="build",
    budget=2.0,        # stop once model spend passes this
    max_steps=50,      # model steps, subagents included
    max_time="30m",    # seconds, or "90s", "30m", "2h"
    sandbox=True,      # a Docker sandbox, as for `lunos agent run`; sandbox=False runs in place
)
print(report.status, report.reason, report.steps, report.cost, report.results)
```

`lunos.run()` is `lunos agent run`, and `lunos.arun()` is its async form. Nothing is
auto-approved: every permission prompt is refused and listed in `report.denied`. The report has
the unattended runner's fields and exit reasons:

| `reason`                | meaning                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `completed`             | The agent finished.                                                                  |
| `failed`                | The run failed. See `report.error`.                                                  |
| `time`, `cost`, `steps` | A limit stopped the run. The status is `ok` and the work done so far is handed back. |
| `budget`                | A project or organisation budget stopped the run.                                    |

## Policy and residency

Policy is enforced by the server, so the SDK gets the same refusals as the TUI:

- a locked `model` raises `PolicyLockedError`, with `key == "model"` and the policy message;
- a locked approval mode raises `PolicyLockedError` from `set_approval_mode()`;
- a provider that the data-residency policy rules out raises `ResidencyError`, and no request
  reaches that provider;
- config passed to `Lunos.start(config=...)` is user config, so locked keys keep the
  organisation's values.

## The whole API

`client.api` has every server operation, generated from the server's OpenAPI spec, the same spec
the JavaScript SDK is generated from. The methods are grouped as in the JavaScript SDK:
`client.api.session.list()`, `client.api.mcp.status()`, `client.api.global_.health()`, and so on.
Responses are pydantic models from `lunos.types`.

## Examples

See [`examples/`](examples):

- [`ci_fix_build.py`](examples/ci_fix_build.py): a CI job that fixes the build;
- [`batch_refactor.py`](examples/batch_refactor.py): one refactor across many repositories;
- [`custom_tool.py`](examples/custom_tool.py): a Python tool the agent calls;
- [`quickstart.py`](examples/quickstart.py): the quick start above.

## Development

```sh
cd packages/sdk/python
uv sync
uv run pytest                    # unit tests, plus end-to-end tests if `lunos` is installed
LUNOS_COMMAND="bun run ../../opencode/src/index.ts" uv run pytest   # against the source tree
uv run --group codegen python script/generate.py      # after the OpenAPI spec changes
uv run --group docs pdoc lunos -o build/api            # the API reference
```

The end-to-end tests start real Lunos servers with isolated config and data directories. They
use a scripted model served from the test process, so they need no API key and no network.
