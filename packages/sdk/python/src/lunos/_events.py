"""What ``session.prompt()`` streams: a small, stable set of events built from the server's.

Every event has ``session_id`` (the session it happened in) and ``subagent`` (true when that is a
subagent's session, not the one prompted), and ``raw``, the server event it came from.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True)
class Event:
    session_id: str
    subagent: bool
    raw: dict[str, Any] = field(repr=False, compare=False)


@dataclass(frozen=True)
class TextDelta(Event):
    """A piece of the agent's reply, as it is written."""

    text: str
    part_id: str
    message_id: str


@dataclass(frozen=True)
class Text(Event):
    """A finished block of the agent's reply."""

    text: str
    part_id: str
    message_id: str


@dataclass(frozen=True)
class Reasoning(Event):
    """A finished block of the model's reasoning, for models that show it."""

    text: str
    part_id: str


@dataclass(frozen=True)
class ToolCall(Event):
    """A tool call: emitted when it starts (``running``) and when it ends (``completed`` or ``error``)."""

    call_id: str
    tool: str
    status: Literal["pending", "running", "completed", "error"]
    input: dict[str, Any]
    output: str | None = None
    error: str | None = None
    title: str | None = None


@dataclass(frozen=True)
class PermissionRequest(Event):
    """The agent asks to do something an ``ask`` rule covers.

    In manual approval mode the turn waits until you answer with ``session.approve(request)`` or
    ``session.deny(request)``. In auto mode the SDK has already approved it once
    (``auto_approved``), as the TUI's Auto mode does.
    """

    id: str
    permission: str
    patterns: list[str]
    metadata: dict[str, Any]
    always: list[str]
    call_id: str | None = None
    auto_approved: bool = False


@dataclass(frozen=True)
class SubagentStarted(Event):
    """The agent started a subagent; its events follow with ``subagent=True`` and its ``session_id``."""

    parent_id: str
    title: str


@dataclass(frozen=True)
class StepFinished(Event):
    """A model step ended."""

    reason: str
    cost: float
    tokens: dict[str, Any]


@dataclass(frozen=True)
class Error(Event):
    """The turn failed. ``prompt()`` raises the matching exception after the stream ends."""

    name: str
    message: str


@dataclass(frozen=True)
class Done(Event):
    """The turn finished (the last event). ``text`` is the agent's final reply in the prompted session."""

    text: str
    cost: float
    aborted: bool


PromptEvent = (
    TextDelta | Text | Reasoning | ToolCall | PermissionRequest | SubagentStarted | StepFinished | Error | Done
)
