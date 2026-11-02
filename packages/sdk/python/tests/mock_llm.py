"""A scripted OpenAI-compatible model for end-to-end tests.

It is stateless; the conversation it is sent decides the reply:

- If the last message is a tool result, it answers ``result: <tool output>``.
- If the last user message has a line ``CALL <tool> <json arguments>``, it calls the tool whose name
  ends with ``<tool>`` (MCP tools are exposed with a server prefix), with those arguments.
- Otherwise it answers ``echo: <the user's text>``.
"""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(item.get("text", "") for item in content if isinstance(item, dict))
    return ""


def _plan(body: dict[str, Any]) -> dict[str, Any]:
    messages = body.get("messages", [])
    last = messages[-1] if messages else {}
    if last.get("role") == "tool":
        return {"text": f"result: {_text(last.get('content'))}"}
    user = next((m for m in reversed(messages) if m.get("role") == "user"), {})
    text = _text(user.get("content"))
    # `lunos run` quotes a message argument that has spaces in it ("...", inner quotes escaped).
    if text.startswith('"'):
        quoted = text.split("\n")[0]
        if quoted.endswith('"'):
            text = quoted[1:-1].replace('\\"', '"') + text[len(quoted) :]
    tools = [t["function"]["name"] for t in body.get("tools", []) if t.get("type") == "function"]
    for line in text.splitlines():
        if not line.startswith("CALL "):
            continue
        _, wanted, *rest = line.split(" ", 2)
        name = next((t for t in tools if t == wanted or t.endswith(wanted)), None)
        if name is None:
            return {"text": f"no tool named {wanted}; have {', '.join(tools)}"}
        return {"tool": name, "arguments": rest[0] if rest else "{}"}
    # Lunos appends <system-reminder> blocks to the user's message; echo only what the user wrote.
    return {"text": f"echo: {text.split('<system-reminder>')[0].strip()}"}


class _Handler(BaseHTTPRequestHandler):
    server: MockLLM.Server

    def log_message(self, format: str, *args: Any) -> None:
        pass

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        self.server.owner.requests.append(body)
        plan = _plan(body)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.end_headers()
        base = {
            "id": "chatcmpl-mock",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": body.get("model", "mock"),
        }

        def chunk(delta: dict[str, Any], finish: str | None = None, usage: dict[str, int] | None = None) -> None:
            payload = {**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            if usage:
                payload["usage"] = usage
            self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode())
            self.wfile.flush()

        if "tool" in plan:
            chunk(
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": f"call_{len(self.server.owner.requests)}",
                            "type": "function",
                            "function": {"name": plan["tool"], "arguments": ""},
                        }
                    ],
                }
            )
            chunk({"tool_calls": [{"index": 0, "function": {"arguments": plan["arguments"]}}]})
            chunk({}, "tool_calls", {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
        else:
            words = plan["text"].split(" ")
            chunk({"role": "assistant", "content": ""})
            for index, word in enumerate(words):
                chunk({"content": word if index == 0 else " " + word})
            chunk({}, "stop", {"prompt_tokens": 10, "completion_tokens": len(words), "total_tokens": 10 + len(words)})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


class MockLLM:
    class Server(ThreadingHTTPServer):
        daemon_threads = True
        owner: MockLLM

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self._server = MockLLM.Server(("127.0.0.1", 0), _Handler)
        self._server.owner = self
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}/v1"

    def __enter__(self) -> MockLLM:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()


def provider_config(url: str) -> dict[str, Any]:
    """Lunos config with one provider, ``test``, and one model, ``test/test-model``, served by the mock."""
    return {
        "formatter": False,
        "lsp": False,
        "share": "disabled",
        "autoupdate": False,
        "workflows": {"dynamic": False},
        "model": "test/test-model",
        "small_model": "test/test-model",
        "provider": {
            "test": {
                "name": "Test",
                "id": "test",
                "env": [],
                "npm": "@ai-sdk/openai-compatible",
                "models": {
                    "test-model": {
                        "id": "test-model",
                        "name": "Test Model",
                        "attachment": True,
                        "modalities": {"input": ["text", "image"], "output": ["text"]},
                        "reasoning": False,
                        "temperature": False,
                        "tool_call": True,
                        "release_date": "2025-01-01",
                        "limit": {"context": 100000, "output": 10000},
                        "cost": {"input": 0, "output": 0},
                        "options": {},
                    }
                },
                "options": {"apiKey": "test-key", "baseURL": url},
            }
        },
    }
