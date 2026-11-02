"""HTTP transport: auth, the ``directory`` every instance-scoped call needs, errors, and SSE."""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Iterator
from functools import cache
from typing import Any

import httpx

from ._errors import from_response


def auth_headers(token: str | None, username: str = "opencode") -> dict[str, str]:
    """The server accepts HTTP basic auth: ``OPENCODE_SERVER_USERNAME`` (default ``opencode``) and the password."""
    if not token:
        return {}
    encoded = base64.b64encode(f"{username}:{token}".encode()).decode()
    return {"Authorization": f"Basic {encoded}"}


def _clean(params: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in (params or {}).items():
        if value is None:
            continue
        out[key] = (
            json.dumps(value)
            if isinstance(value, (dict, list))
            else str(value).lower()
            if isinstance(value, bool)
            else value
        )
    return out


def _body(json_body: Any) -> Any:
    if json_body is None:
        return None
    if hasattr(json_body, "model_dump"):
        return json_body.model_dump(mode="json", exclude_none=True, by_alias=True)
    return json_body


def _decode(response: httpx.Response, raw: bool) -> Any:
    if response.status_code >= 400:
        try:
            body = response.json()
        except ValueError:
            body = None
        raise from_response(response.status_code, body, response.text)
    if raw:
        return response.content
    if response.status_code == 204 or not response.content:
        return None
    if "json" not in response.headers.get("content-type", "json"):
        return response.text
    return response.json()


def _events(lines: Iterator[str]) -> Iterator[dict[str, Any]]:
    data: list[str] = []
    for line in lines:
        if line == "":
            if data:
                yield json.loads("\n".join(data))
                data = []
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip(" "))


class _Base:
    def __init__(self, base_url: str, headers: dict[str, str], directory: str | None) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = headers
        self.directory = directory
        self.workspace: str | None = None

    def _params(self, method: str, path: str, params: dict[str, Any] | None) -> dict[str, Any]:
        params = dict(params or {})
        for key, value in (("directory", self.directory), ("workspace", self.workspace)):
            if not value:
                continue
            # Instances are per directory: an instance-scoped call without one lands on the server's own.
            if key in params and params[key] is None:
                params[key] = value
            # The v2 API (/api/...) reads its location from the query, like the JavaScript SDK sends it.
            if method == "GET" and path.startswith("/api/"):
                params.setdefault(key, value)
                params.setdefault(f"location[{key}]", value)
        return _clean(params)


class AsyncTransport(_Base):
    def __init__(
        self,
        base_url: str,
        headers: dict[str, str],
        directory: str | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(base_url, headers, directory)
        self.client = client or httpx.AsyncClient(base_url=self.base_url, headers=headers, timeout=httpx.Timeout(60.0))

    def scoped(self, directory: str | None) -> AsyncTransport:
        """The same connection, for another directory."""
        scoped = AsyncTransport(self.base_url, self.headers, directory, self.client)
        scoped.workspace = self.workspace
        return scoped

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        timeout: float | None = None,
        raw: bool = False,
    ) -> Any:
        response = await self.client.request(
            method,
            path,
            params=self._params(method, path, params),
            json=_body(json),
            timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT,
        )
        return _decode(response, raw)

    async def sse(
        self, path: str, *, params: dict[str, Any] | None = None, timeout: float | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        async with self.client.stream(
            "GET", path, params=self._params("GET", path, params), timeout=httpx.Timeout(timeout, connect=30.0)
        ) as response:
            if response.status_code >= 400:
                await response.aread()
                _decode(response, False)
            data: list[str] = []
            async for line in response.aiter_lines():
                if line == "":
                    if data:
                        yield json.loads("\n".join(data))
                        data = []
                    continue
                if line.startswith("data:"):
                    data.append(line[5:].lstrip(" "))

    async def aclose(self) -> None:
        await self.client.aclose()


class SyncTransport(_Base):
    def __init__(
        self, base_url: str, headers: dict[str, str], directory: str | None = None, client: httpx.Client | None = None
    ) -> None:
        super().__init__(base_url, headers, directory)
        self.client = client or httpx.Client(base_url=self.base_url, headers=headers, timeout=httpx.Timeout(60.0))

    def scoped(self, directory: str | None) -> SyncTransport:
        scoped = SyncTransport(self.base_url, self.headers, directory, self.client)
        scoped.workspace = self.workspace
        return scoped

    def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        timeout: float | None = None,
        raw: bool = False,
    ) -> Any:
        response = self.client.request(
            method,
            path,
            params=self._params(method, path, params),
            json=_body(json),
            timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT,
        )
        return _decode(response, raw)

    def sse(
        self, path: str, *, params: dict[str, Any] | None = None, timeout: float | None = None
    ) -> Iterator[dict[str, Any]]:
        with self.client.stream(
            "GET", path, params=self._params("GET", path, params), timeout=httpx.Timeout(timeout, connect=30.0)
        ) as response:
            if response.status_code >= 400:
                response.read()
                _decode(response, False)
            yield from _events(response.iter_lines())

    def close(self) -> None:
        self.client.close()


@cache
def _adapter(name: str, many: bool) -> Any:
    from pydantic import TypeAdapter

    from ._generated import models

    model = getattr(models, name)
    return TypeAdapter(list[model] if many else model)  # pyright: ignore[reportInvalidTypeForm]


def validate(name: str, data: Any, many: bool = False) -> Any:
    """Parse a response into its generated pydantic model (unknown fields are kept)."""
    return _adapter(name, many).validate_python(data)
