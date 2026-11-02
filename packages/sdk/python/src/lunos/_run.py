"""Headless runs: ``lunos.run()``, the SDK's ``lunos agent run`` (XCOD-211).

It runs ``lunos agent run`` itself, so a run from Python has the unattended runner's exact
behaviour: hard limits on time, spend and steps (subagents included), nothing auto-approved (each
refused permission is reported), the optional Docker sandbox, the audit event, and the same report
with the same exit reasons.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from ._errors import LunosError
from ._server import lunos_command

Reason = Literal["completed", "failed", "time", "cost", "steps", "budget"]
"""Why a run ended: it finished, it failed, or a limit stopped it (``budget``: a project or
organisation budget, XCOD-298). A run stopped by its own limit is ``ok`` with partial results."""

_REPORT = re.compile(r"^\s*report: (.+?)\s*$", re.MULTILINE)


@dataclass(frozen=True)
class Denied:
    permission: str
    patterns: list[str]


@dataclass(frozen=True)
class RunReport:
    """The unattended runner's report (``AgentUnattended.Report``)."""

    agent: str
    status: Literal["ok", "failed"]
    reason: Reason
    started: str
    finished: str
    seconds: float
    steps: int
    cost: float
    limits: dict[str, float]
    sandbox: bool
    denied: list[Denied]
    edited: list[str]
    exit_code: int | None
    session: str | None = None
    results: str | None = None
    error: str | None = None
    job: str | None = None
    file: str | None = None
    output: str = field(default="", repr=False)

    @property
    def ok(self) -> bool:
        return self.status == "ok"

    @classmethod
    def from_json(cls, data: Mapping[str, Any], file: str | None = None, output: str = "") -> RunReport:
        return cls(
            agent=data["agent"],
            status=data["status"],
            reason=data["reason"],
            started=data["started"],
            finished=data["finished"],
            seconds=float(data["seconds"]),
            steps=int(data["steps"]),
            cost=float(data["cost"]),
            limits=dict(data.get("limits") or {}),
            sandbox=bool(data.get("sandbox")),
            denied=[Denied(d["permission"], list(d.get("patterns") or [])) for d in data.get("denied") or []],
            edited=list(data.get("edited") or []),
            exit_code=data.get("exitCode"),
            session=data.get("session"),
            results=data.get("results"),
            error=data.get("error"),
            job=data.get("job"),
            file=file,
            output=output,
        )


def _seconds(value: float | str) -> str:
    return f"{value:g}s" if isinstance(value, (int, float)) else str(value)


def run_args(
    prompt: str,
    *,
    agent: str = "build",
    budget: float = 2.0,
    max_steps: int = 50,
    max_time: float | str = "30m",
    sandbox: bool = True,
    notify: str | None = None,
    command: str | Sequence[str] | None = None,
) -> list[str]:
    if not prompt:
        raise ValueError("an unattended run needs a prompt: nobody is there to ask")
    if budget <= 0 or max_steps <= 0:
        raise ValueError("budget and max_steps must be above zero")
    args = [
        *lunos_command(command),
        "agent",
        "run",
        agent,
        "--prompt",
        prompt,
        "--max-cost",
        f"{budget:g}",
        "--max-steps",
        str(max_steps),
        "--max-time",
        _seconds(max_time),
        "--sandbox" if sandbox else "--no-sandbox",
    ]
    if notify:
        args += ["--notify", notify]
    return args


def run(
    prompt: str,
    *,
    agent: str = "build",
    budget: float = 2.0,
    max_steps: int = 50,
    max_time: float | str = "30m",
    sandbox: bool = True,
    directory: str | os.PathLike[str] | None = None,
    notify: str | None = None,
    command: str | Sequence[str] | None = None,
    env: Mapping[str, str] | None = None,
) -> RunReport:
    """Run an agent unattended, like ``lunos agent run``, and return its report.

    - ``budget``: stop once model spend passes this (the run's ``--max-cost``);
    - ``max_steps``: stop after this many model steps, subagents included;
    - ``max_time``: seconds, or ``"90s"``, ``"30m"``, ``"2h"``;
    - ``sandbox``: run in a Docker sandbox (the default, as for ``lunos agent run``; needs Docker),
      or directly in ``directory`` with ``sandbox=False``.

    Nothing is auto-approved: every permission prompt is refused and listed in ``report.denied``.
    A run stopped by a limit is ``ok``, with ``reason`` saying which. The report is also saved
    where ``lunos agent run`` saves it (``report.file``).
    """
    args = run_args(
        prompt,
        agent=agent,
        budget=budget,
        max_steps=max_steps,
        max_time=max_time,
        sandbox=sandbox,
        notify=notify,
        command=command,
    )
    cwd = os.path.abspath(directory or os.getcwd())
    completed = subprocess.run(
        args,
        cwd=cwd,
        # The npm launcher starts Lunos in $PWD when it is set, so it must name the run's directory.
        env={**os.environ, **(env or {}), "PWD": cwd},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return _report(completed.stdout, completed.stderr, completed.returncode)


async def arun(prompt: str, **options: Any) -> RunReport:
    """:func:`run`, without blocking the event loop."""
    return await asyncio.to_thread(run, prompt, **options)


def _report(stdout: str, stderr: str, code: int) -> RunReport:
    output = stdout + stderr
    match = _REPORT.search(output)
    if not match:
        tail = "\n".join(output.strip().splitlines()[-10:])
        raise LunosError(f"lunos agent run didn't produce a report (exit code {code}):\n{tail}")
    file = match.group(1)
    return RunReport.from_json(json.loads(Path(file).read_text(encoding="utf-8")), file, output)
