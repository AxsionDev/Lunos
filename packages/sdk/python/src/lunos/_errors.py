"""Errors the SDK raises."""

from __future__ import annotations

from typing import Any

POLICY_SUFFIX = " is set by your organisation's policy and can't be changed here"


class LunosError(Exception):
    """Base class for every error the SDK raises."""


class ServerStartError(LunosError):
    """``Lunos.start()`` couldn't start a local server."""


class IncompatibleServerError(LunosError):
    """The server's API version can't be used with this SDK version."""


class LunosCompatibilityWarning(UserWarning):
    """The server is older than the SDK: newer operations may be missing."""


class APIError(LunosError):
    """The server answered with an error status."""

    def __init__(self, status: int, name: str, message: str, data: Any = None) -> None:
        super().__init__(f"{status} {name}: {message}" if name else f"{status}: {message}")
        self.status = status
        self.name = name
        self.message = message
        self.data = data


class AuthenticationError(APIError):
    """401: the server needs a password (``token``) and it was missing or wrong."""


class NotFoundError(APIError):
    """404."""


class PolicyLockedError(APIError):
    """The organisation's policy locks this setting (``key``); the same refusal the TUI shows.

    Raised for a locked model, a locked approval mode, and any other ``$locked`` key the server
    refuses. ``key`` is the locked key, e.g. ``model`` or ``agent.build.permission_mode``.
    """

    def __init__(self, key: str, message: str, status: int = 403) -> None:
        super().__init__(status, "PolicyLockedError", message, {"key": key, "message": message})
        self.key = key


class SessionError(LunosError):
    """The agent's turn failed (``session.error``): a provider error, a refused model, …"""

    def __init__(self, name: str, message: str, data: Any = None, session_id: str | None = None) -> None:
        super().__init__(f"{name}: {message}" if name else message)
        self.name = name
        self.message = message
        self.data = data
        self.session_id = session_id


class ResidencyError(SessionError):
    """The data-residency policy refused the model's provider: no request was sent to it."""


def policy_message(key: str) -> str:
    """The one message every refused override shows (``ConfigPolicy.message`` on the server)."""
    return key + POLICY_SUFFIX


def from_response(status: int, body: Any, text: str) -> APIError:
    name = ""
    message = text or f"HTTP {status}"
    data: Any = body
    if isinstance(body, dict):
        name = str(body.get("name") or body.get("_tag") or "")
        inner = body.get("data")
        if isinstance(inner, dict) and inner.get("message"):
            message = str(inner["message"])
        elif body.get("message"):
            message = str(body["message"])
        if name == "PolicyLockedError" and isinstance(inner, dict):
            return PolicyLockedError(str(inner.get("key", "")), message, status)
    if status == 401:
        return AuthenticationError(status, name or "Unauthorized", "the server needs a valid token", data)
    if status == 404:
        return NotFoundError(status, name or "NotFound", message, data)
    return APIError(status, name, message, data)


def from_session_error(error: dict[str, Any] | None, session_id: str | None) -> SessionError:
    error = error or {}
    name = str(error.get("name", "UnknownError"))
    data = error.get("data")
    message = str(data.get("message")) if isinstance(data, dict) and data.get("message") else name
    first = message.splitlines()[0] if message else message
    # A locked key is refused with ConfigPolicy.message(key); asynchronously it arrives as a session error.
    if POLICY_SUFFIX in first:
        key = first.split(POLICY_SUFFIX)[0].removeprefix("PolicyLockedError: ").strip()
        return _PolicyLockedSessionError(key, first, session_id)
    if "residency policy" in message:
        return ResidencyError(name, message, data, session_id)
    return SessionError(name, message, data, session_id)


class _PolicyLockedSessionError(PolicyLockedError, SessionError):
    """A lock refused asynchronously, during a prompt: both a policy refusal and a failed turn."""

    def __init__(self, key: str, message: str, session_id: str | None) -> None:
        Exception.__init__(self, f"403 PolicyLockedError: {message}")
        self.status = 403
        self.name = "PolicyLockedError"
        self.message = message
        self.data = {"key": key, "message": message}
        self.key = key
        self.session_id = session_id
