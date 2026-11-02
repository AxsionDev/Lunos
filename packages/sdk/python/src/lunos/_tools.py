"""Custom tools written in Python.

``@lunos.tool`` turns a function into a :class:`Tool`. When a client is given tools, it serves them
from this process as an MCP server (streamable HTTP, JSON responses) on 127.0.0.1 and registers that
server with Lunos through ``POST /mcp``. The agent then calls them like any MCP tool: Lunos's
permission rules, policy locks and audit log apply to them exactly as to other MCP tools.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import secrets
import threading
import types
import typing
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Literal, Union, get_args, get_origin, overload

PROTOCOL_VERSION = "2025-03-26"
_SUPPORTED_VERSIONS = {"2024-11-05", "2025-03-26", "2025-06-18"}


@dataclass(frozen=True)
class Tool:
    """A Python function the agent can call."""

    name: str
    description: str
    parameters: dict[str, Any]
    function: Callable[..., Any] = field(repr=False)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.function(*args, **kwargs)

    def invoke(self, arguments: dict[str, Any]) -> Any:
        """Run the tool with the arguments the agent sent; awaits coroutine functions."""
        result = self.function(**arguments)
        if inspect.isawaitable(result):
            return asyncio.run(_await(result))
        return result


async def _await(value: Any) -> Any:
    return await value


@overload
def tool(function: Callable[..., Any], /) -> Tool: ...
@overload
def tool(
    *, name: str | None = None, description: str | None = None, parameters: dict[str, Any] | None = None
) -> Callable[[Callable[..., Any]], Tool]: ...


def tool(
    function: Callable[..., Any] | None = None,
    /,
    *,
    name: str | None = None,
    description: str | None = None,
    parameters: dict[str, Any] | None = None,
) -> Tool | Callable[[Callable[..., Any]], Tool]:
    """Register a Python function as a tool the agent can call.

    The tool's name is the function's name, its description the docstring, and its JSON schema is
    built from the type hints (``str``, ``int``, ``float``, ``bool``, ``list[...]``, ``dict``,
    ``Literal[...]``, ``Optional[...]``, pydantic models). Pass ``parameters`` to give the schema
    yourself.

    The function may be sync or async. Its return value is sent to the agent: a string as is,
    anything else as JSON. An exception is reported to the agent as a tool error.

    >>> @lunos.tool
    ... def add(a: int, b: int) -> int:
    ...     "Add two numbers."
    ...     return a + b
    """

    def wrap(fn: Callable[..., Any]) -> Tool:
        return Tool(
            name=name or fn.__name__,
            description=description or inspect.cleandoc(fn.__doc__ or fn.__name__),
            parameters=parameters or _schema(fn),
            function=fn,
        )

    if function is not None:
        return wrap(function)
    return wrap


def _schema(fn: Callable[..., Any]) -> dict[str, Any]:
    hints = typing.get_type_hints(fn)
    properties: dict[str, Any] = {}
    required: list[str] = []
    for param in inspect.signature(fn).parameters.values():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        properties[param.name] = _type_schema(hints.get(param.name, Any))
        if param.default is inspect.Parameter.empty:
            required.append(param.name)
    schema: dict[str, Any] = {"type": "object", "properties": properties, "additionalProperties": False}
    if required:
        schema["required"] = required
    return schema


def _type_schema(hint: Any) -> dict[str, Any]:
    if hint is Any:
        return {}
    if hasattr(hint, "model_json_schema"):
        return hint.model_json_schema()
    origin = get_origin(hint)
    args = get_args(hint)
    if origin is Literal:
        return {"enum": list(args)}
    if origin in (Union, types.UnionType):
        options = [a for a in args if a is not type(None)]
        if len(options) == 1:
            return _type_schema(options[0])
        return {"anyOf": [_type_schema(a) for a in options]}
    if origin in (list, tuple, set, frozenset, Sequence):
        return {"type": "array", "items": _type_schema(args[0]) if args else {}}
    if origin is dict or hint is dict:
        return {"type": "object"}
    simple = {str: "string", int: "integer", float: "number", bool: "boolean", list: "array"}
    if hint in simple:
        return {"type": simple[hint]}
    return {}


def _content(value: Any) -> str:
    if isinstance(value, str):
        return value
    if hasattr(value, "model_dump_json"):
        return value.model_dump_json()
    return json.dumps(value, default=str)


class ToolServer:
    """Serves tools over MCP (streamable HTTP) on 127.0.0.1, behind a random bearer token."""

    def __init__(self, tools: Sequence[Tool]) -> None:
        names = [t.name for t in tools]
        duplicate = next((n for n in names if names.count(n) > 1), None)
        if duplicate:
            raise ValueError(f"two tools are named {duplicate!r}")
        self.tools = {t.name: t for t in tools}
        self.token = secrets.token_urlsafe(24)
        self.calls: list[tuple[str, dict[str, Any]]] = []
        handler = type("Handler", (_Handler,), {"owner": self})
        self._http = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._http.daemon_threads = True
        self._thread = threading.Thread(target=self._http.serve_forever, name="lunos-tools", daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._http.server_address[1]}/mcp"

    def config(self) -> dict[str, Any]:
        """The ``McpRemoteConfig`` Lunos connects to this server with."""
        return {
            "type": "remote",
            "url": self.url,
            "oauth": False,
            "headers": {"Authorization": f"Bearer {self.token}"},
        }

    def close(self) -> None:
        self._http.shutdown()
        self._http.server_close()

    def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        method = message.get("method")
        if "id" not in message:
            return None
        if method == "initialize":
            asked = (message.get("params") or {}).get("protocolVersion")
            return _result(
                message,
                {
                    "protocolVersion": asked if asked in _SUPPORTED_VERSIONS else PROTOCOL_VERSION,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": "lunos-python", "version": "1"},
                },
            )
        if method == "ping":
            return _result(message, {})
        if method == "tools/list":
            return _result(
                message,
                {
                    "tools": [
                        {"name": t.name, "description": t.description, "inputSchema": t.parameters}
                        for t in self.tools.values()
                    ]
                },
            )
        if method == "tools/call":
            params = message.get("params") or {}
            found = self.tools.get(params.get("name", ""))
            if not found:
                return _error(message, -32602, f"unknown tool {params.get('name')!r}")
            arguments = params.get("arguments") or {}
            self.calls.append((found.name, arguments))
            try:
                value = found.invoke(arguments)
            except Exception as error:  # the agent is told, and can carry on
                return _result(
                    message,
                    {"content": [{"type": "text", "text": f"{type(error).__name__}: {error}"}], "isError": True},
                )
            return _result(message, {"content": [{"type": "text", "text": _content(value)}], "isError": False})
        return _error(message, -32601, f"method not found: {method}")


def _result(message: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message["id"], "result": result}


def _error(message: dict[str, Any], code: int, text: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": message["id"], "error": {"code": code, "message": text}}


class _Handler(BaseHTTPRequestHandler):
    owner: ToolServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _reply(self, status: int, body: Any = None) -> None:
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(status)
        if body is not None:
            self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        if self.headers.get("authorization") == f"Bearer {self.owner.token}":
            return True
        self._reply(401, {"error": "unauthorized"})
        return False

    def do_GET(self) -> None:
        # No server-initiated messages: tell the client there is no SSE stream to open.
        self._reply(405)

    def do_DELETE(self) -> None:
        self._reply(200 if self._authorized() else 401)

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        if not self._authorized():
            return
        try:
            message = json.loads(raw)
        except ValueError:
            self._reply(400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            return
        batch = message if isinstance(message, list) else [message]
        replies = [reply for reply in (self.owner.handle(m) for m in batch) if reply is not None]
        if not replies:
            self._reply(202)
            return
        self._reply(200, replies if isinstance(message, list) else replies[0])
