"""Unit tests: no server needed."""

from __future__ import annotations

import json
import re
import urllib.request
import warnings
from pathlib import Path
from typing import Literal

import pytest

import lunos
from lunos._errors import from_response, from_session_error
from lunos._generated import operations
from lunos._run import _report, run_args
from lunos._session import file_part, parse_model
from lunos._tools import ToolServer

SPEC = Path(__file__).resolve().parents[2] / "openapi.json"


# -- tools ---------------------------------------------------------------------------------------


def test_tool_schema_from_type_hints() -> None:
    @lunos.tool
    def search(
        query: str, limit: int = 10, kind: Literal["file", "symbol"] = "file", tags: list[str] | None = None
    ) -> list[str]:
        """Search the code.

        Returns matching paths."""
        return []

    assert search.name == "search"
    assert search.description == "Search the code.\n\nReturns matching paths."
    assert search.parameters == {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "limit": {"type": "integer"},
            "kind": {"enum": ["file", "symbol"]},
            "tags": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["query"],
        "additionalProperties": False,
    }
    assert search("x") == []


def test_tool_overrides() -> None:
    @lunos.tool(name="lookup", description="Look it up", parameters={"type": "object", "properties": {}})
    def anything() -> str:
        return "ok"

    assert (anything.name, anything.description, anything.parameters) == (
        "lookup",
        "Look it up",
        {"type": "object", "properties": {}},
    )


def _rpc(server: ToolServer, message: object, token: str | None = None) -> tuple[int, object]:
    request = urllib.request.Request(
        server.url,
        data=json.dumps(message).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {token or server.token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        return error.code, None


def test_tool_server_speaks_mcp() -> None:
    @lunos.tool
    def add(a: int, b: int) -> int:
        """Add."""
        return a + b

    @lunos.tool
    async def fail() -> str:
        """Fail."""
        raise ValueError("nope")

    server = ToolServer([add, fail])
    try:
        status, init = _rpc(
            server, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}
        )
        assert status == 200 and init["result"]["protocolVersion"] == "2025-06-18"  # type: ignore[index]
        assert _rpc(server, {"jsonrpc": "2.0", "method": "notifications/initialized"}) == (202, None)
        _, listed = _rpc(server, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert [t["name"] for t in listed["result"]["tools"]] == ["add", "fail"]  # type: ignore[index]
        _, called = _rpc(
            server,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "add", "arguments": {"a": 1, "b": 2}},
            },
        )
        assert called["result"] == {"content": [{"type": "text", "text": "3"}], "isError": False}  # type: ignore[index]
        _, failed = _rpc(
            server, {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "fail", "arguments": {}}}
        )
        assert failed["result"]["isError"] and "nope" in failed["result"]["content"][0]["text"]  # type: ignore[index]
        _, unknown = _rpc(server, {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "nope"}})
        assert unknown["error"]["code"] == -32602  # type: ignore[index]
        assert _rpc(server, {"jsonrpc": "2.0", "id": 6, "method": "tools/list"}, token="wrong")[0] == 401
        assert server.calls == [("add", {"a": 1, "b": 2}), ("fail", {})]
        assert server.config()["oauth"] is False
    finally:
        server.close()


def test_duplicate_tool_names_are_refused() -> None:
    @lunos.tool
    def same() -> str:
        return ""

    with pytest.raises(ValueError, match="same"):
        ToolServer([same, same])


# -- versions and errors -------------------------------------------------------------------------


def test_version_tracks_the_api() -> None:
    assert lunos.__version__ == lunos.API_VERSION
    assert re.match(r"^\d+\.\d+\.\d+", lunos.__version__)


def test_compatibility_check() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        lunos.check_compatible("1.18.57", "1.18.57")
        lunos.check_compatible("1.19.0", "1.18.57")
        lunos.check_compatible("0.0.0-dev", "1.18.57")
        lunos.check_compatible("local", "1.18.57")
    with pytest.warns(lunos.LunosCompatibilityWarning):
        lunos.check_compatible("1.17.2", "1.18.57")
    with pytest.raises(lunos.IncompatibleServerError):
        lunos.check_compatible("2.0.0", "1.18.57")


def test_error_mapping() -> None:
    locked = from_response(
        403,
        {
            "name": "PolicyLockedError",
            "data": {"key": "model", "message": "model is set by your organisation's policy and can't be changed here"},
        },
        "",
    )
    assert isinstance(locked, lunos.PolicyLockedError) and locked.key == "model"
    assert isinstance(from_response(401, None, ""), lunos.AuthenticationError)
    assert isinstance(
        from_response(404, {"name": "NotFoundError", "data": {"message": "no session"}}, ""), lunos.NotFoundError
    )
    plain = from_response(400, {"_tag": "BadRequest"}, "")
    assert plain.status == 400 and plain.name == "BadRequest"

    async_lock = from_session_error(
        {
            "name": "UnknownError",
            "data": {
                "message": "model is set by your organisation's policy and can't be changed here (it is set to a/b)"
            },
        },
        "ses_1",
    )
    assert isinstance(async_lock, lunos.PolicyLockedError) and isinstance(async_lock, lunos.SessionError)
    assert async_lock.key == "model" and async_lock.session_id == "ses_1"
    residency = from_session_error(
        {"name": "ProviderInitError", "data": {"message": "… the active residency policy allows only: eu."}}, None
    )
    assert isinstance(residency, lunos.ResidencyError)
    other = from_session_error({"name": "APIError", "data": {"message": "rate limited"}}, None)
    assert type(other) is lunos.SessionError and other.message == "rate limited"


# -- generated layer -----------------------------------------------------------------------------


def test_every_operation_is_generated_sync_and_async() -> None:
    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    ids = [
        op["operationId"]
        for methods in spec["paths"].values()
        for op in methods.values()
        if isinstance(op, dict) and "operationId" in op
    ]
    source = Path(operations.__file__).read_text(encoding="utf-8")
    for op_id in ids:
        assert source.count(f"``{op_id}``)") == 2, op_id


def test_types_load() -> None:
    import lunos.types as types

    session = types.Session.model_validate(
        {
            "id": "ses_1",
            "slug": "s",
            "projectID": "p",
            "directory": "/x",
            "title": "t",
            "version": "1",
            "time": {"created": 1, "updated": 1},
            "unknownFutureField": True,
        }
    )
    assert session.id == "ses_1"


# -- prompts and runs ----------------------------------------------------------------------------


def test_parse_model() -> None:
    assert parse_model("mistral/mistral-large-latest") == ("mistral", "mistral-large-latest")
    assert parse_model("openrouter/meta/llama") == ("openrouter", "meta/llama")
    assert parse_model(None) is None
    with pytest.raises(ValueError):
        parse_model("no-provider")


def test_file_parts(tmp_path: Path) -> None:
    (tmp_path / "a.json").write_text("{}\n", encoding="utf-8")
    (tmp_path / "noext").write_text("plain text\n", encoding="utf-8")
    assert file_part(tmp_path / "a.json")["mime"] == "application/json"
    part = file_part(tmp_path / "noext")
    assert part["mime"] == "text/plain" and part["filename"] == "noext"
    assert part["url"].startswith("data:text/plain;base64,")
    image = file_part(lunos.File(b"\x89PNG", "image/png"))
    assert image == {"type": "file", "mime": "image/png", "url": "data:image/png;base64,iVBORw=="}


def test_run_args() -> None:
    args = run_args("fix it", agent="build", budget=0.5, max_steps=7, max_time=90, sandbox=False, command=["lunos"])
    assert args == [
        "lunos",
        "agent",
        "run",
        "build",
        "--prompt",
        "fix it",
        "--max-cost",
        "0.5",
        "--max-steps",
        "7",
        "--max-time",
        "90s",
        "--no-sandbox",
    ]
    assert run_args("x", max_time="2h", command="lunos")[-2:] == ["2h", "--sandbox"]
    with pytest.raises(ValueError):
        run_args("", command="lunos")
    with pytest.raises(ValueError):
        run_args("x", budget=0, command="lunos")


def test_run_report(tmp_path: Path) -> None:
    file = tmp_path / "report.json"
    file.write_text(
        json.dumps(
            {
                "agent": "build",
                "status": "ok",
                "reason": "steps",
                "started": "2026-11-02T10:00:00.000Z",
                "finished": "2026-11-02T10:01:00.000Z",
                "seconds": 60,
                "steps": 5,
                "cost": 0.12,
                "limits": {"time": 1800, "cost": 2, "steps": 5},
                "sandbox": False,
                "session": "ses_1",
                "denied": [{"permission": "bash", "patterns": ["rm -rf build"]}],
                "edited": ["src/a.ts"],
                "exitCode": 0,
            }
        )
    )
    report = _report("", f"build: ok (steps) in 60s, 5 steps, cost 0.12\n  report: {file}\n", 0)
    assert report.ok and report.reason == "steps" and report.steps == 5
    assert report.denied == [lunos.Denied("bash", ["rm -rf build"])]
    assert report.file == str(file)
    with pytest.raises(lunos.LunosError, match="didn't produce a report"):
        _report("", 'Error: No agent named "nope"\n', 1)


def test_missing_binary_is_explained(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LUNOS_COMMAND", raising=False)
    monkeypatch.setenv("PATH", "")
    with pytest.raises(lunos.ServerStartError, match="isn't installed"):
        lunos.Lunos.start()


def test_examples_compile() -> None:
    for example in sorted((Path(__file__).parents[1] / "examples").glob("*.py")):
        compile(example.read_text(encoding="utf-8"), str(example), "exec")


def test_tui_arguments(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, object] = {}

    class FakePopen:
        def __init__(self, argv: list[str], env: dict[str, str]) -> None:
            seen.update(argv=argv, env=env)

    monkeypatch.setattr("lunos._server.subprocess.Popen", FakePopen)
    lunos.tui(project="/p", model="a/b", session="ses_1", agent="plan", config={"x": 1}, command=["lunos"])
    assert seen["argv"] == ["lunos", "--project=/p", "--model=a/b", "--session=ses_1", "--agent=plan"]
    assert json.loads(seen["env"]["OPENCODE_CONFIG_CONTENT"]) == {"x": 1}  # type: ignore[index]


def test_workspace_is_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    from lunos._http import SyncTransport

    t = SyncTransport("http://x", {}, "/repo")
    t.workspace = "wrk_1"
    assert t._params("POST", "/session", {"directory": None, "workspace": None}) == {
        "directory": "/repo",
        "workspace": "wrk_1",
    }
    assert t.scoped("/other")._params("GET", "/api/session", {}) == {
        "directory": "/other",
        "location[directory]": "/other",
        "workspace": "wrk_1",
        "location[workspace]": "wrk_1",
    }
