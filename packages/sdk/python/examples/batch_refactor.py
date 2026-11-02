"""One refactor across many repositories, a session per repository, in parallel.

    python batch_refactor.py ~/src/service-a ~/src/service-b ~/src/service-c

One local Lunos server serves them all (sessions are per directory). Edits are approved
automatically; anything else the agent asks for (shell commands, web access, …) is refused and
printed, so a run never stops to wait for you.
"""

import asyncio
import sys
from pathlib import Path

import lunos
from lunos.events import PermissionRequest

REFACTOR = (
    "Replace every use of the deprecated `requests` session helper `make_session()` with "
    "`httpx.Client()`, keeping timeouts and headers. Update imports. Don't touch tests' fixtures."
)


def edits_only(request: PermissionRequest) -> bool:
    return request.permission in ("edit", "write")


async def refactor(client: lunos.AsyncLunos, repo: Path) -> tuple[Path, str]:
    session = await client.sessions.create(agent="build", directory=repo, title="batch refactor")
    refused: list[str] = []
    async for event in session.prompt(REFACTOR, on_permission=edits_only, raise_on_error=False):
        if isinstance(event, PermissionRequest) and not edits_only(event):
            refused.append(f"{event.permission} {' '.join(event.patterns)}")
        if isinstance(event, lunos.events.Done):
            summary = event.text.splitlines()[0] if event.text else "(no reply)"
            return repo, summary + (f"; refused: {', '.join(refused)}" if refused else "")
    return repo, "(no result)"


async def main(repos: list[Path]) -> None:
    async with await lunos.AsyncLunos.start() as client:
        for repo, summary in await asyncio.gather(*(refactor(client, repo) for repo in repos)):
            print(f"{repo.name}: {summary}")


if __name__ == "__main__":
    asyncio.run(main([Path(p).resolve() for p in sys.argv[1:]]))
