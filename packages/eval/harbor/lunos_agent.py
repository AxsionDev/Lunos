"""Lunos as a Harbor agent (XCOD-119).

Harbor's opencode agent already speaks `run --format=json` and parses its events into a
trajectory. Lunos keeps that CLI surface, so this adapter only changes three things:

- copies in the release binary (and ripgrep), prepared on the host, under the name Harbor invokes;
- runs with LUNOS_OFFLINE=1, so the agent can't fetch published solutions with webfetch;
- never lets a real API key into the task container: keys live in the eval metering proxy, and
  the provider's baseURL (set through `opencode_config` in the job file) points at that proxy.

Use it from a Harbor job config:

    agents:
      - import_path: lunos_agent:Lunos
        model_name: mistral/devstral-medium
        kwargs:
          version: "1.18.40"
          opencode_config: {...}   # written by packages/eval/src/job.ts
"""

import dataclasses
import os
from pathlib import Path
from typing import override

from harbor.agents.installed.opencode import OpenCode
from harbor.agents.model_connection import ResolvedModelConnection
from harbor.environments.base import BaseEnvironment

PROXY_KEY = "via-lunos-eval-proxy"


class Lunos(OpenCode):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # Set by src/cli.ts; an environment variable because Harbor validates agent kwargs against
        # its opencode agent's schema.
        self._binaries = os.environ.get("LUNOS_EVAL_BINARIES")

    @property
    @override
    def model_connection(self) -> ResolvedModelConnection:
        access = super().model_connection
        env = {
            name: (PROXY_KEY if name.endswith(("_API_KEY", "_TOKEN")) else value)
            for name, value in access.env.items()
        }
        env["LUNOS_OFFLINE"] = "1"
        return dataclasses.replace(access, api_key=PROXY_KEY, env=env)

    @override
    def get_version_command(self) -> str | None:
        return "lunos --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # XCOD-200: the release binary and ripgrep, prepared and verified on the host
        # (src/agent-bin.ts), are copied in. Installing in the container with apt nodejs npm and
        # `npm i -g lunos-ai` failed on the Ubuntu 22.04 task images (Node 12) and used most of
        # Harbor's agent-setup time. ripgrep: offline mode can't download it, and Lunos's grep
        # and glob tools need it.
        if not self._binaries:
            raise ValueError("Lunos agent: LUNOS_EVAL_BINARIES (the directory with lunos and rg) is not set")
        for name in ("lunos", "rg"):
            await environment.upload_file(str(Path(self._binaries) / name), f"/usr/local/bin/{name}")
        # Harbor's opencode agent runs `opencode ...`; point that name at Lunos.
        await self.exec_as_root(
            environment,
            command=(
                "chmod 755 /usr/local/bin/lunos /usr/local/bin/rg && "
                "ln -sf /usr/local/bin/lunos /usr/local/bin/opencode && lunos --version"
            ),
        )
