"""The blocking client. It runs the async client on a private event loop in a background thread,
so it works the same from scripts, notebooks and code that already runs an event loop."""

from __future__ import annotations

import asyncio
import os
import threading
from collections.abc import Awaitable, Coroutine, Iterator, Mapping, Sequence
from typing import Any, TypeVar

from ._client import AsyncLunos
from ._events import Done, PermissionRequest, PromptEvent
from ._generated.operations import SyncAPI
from ._http import SyncTransport
from ._session import ApprovalMode, AsyncSession, Attachment, Message, PermissionHandler, PromptStream
from ._tools import Tool

T = TypeVar("T")


class _Portal:
    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="lunos-loop", daemon=True)
        self.thread.start()

    def call(self, coro: Coroutine[Any, Any, T] | Awaitable[T]) -> T:
        return asyncio.run_coroutine_threadsafe(_wrap(coro), self.loop).result()

    def close(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        if not self.loop.is_running():
            self.loop.close()


async def _wrap(awaitable: Awaitable[T]) -> T:
    return await awaitable


class Session:
    """A Lunos session (blocking). See :class:`lunos.AsyncSession` for the details of each method."""

    def __init__(self, portal: _Portal, session: AsyncSession) -> None:
        self._portal = portal
        self._async = session

    def __repr__(self) -> str:
        return repr(self._async).replace("<Session", "<Session(sync)")

    @property
    def id(self) -> str:
        return self._async.id

    @property
    def directory(self) -> str | None:
        return self._async.directory

    @property
    def agent(self) -> str | None:
        return self._async.agent

    @property
    def info(self) -> Any:
        return self._async.info

    @property
    def parent_id(self) -> str | None:
        return self._async.parent_id

    def prompt(
        self,
        text: str,
        *,
        files: Sequence[Attachment] = (),
        images: Sequence[Attachment] = (),
        agent: str | None = None,
        model: str | tuple[str, str] | None = None,
        system: str | None = None,
        tools: dict[str, bool] | None = None,
        on_permission: PermissionHandler | None = None,
        raise_on_error: bool = True,
    ) -> SyncPromptStream:
        """Send a prompt; iterate the result for its events (``for event in session.prompt(...)``)."""
        stream = self._async.prompt(
            text,
            files=files,
            images=images,
            agent=agent,
            model=model,
            system=system,
            tools=tools,
            on_permission=on_permission,
            raise_on_error=raise_on_error,
        )
        return SyncPromptStream(self._portal, stream)

    def ask(self, text: str, **options: Any) -> Done:
        return self._portal.call(self._async.ask(text, **options))

    def approve(self, request: PermissionRequest | str, *, always: bool = False) -> None:
        self._portal.call(self._async.approve(request, always=always))

    def deny(self, request: PermissionRequest | str, message: str | None = None) -> None:
        self._portal.call(self._async.deny(request, message))

    def approval_mode(self) -> ApprovalMode:
        return self._portal.call(self._async.approval_mode())

    def set_approval_mode(self, mode: ApprovalMode) -> None:
        self._portal.call(self._async.set_approval_mode(mode))

    def abort(self) -> None:
        self._portal.call(self._async.abort())

    def fork(self, message_id: str | None = None) -> Session:
        return Session(self._portal, self._portal.call(self._async.fork(message_id)))

    def messages(self) -> list[Message]:
        return self._portal.call(self._async.messages())

    def children(self) -> list[Session]:
        return [Session(self._portal, s) for s in self._portal.call(self._async.children())]

    def delete(self) -> None:
        self._portal.call(self._async.delete())


class SyncPromptStream:
    """The events of one prompt (blocking iterator). ``text`` and ``cost`` are set when it ends."""

    def __init__(self, portal: _Portal, stream: PromptStream) -> None:
        self._portal = portal
        self._stream = stream

    @property
    def text(self) -> str:
        return self._stream.text

    @property
    def cost(self) -> float:
        return self._stream.cost

    @property
    def error(self) -> Exception | None:
        return self._stream.error

    def __iter__(self) -> Iterator[PromptEvent]:
        events = self._stream.__aiter__()
        try:
            while True:
                try:
                    yield self._portal.call(events.__anext__())
                except StopAsyncIteration:
                    return
        finally:
            aclose = getattr(events, "aclose", None)
            if aclose:
                self._portal.call(aclose())


class Sessions:
    def __init__(self, client: Lunos) -> None:
        self._client = client

    def create(
        self,
        *,
        agent: str | None = None,
        model: str | tuple[str, str] | None = None,
        directory: str | os.PathLike[str] | None = None,
        title: str | None = None,
        approval_mode: ApprovalMode | None = None,
        permission: Sequence[Mapping[str, str]] | None = None,
        parent_id: str | None = None,
    ) -> Session:
        """Start a session. See :meth:`lunos.AsyncLunos.sessions` ``create``."""
        session = self._client._portal.call(
            self._client._async.sessions.create(
                agent=agent,
                model=model,
                directory=directory,
                title=title,
                approval_mode=approval_mode,
                permission=permission,
                parent_id=parent_id,
            )
        )
        return Session(self._client._portal, session)

    def get(self, session_id: str, *, directory: str | os.PathLike[str] | None = None) -> Session:
        return Session(
            self._client._portal,
            self._client._portal.call(self._client._async.sessions.get(session_id, directory=directory)),
        )

    def list(self, *, directory: str | os.PathLike[str] | None = None) -> list[Session]:
        found = self._client._portal.call(self._client._async.sessions.list(directory=directory))
        return [Session(self._client._portal, s) for s in found]


class Lunos:
    """A connection to a Lunos server (blocking). The async twin is :class:`lunos.AsyncLunos`.

    >>> with lunos.Lunos.start() as client:
    ...     session = client.sessions.create(agent="build")
    ...     for event in session.prompt("Fix the failing test"):
    ...         ...
    """

    def __init__(self, portal: _Portal, client: AsyncLunos) -> None:
        self._portal = portal
        self._async = client
        self.sessions = Sessions(self)
        self._sync_transport = SyncTransport(client.url, client._transport.headers, client.directory)
        self._sync_transport.workspace = client._transport.workspace
        self.api = SyncAPI(self._sync_transport)
        """Every server operation, generated from the OpenAPI spec (blocking)."""

    @classmethod
    def start(
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
    ) -> Lunos:
        """Start a local server with the installed ``lunos``. See :meth:`lunos.AsyncLunos.start`."""
        portal = _Portal()
        try:
            client = portal.call(
                AsyncLunos.start(
                    directory=directory,
                    config=config,
                    tools=tools,
                    command=command,
                    env=env,
                    hostname=hostname,
                    port=port,
                    timeout=timeout,
                    check_version=check_version,
                )
            )
        except BaseException:
            portal.close()
            raise
        return cls(portal, client)

    @classmethod
    def connect(
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
    ) -> Lunos:
        """Connect to a running server. See :meth:`lunos.AsyncLunos.connect`."""
        portal = _Portal()
        try:
            client = portal.call(
                AsyncLunos.connect(
                    url,
                    token,
                    directory=directory,
                    tools=tools,
                    username=username,
                    headers=headers,
                    workspace=workspace,
                    check_version=check_version,
                )
            )
        except BaseException:
            portal.close()
            raise
        return cls(portal, client)

    @property
    def url(self) -> str:
        return self._async.url

    @property
    def directory(self) -> str | None:
        return self._async.directory

    @property
    def server_version(self) -> str | None:
        return self._async.server_version

    @property
    def tool_calls(self) -> list[tuple[str, dict[str, Any]]]:
        return self._async.tool_calls

    def add_tools(self, *tools: Tool) -> None:
        self._portal.call(self._async.add_tools(*tools))

    def scoped_api(self, directory: str | os.PathLike[str]) -> SyncAPI:
        return SyncAPI(self._sync_transport.scoped(os.fspath(directory)))

    def close(self) -> None:
        try:
            self._sync_transport.close()
            self._portal.call(self._async.close())
        finally:
            self._portal.close()

    def __enter__(self) -> Lunos:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
