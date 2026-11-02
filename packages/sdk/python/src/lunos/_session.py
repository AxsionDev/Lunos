"""Sessions: prompting with streamed events, permissions, approval modes, files, fork and abort."""

from __future__ import annotations

import asyncio
import base64
import inspect
import mimetypes
import os
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, NamedTuple, Union

from ._errors import APIError, PolicyLockedError, SessionError, from_session_error
from ._events import (
    Done,
    Error,
    PermissionRequest,
    PromptEvent,
    Reasoning,
    StepFinished,
    SubagentStarted,
    Text,
    TextDelta,
    ToolCall,
)
from ._http import AsyncTransport

if TYPE_CHECKING:
    from ._client import AsyncLunos
    from ._generated import models

ApprovalMode = Literal["manual", "auto"]
PermissionReply = Literal["once", "always", "reject"]
PermissionHandler = Callable[[PermissionRequest], bool | str | None | Awaitable[bool | str | None]]


@dataclass(frozen=True)
class File:
    """A file or image to attach to a prompt, from bytes. Paths can be passed to ``files=`` directly."""

    data: bytes
    mime: str
    filename: str | None = None


Attachment = Union[str, "os.PathLike[str]", File]


def parse_model(model: str | tuple[str, str] | None) -> tuple[str, str] | None:
    """``"provider/model"`` (or a ``(provider, model)`` tuple) as ``(provider, model)``."""
    if model is None:
        return None
    if isinstance(model, tuple):
        return model
    provider, sep, name = model.partition("/")
    if not sep or not provider or not name:
        raise ValueError(f'model must look like "provider/model", not {model!r}')
    return provider, name


def file_part(item: Attachment) -> dict[str, Any]:
    if isinstance(item, File):
        data, mime, filename = item.data, item.mime, item.filename
    else:
        path = Path(item)
        data = path.read_bytes()
        mime = mimetypes.guess_type(path.name)[0] or ("text/plain" if _is_text(data) else "application/octet-stream")
        filename = path.name
    part: dict[str, Any] = {
        "type": "file",
        "mime": mime,
        "url": f"data:{mime};base64,{base64.b64encode(data).decode()}",
    }
    if filename:
        part["filename"] = filename
    return part


def _is_text(data: bytes) -> bool:
    try:
        data[:4096].decode("utf-8")
    except UnicodeDecodeError:
        return False
    return b"\x00" not in data[:4096]


async def resolve_approval(
    transport: AsyncTransport, agent: str | None, stored: ApprovalMode | None
) -> tuple[ApprovalMode, str | None]:
    """The approval mode a workflow runs in, as the TUI resolves it (XCOD-310).

    An organisation lock wins (its configured value, else manual), then the mode chosen for this
    session, then ``agent.<name>.permission_mode``, then manual. Returns the mode and the lock key.
    """
    config = await transport.request("GET", "/config", params={"directory": None})
    name = agent or config.get("default_agent") or "build"
    configured = ((config.get("agent") or {}).get(name) or {}).get("permission_mode")
    key = f"agent.{name}.permission_mode"
    lock = next((e for e in config.get("$locked") or [] if key == e or key.startswith(e + ".")), None)
    if lock:
        return ("auto" if configured == "auto" else "manual"), lock
    if stored:
        return stored, None
    if configured in ("auto", "manual"):
        return configured, None
    return "manual", None


class AsyncSession:
    """A Lunos session. Get one from ``client.sessions.create()`` or ``client.sessions.get()``."""

    def __init__(
        self,
        client: AsyncLunos,
        info: dict[str, Any],
        *,
        agent: str | None = None,
        model: tuple[str, str] | None = None,
    ) -> None:
        self._client = client
        self._raw = info
        self.id: str = info["id"]
        self.directory: str | None = info.get("directory")
        self.agent = agent or info.get("agent")
        self.model = model
        self._approval: ApprovalMode | None = None
        self._aborting = False
        self._t = client._transport.scoped(self.directory or client._transport.directory)

    def __repr__(self) -> str:
        return f"<Session {self.id} agent={self.agent!r} directory={self.directory!r}>"

    @property
    def info(self) -> models.Session:
        """The session as the server describes it (a generated model)."""
        from ._http import validate

        return validate("Session", self._raw)

    @property
    def parent_id(self) -> str | None:
        return self._raw.get("parentID")

    # -- approval -----------------------------------------------------------------------------

    async def approval_mode(self) -> ApprovalMode:
        """Manual (every ``ask`` comes to you) or auto (the SDK approves each ``ask`` once)."""
        mode, _ = await resolve_approval(self._t, self.agent, self._approval)
        return mode

    async def set_approval_mode(self, mode: ApprovalMode) -> None:
        """Switch between manual and auto approval for this session's workflow.

        Refused with :class:`PolicyLockedError` when the organisation locks the workflow's approval,
        with the TUI's messages. ``deny`` rules are never asked, so auto never reaches them.
        """
        if mode not in ("manual", "auto"):
            raise ValueError('approval mode must be "manual" or "auto"')
        current, lock = await resolve_approval(self._t, self.agent, None)
        if lock and mode != current:
            label = (self.agent or "build").title()
            message = (
                f"{label}: approval is set by your organisation"
                if current == "auto"
                else "Auto-approve is turned off by your organisation"
            )
            raise PolicyLockedError(lock, message)
        self._approval = mode

    # -- permissions --------------------------------------------------------------------------

    async def approve(self, request: PermissionRequest | str, *, always: bool = False) -> None:
        """Allow a pending permission request, once or (``always=True``) for its ``always`` patterns."""
        await self._reply(request, "always" if always else "once")

    async def deny(self, request: PermissionRequest | str, message: str | None = None) -> None:
        """Refuse a pending permission request; ``message`` tells the agent why or what to do instead."""
        await self._reply(request, "reject", message)

    async def _reply(
        self, request: PermissionRequest | str, reply: PermissionReply, message: str | None = None
    ) -> None:
        request_id = request if isinstance(request, str) else request.id
        body: dict[str, Any] = {"reply": reply}
        if message:
            body["message"] = message
        await self._t.request("POST", f"/permission/{request_id}/reply", params={"directory": None}, json=body)

    # -- prompting ----------------------------------------------------------------------------

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
    ) -> PromptStream:
        """Send a prompt and stream what happens until the turn (and its subagents) finish.

        ``async for event in session.prompt("...")`` yields :mod:`lunos.events`: text as it is written,
        tool calls, subagents and permission requests, then :class:`~lunos.events.Done`. A failed
        turn raises (:class:`SessionError`, :class:`PolicyLockedError`, :class:`ResidencyError`)
        after the stream ends, unless ``raise_on_error=False``.

        ``on_permission`` answers permission requests as they come: return ``True``/``"once"``,
        ``"always"``, ``False``/``"reject"``, or ``None`` to leave it to you.
        """
        parts: list[dict[str, Any]] = [{"type": "text", "text": text}]
        parts += [file_part(item) for item in [*files, *images]]
        body: dict[str, Any] = {"parts": parts}
        if agent or self.agent:
            body["agent"] = agent or self.agent
        chosen = parse_model(model) or self.model
        if chosen:
            body["model"] = {"providerID": chosen[0], "modelID": chosen[1]}
        if system:
            body["system"] = system
        if tools:
            body["tools"] = tools
        return PromptStream(self, body, on_permission, raise_on_error)

    async def ask(self, text: str, **options: Any) -> Done:
        """Prompt and wait for the turn to finish; returns the final :class:`~lunos.events.Done`."""
        stream = self.prompt(text, **options)
        done: Done | None = None
        async for event in stream:
            if isinstance(event, Done):
                done = event
        assert done is not None
        return done

    async def abort(self) -> None:
        """Stop the turn in progress. The stream ends with ``Done(aborted=True)``; nothing is raised."""
        self._aborting = True
        await self._t.request("POST", f"/session/{self.id}/abort", params={"directory": None})

    async def fork(self, message_id: str | None = None) -> AsyncSession:
        """A new session with this one's history (up to ``message_id``, if given)."""
        body = {"messageID": message_id} if message_id else {}
        info = await self._t.request("POST", f"/session/{self.id}/fork", params={"directory": None}, json=body)
        fork = AsyncSession(self._client, info, agent=self.agent, model=self.model)
        fork._approval = self._approval
        return fork

    async def messages(self) -> list[Message]:
        """The session's messages, each with its parts (generated models)."""
        from ._http import validate

        data = await self._t.request("GET", f"/session/{self.id}/message", params={"directory": None})
        return [
            Message(
                validate("Message", item["info"]).root,
                [part.root for part in validate("Part", item["parts"], many=True)],
            )
            for item in data
        ]

    async def children(self) -> list[AsyncSession]:
        """Subagent sessions this session started."""
        data = await self._t.request("GET", f"/session/{self.id}/children", params={"directory": None})
        return [AsyncSession(self._client, info) for info in data]

    async def delete(self) -> None:
        await self._t.request("DELETE", f"/session/{self.id}", params={"directory": None})


class Message(NamedTuple):
    """A message and its parts, as generated models (``lunos.types``)."""

    info: models.UserMessage | models.AssistantMessage
    parts: list[Any]
    """``lunos.types.TextPart``, ``ToolPart``, ``FilePart``, … (the members of ``lunos.types.Part``)."""


class PromptStream:
    """The events of one prompt. Iterate it once; ``text`` and ``cost`` are set when it ends."""

    def __init__(
        self, session: AsyncSession, body: dict[str, Any], on_permission: PermissionHandler | None, raise_on_error: bool
    ) -> None:
        self.session = session
        self._body = body
        self._on_permission = on_permission
        self._raise = raise_on_error
        self._started = False
        self.text = ""
        self.cost = 0.0
        self.error: SessionError | None = None

    def __aiter__(self) -> AsyncIterator[PromptEvent]:
        if self._started:
            raise RuntimeError("a prompt's events can only be iterated once")
        self._started = True
        return self._run()

    async def _run(self) -> AsyncIterator[PromptEvent]:
        session = self.session
        client = session._client
        t = session._t
        root = session.id
        await client._ensure_tools(t)
        mode, _ = await resolve_approval(t, self._body.get("agent") or session.agent, session._approval)
        session._aborting = False

        sessions = {root}
        tools_seen: dict[str, str] = {}
        texts: dict[str, dict[str, str]] = {}
        last_message = ""
        busy = False
        ending = False
        waiting = False
        errors: list[SessionError] = []

        events = t.sse("/event", params={"directory": None}).__aiter__()
        try:
            # Subscribed once the server says so; only then prompt, or the first events are missed.
            first = await asyncio.wait_for(events.__anext__(), 30)
            if first.get("type") != "server.connected":
                raise SessionError("EventStreamError", f"unexpected first event {first.get('type')!r}")
            await t.request("POST", f"/session/{root}/prompt_async", params={"directory": None}, json=self._body)

            while True:
                try:
                    event = await (asyncio.wait_for(events.__anext__(), 2) if ending else events.__anext__())
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break
                kind = event.get("type")
                props = event.get("properties") or {}

                if kind == "session.created":
                    info = props.get("info") or {}
                    if info.get("parentID") in sessions:
                        sessions.add(info["id"])
                        yield SubagentStarted(info["id"], True, event, info["parentID"], info.get("title") or "")
                    continue

                if kind == "message.part.delta":
                    sid = props.get("sessionID")
                    if sid in sessions and props.get("field") == "text":
                        yield TextDelta(
                            sid,
                            sid != root,
                            event,
                            props.get("delta", ""),
                            props.get("partID", ""),
                            props.get("messageID", ""),
                        )
                    continue

                if kind == "message.part.updated":
                    part = props.get("part") or {}
                    sid = part.get("sessionID")
                    if sid not in sessions:
                        continue
                    sub = sid != root
                    ptype = part.get("type")
                    if ptype == "text" and (part.get("time") or {}).get("end") and not part.get("synthetic"):
                        if not sub:
                            texts.setdefault(part["messageID"], {})[part["id"]] = part.get("text", "")
                            last_message = part["messageID"]
                        yield Text(sid, sub, event, part.get("text", ""), part["id"], part["messageID"])
                    elif ptype == "reasoning" and (part.get("time") or {}).get("end"):
                        yield Reasoning(sid, sub, event, part.get("text", ""), part["id"])
                    elif ptype == "tool":
                        state = part.get("state") or {}
                        status = state.get("status", "pending")
                        call_id = part.get("callID") or part["id"]
                        if status == "pending" or tools_seen.get(call_id) == status:
                            continue
                        tools_seen[call_id] = status
                        yield ToolCall(
                            sid,
                            sub,
                            event,
                            call_id,
                            part.get("tool", ""),
                            status,
                            state.get("input") or {},
                            state.get("output"),
                            state.get("error"),
                            state.get("title"),
                        )
                    elif ptype == "step-finish":
                        cost = float(part.get("cost") or 0)
                        self.cost += cost
                        yield StepFinished(sid, sub, event, part.get("reason", ""), cost, part.get("tokens") or {})
                    continue

                if kind == "permission.asked":
                    sid = props.get("sessionID")
                    if sid not in sessions:
                        continue
                    request = PermissionRequest(
                        sid,
                        sid != root,
                        event,
                        props["id"],
                        props.get("permission", ""),
                        list(props.get("patterns") or []),
                        dict(props.get("metadata") or {}),
                        list(props.get("always") or []),
                        (props.get("tool") or {}).get("callID"),
                    )
                    if mode == "auto":
                        await session._reply(request, "once")
                        yield PermissionRequest(**{**request.__dict__, "auto_approved": True})
                        continue
                    if self._on_permission:
                        answer = self._on_permission(request)
                        if inspect.isawaitable(answer):
                            answer = await answer
                        if answer is not None:
                            reply: PermissionReply = (
                                "once" if answer is True else "reject" if answer is False else answer  # type: ignore[assignment]
                            )
                            await session._reply(request, reply)
                    yield request
                    continue

                if kind == "session.error":
                    sid = props.get("sessionID")
                    if sid not in sessions:
                        continue
                    error = from_session_error(props.get("error"), sid)
                    if session._aborting and error.name == "MessageAbortedError":
                        continue
                    if sid == root and not any(e.message == error.message for e in errors):
                        errors.append(error)
                        if not busy:
                            ending = True
                    yield Error(sid, sid != root, event, error.name, error.message)
                    continue

                if kind == "session.status" and props.get("sessionID") == root:
                    status = (props.get("status") or {}).get("type")
                    if status != "idle":
                        busy = True
                        waiting = False
                        continue
                    if busy and not await _subagents_running(t, root):
                        break
                    waiting = busy
                    continue

                # Idle with background subagents still running: check again on the server's heartbeat.
                if kind == "server.heartbeat" and waiting and not await _subagents_running(t, root):
                    break
        finally:
            await _close(events)

        self.text = "".join(texts.get(last_message, {}).values()).strip()
        aborted = session._aborting
        self.error = errors[0] if errors and not aborted else None
        yield Done(root, False, {}, self.text, self.cost, aborted)
        if self.error and self._raise:
            raise self.error


async def _subagents_running(t: AsyncTransport, root: str) -> bool:
    """Background subagents still running (XCOD-287): the turn isn't over until they finish."""
    try:
        jobs = await t.request("GET", "/experimental/background", params={"directory": None, "sessionID": root})
    except APIError:
        return False  # a server without background subagents
    return any(job.get("status") == "running" for job in jobs or [])


async def _close(events: AsyncIterator[Any]) -> None:
    aclose = getattr(events, "aclose", None)
    if aclose:
        try:
            await aclose()
        except (RuntimeError, asyncio.CancelledError):
            pass
