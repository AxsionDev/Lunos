"""Starting a local Lunos server (``lunos serve``) for ``Lunos.start()``."""

from __future__ import annotations

import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from collections.abc import Mapping, Sequence
from typing import Any

from ._errors import ServerStartError

# `lunos serve` prints this exact line once it listens (packages/opencode/src/cli/cmd/serve.ts).
_READY = re.compile(r"^opencode server listening on (https?://\S+)")


def lunos_command(command: str | Sequence[str] | None = None) -> list[str]:
    """The command that runs Lunos: ``command``, else ``$LUNOS_COMMAND``, else ``lunos`` on PATH."""
    if command is None:
        command = os.environ.get("LUNOS_COMMAND")
    if isinstance(command, str):
        return shlex.split(command, posix=sys.platform != "win32")
    if command:
        return list(command)
    found = shutil.which("lunos")
    if not found:
        raise ServerStartError(
            "The lunos command isn't installed (or isn't on PATH). Install Lunos (https://lunos.tech), "
            "pass command=..., or set LUNOS_COMMAND."
        )
    return [found]


def stop(process: subprocess.Popen[Any], grace: float = 5.0) -> None:
    """Stop a process and its children (a tree kill on Windows, where terminate() leaves them)."""
    if process.poll() is not None:
        return
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/pid", str(process.pid), "/T", "/F"], capture_output=True)
    else:
        process.terminate()
    try:
        process.wait(grace)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(grace)


class LocalServer:
    """A ``lunos serve`` child process, secured with a random password unless one is given."""

    def __init__(self, process: subprocess.Popen[str], url: str, password: str | None, output: deque[str]) -> None:
        self.process = process
        self.url = url
        self.password = password
        self._output = output

    @property
    def output(self) -> str:
        """The server's recent output (stdout and stderr), for diagnostics."""
        return "".join(self._output)

    @classmethod
    def start(
        cls,
        *,
        command: str | Sequence[str] | None = None,
        hostname: str = "127.0.0.1",
        port: int = 0,
        directory: str | None = None,
        config: Mapping[str, Any] | None = None,
        env: Mapping[str, str] | None = None,
        password: str | None = None,
        timeout: float = 60.0,
    ) -> LocalServer:
        argv = [*lunos_command(command), "serve", f"--hostname={hostname}", f"--port={port}"]
        child_env = {**os.environ, **(env or {})}
        if directory:
            # The npm launcher starts Lunos in $PWD when it is set, whatever the process's cwd.
            directory = os.path.abspath(directory)
            child_env["PWD"] = directory
        password = password or secrets.token_urlsafe(24)
        child_env["OPENCODE_SERVER_PASSWORD"] = password
        child_env["OPENCODE_SERVER_USERNAME"] = "opencode"
        if config is not None:
            child_env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
        try:
            process = subprocess.Popen(
                argv,
                cwd=directory,
                env=child_env,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if sys.platform == "win32" else 0,
            )
        except OSError as error:
            raise ServerStartError(f"couldn't run {argv[0]}: {error}") from error

        output: deque[str] = deque(maxlen=200)
        ready = threading.Event()
        found: list[str] = []

        def pump() -> None:
            # Keep reading for the server's lifetime: a full pipe would block it.
            assert process.stdout is not None
            for line in process.stdout:
                output.append(line)
                match = _READY.match(line.strip())
                if match and not found:
                    found.append(match.group(1))
                    ready.set()
            ready.set()

        threading.Thread(target=pump, name="lunos-serve-output", daemon=True).start()
        deadline = time.monotonic() + timeout
        while not ready.wait(0.1):
            if time.monotonic() > deadline:
                stop(process)
                raise ServerStartError(f"the server didn't start within {timeout:g}s:\n{''.join(output)}")
        if not found:
            stop(process)
            raise ServerStartError(f"the server exited with code {process.poll()}:\n{''.join(output)}")
        return cls(process, found[0], password, output)

    def close(self) -> None:
        stop(self.process)


def tui(
    *,
    project: str | os.PathLike[str] | None = None,
    model: str | None = None,
    session: str | None = None,
    agent: str | None = None,
    config: Mapping[str, Any] | None = None,
    command: str | Sequence[str] | None = None,
) -> subprocess.Popen[bytes]:
    """Open the Lunos TUI in this terminal (``createOpencodeTui`` in the JavaScript SDK).

    Returns the process; ``.wait()`` for it to exit. ``session`` opens that session, ``model`` is
    ``"provider/model"``.
    """
    argv = lunos_command(command)
    if project:
        argv.append(f"--project={os.fspath(project)}")
    for flag, value in (("model", model), ("session", session), ("agent", agent)):
        if value:
            argv.append(f"--{flag}={value}")
    child_env = dict(os.environ)
    if config is not None:
        child_env["OPENCODE_CONFIG_CONTENT"] = json.dumps(config)
    return subprocess.Popen(argv, env=child_env)
