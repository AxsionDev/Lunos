"""The async client. ``lunos.Lunos`` is the same API, blocking."""

from __future__ import annotations

import asyncio
import os
import re
import warnings
from collections.abc import Mapping, Sequence
from typing import Any

import httpx

from ._errors import APIError, IncompatibleServerError, LunosCompatibilityWarning, LunosError
from ._generated.operations import AsyncAPI
from ._http import AsyncTransport, auth_headers
from ._server import LocalServer
from ._session import ApprovalMode, AsyncSession, parse_model
from ._tools import Tool, ToolServer
from ._version import API_VERSION


def _version(text: str) -> tuple[int, int, int] | None:
    match = re.match(r"^v?(\d+)\.(\d+)\.(\d+)", text.strip())
    return (int(match[1]), int(match[2]), int(match[3])) if match else None


def check_compatible(server: str, sdk: str = API_VERSION) -> None:
    """Raise if the server's API can't serve this SDK; warn if it is older than the SDK.

    The SDK is generated from the API of Lunos ``sdk``. A server with another major version is
    refused. An older server works, but operations added since may be missing. A newer server
    within the major version is fine. Development builds (no version) aren't checked.
    """
    have, want = _version(server), _version(sdk)
    if not have or not want or have == (0, 0, 0):
        return
    if have[0] != want[0]:
        raise IncompatibleServerError(
            f"the server runs Lunos {server}, but this SDK ({sdk}) needs Lunos {want[0]}.x; "
            f"install lunos=={server} or upgrade the server"
        )
    if have < want:
        warnings.warn(
            f"the server runs Lunos {server}, older than this SDK ({sdk}): operations added since may be missing",
            LunosCompatibilityWarning,
            stacklevel=3,
        )


class AsyncSessions:
    def __init__(self, client: AsyncLunos) -> None:
        self._client = client

    async def create(
        self,
        *,
        agent: str | None = None,
        model: str | tuple[str, str] | None = None,
        directory: str | os.PathLike[str] | None = None,
        title: str | None = None,
        approval_mode: ApprovalMode | None = None,
        permission: Sequence[Mapping[str, str]] | None = None,
        parent_id: str | None = None,
    ) -> AsyncSession:
        """Start a session.

        ``agent`` is the workflow (``build``, ``plan``, …), ``model`` is ``"provider/model"``,
        ``directory`` the project it works in (default: the client's). ``permission`` adds rules
        for this session only, e.g. ``[{"permission": "bash", "pattern": "*", "action": "ask"}]``;
        the organisation's locked rules still win. ``approval_mode`` is ``"manual"`` (default) or
        ``"auto"``, refused like in the TUI when the organisation locks it.
        """
        t = self._client._scoped(directory)
        parsed = parse_model(model)
        body: dict[str, Any] = {}
        if agent:
            body["agent"] = agent
        if parsed:
            body["model"] = {"providerID": parsed[0], "id": parsed[1]}
        if title:
            body["title"] = title
        if permission:
            body["permission"] = [dict(rule) for rule in permission]
        if parent_id:
            body["parentID"] = parent_id
        info = await t.request("POST", "/session", params={"directory": None}, json=body)
        session = AsyncSession(self._client, info, agent=agent, model=parsed)
        if approval_mode:
            await session.set_approval_mode(approval_mode)
        return session

    async def get(self, session_id: str, *, directory: str | os.PathLike[str] | None = None) -> AsyncSession:
        info = await self._client._scoped(directory).request(
            "GET", f"/session/{session_id}", params={"directory": None}
        )
        return AsyncSession(self._client, info)

    async def list(self, *, directory: str | os.PathLike[str] | None = None) -> list[AsyncSession]:
        data = await self._client._scoped(directory).request("GET", "/session", params={"directory": None})
        return [AsyncSession(self._client, info) for info in data]


class AsyncLunos:
    """A connection to a Lunos server.

    Use :meth:`start` to run a local server with the installed ``lunos``, or :meth:`connect` for
    one that is already running (yours, your team's, or Lunos Cloud).

    ``api`` has every server operation, generated from its OpenAPI spec; ``sessions`` is the
    high-level API.
    """

    def __init__(
        self,
        url: str,
        *,
        token: str | None = None,
        username: str = "opencode",
        directory: str | os.PathLike[str] | None = None,
        tools: Sequence[Tool] = (),
        headers: Mapping[str, str] | None = None,
        tools_name: str = "python",
        workspace: str | None = None,
        server: LocalServer | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.directory = os.fspath(directory) if directory else None
        self._transport = AsyncTransport(self.url, {**auth_headers(token, username), **(headers or {})}, self.directory)
        self._transport.workspace = workspace
        self.api = AsyncAPI(self._transport)
        self.sessions = AsyncSessions(self)
        self.server = server
        self.server_version: str | None = None
        self._tools: list[Tool] = list(tools)
        self._tools_name = tools_name
        self._tool_server: ToolServer | None = None
        self._tools_registered: set[str | None] = set()
        self._tools_lock = asyncio.Lock()

    @classmethod
    async def start(
        cls,
        *,
        directory: str | os.PathLike[str] | None = None,
        config: Mapping[str, Any] | None = None,
        tools: Sequence[Tool] = (),
        command: str | Sequence[str] | None = None,
        env: Mapping[str, str] | None = None,
        hostname: str = "127.0.0.1",
        port: int = 0,
        timeout: float = 60.0,
        check_version: bool = True,
    ) -> AsyncLunos:
        """Start a local server with the installed ``lunos`` and connect to it.

        It listens on 127.0.0.1 with a random password only this client knows, works in
        ``directory`` (default: the current one), and stops when the client closes. ``config`` is
        Lunos config (as in ``lunos.json``) for this server only; managed config and its locks
        still apply. ``command`` (or ``$LUNOS_COMMAND``) runs another Lunos than the one on PATH.
        """
        directory = os.fspath(directory or os.getcwd())
        server = await asyncio.to_thread(
            LocalServer.start,
            command=command,
            hostname=hostname,
            port=port,
            directory=directory,
            config=config,
            env=env,
            timeout=timeout,
        )
        client = cls(server.url, token=server.password, directory=directory, tools=tools, server=server)
        try:
            await client._handshake(check_version)
        except BaseException:
            await client.close()
            raise
        return client

    @classmethod
    async def connect(
        cls,
        url: str,
        token: str | None = None,
        *,
        directory: str | os.PathLike[str] | None = None,
        tools: Sequence[Tool] = (),
        username: str = "opencode",
        headers: Mapping[str, str] | None = None,
        workspace: str | None = None,
        check_version: bool = True,
    ) -> AsyncLunos:
        """Connect to a running server: ``lunos serve``, a shared one, or Lunos Cloud.

        ``token`` is the server's password (``OPENCODE_SERVER_PASSWORD``). ``directory`` is the
        project on the server's machine that sessions work in by default, and ``workspace`` the
        workspace (``wrk_…``) every call is made in, if any.
        """
        client = cls(
            url, token=token, username=username, directory=directory, tools=tools, headers=headers, workspace=workspace
        )
        try:
            await client._handshake(check_version)
        except BaseException:
            await client.close()
            raise
        return client

    async def _handshake(self, check_version: bool) -> None:
        health = await self._transport.request("GET", "/global/health")
        self.server_version = str(health.get("version", ""))
        if check_version:
            check_compatible(self.server_version)

    def _scoped(self, directory: str | os.PathLike[str] | None) -> AsyncTransport:
        return self._transport.scoped(os.fspath(directory)) if directory else self._transport

    def scoped_api(self, directory: str | os.PathLike[str]) -> AsyncAPI:
        """``api`` for another project directory."""
        return AsyncAPI(self._scoped(directory))

    # -- custom tools -------------------------------------------------------------------------

    async def add_tools(self, *tools: Tool) -> None:
        """Make more Python tools available to the agent (in sessions prompted from now on)."""
        async with self._tools_lock:
            self._tools.extend(tools)
            if self._tool_server:
                self._tool_server.close()
                self._tool_server = None
            self._tools_registered.clear()

    async def _ensure_tools(self, t: AsyncTransport) -> None:
        """Serve the tools and register them with the session's instance, once per directory."""
        if not self._tools:
            return
        async with self._tools_lock:
            if t.directory in self._tools_registered:
                return
            if not self._tool_server:
                self._tool_server = ToolServer(self._tools)
            status = await t.request(
                "POST",
                "/mcp",
                params={"directory": None},
                json={"name": self._tools_name, "config": self._tool_server.config()},
            )
            state = (status or {}).get(self._tools_name, {})
            if state.get("status") != "connected":
                raise LunosError(f"Lunos couldn't use the Python tools: {state.get('error') or state}")
            self._tools_registered.add(t.directory)

    @property
    def tool_calls(self) -> list[tuple[str, dict[str, Any]]]:
        """Every call the agent made to this client's Python tools, as ``(name, arguments)``."""
        return list(self._tool_server.calls) if self._tool_server else []

    # -- lifecycle ----------------------------------------------------------------------------

    async def close(self) -> None:
        """Disconnect; stops the server if :meth:`start` started it."""
        if self._tool_server:
            # On a server someone else runs, take the tools away before they stop answering.
            for directory in [] if self.server else list(self._tools_registered):
                try:
                    await self._transport.scoped(directory).request(
                        "POST", f"/mcp/{self._tools_name}/disconnect", params={"directory": None}, timeout=5
                    )
                except (APIError, httpx.HTTPError):
                    pass  # best effort: the server may already be gone
            self._tool_server.close()
            self._tool_server = None
        await self._transport.aclose()
        if self.server:
            await asyncio.to_thread(self.server.close)

    async def __aenter__(self) -> AsyncLunos:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()
