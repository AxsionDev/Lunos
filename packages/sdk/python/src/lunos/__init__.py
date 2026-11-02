"""Run Lunos agents from Python.

>>> import lunos
>>> with lunos.Lunos.start() as client:
...     session = client.sessions.create(agent="build")
...     for event in session.prompt("Why does the build fail?"):
...         if isinstance(event, lunos.events.PermissionRequest):
...             session.approve(event)
...         elif isinstance(event, lunos.events.TextDelta):
...             print(event.text, end="")

- :class:`Lunos` (blocking) and :class:`AsyncLunos`: ``start()`` a local server or ``connect()``
  to a running one; ``client.sessions`` is the high-level API, ``client.api`` every server
  operation, generated from the server's OpenAPI spec.
- :func:`tool`: a Python function the agent can call.
- :func:`run`: a headless, unattended run with hard limits, like ``lunos agent run``.
- :func:`tui`: open the Lunos TUI in this terminal.
- :mod:`lunos.events`: what ``session.prompt()`` streams. :mod:`lunos.types`: the server's models.
"""

from . import events
from ._client import AsyncLunos, AsyncSessions, check_compatible
from ._errors import (
    APIError,
    AuthenticationError,
    IncompatibleServerError,
    LunosCompatibilityWarning,
    LunosError,
    NotFoundError,
    PolicyLockedError,
    ResidencyError,
    ServerStartError,
    SessionError,
)
from ._run import Denied, RunReport, arun, run
from ._server import tui
from ._session import ApprovalMode, AsyncSession, File, Message, PromptStream
from ._sync import Lunos, Session, Sessions, SyncPromptStream
from ._tools import Tool, tool
from ._version import API_VERSION, __version__

__all__ = [
    "API_VERSION",
    "APIError",
    "ApprovalMode",
    "AsyncLunos",
    "AsyncSession",
    "AsyncSessions",
    "AuthenticationError",
    "Denied",
    "File",
    "IncompatibleServerError",
    "Lunos",
    "LunosCompatibilityWarning",
    "LunosError",
    "Message",
    "NotFoundError",
    "PolicyLockedError",
    "PromptStream",
    "ResidencyError",
    "RunReport",
    "ServerStartError",
    "Session",
    "SessionError",
    "Sessions",
    "SyncPromptStream",
    "Tool",
    "__version__",
    "arun",
    "check_compatible",
    "events",
    "run",
    "tool",
    "tui",
]
