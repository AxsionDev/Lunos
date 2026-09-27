"""Lunos as a Harbor agent (XCOD-119).

Harbor's opencode agent already speaks `run --format=json` and parses its events into a
trajectory. Lunos keeps that CLI surface, so this adapter only changes three things:

- installs the `lunos-ai` npm package and exposes `lunos` under the name Harbor invokes;
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
from typing import override

from harbor.agents.installed.opencode import OpenCode
from harbor.agents.model_connection import ResolvedModelConnection
from harbor.environments.base import BaseEnvironment

PROXY_KEY = "via-lunos-eval-proxy"


class Lunos(OpenCode):
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
        return "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; lunos --version"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "coreutils", "nodejs", "npm")
        )
        version = self._version or "latest"
        # npm 12 skips install scripts unless allowed; lunos-ai's postinstall fetches the binary.
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                "if [ -f ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
                f"npm i -g lunos-ai@{version} --allow-scripts=lunos-ai && lunos --version"
            ),
        )
        result = await self.exec_as_agent(
            environment,
            command="[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; command -v lunos",
        )
        lunos = (result.stdout or "").strip().splitlines()[-1]
        # Harbor's opencode agent runs `opencode ...`; point that name at Lunos.
        await self.exec_as_root(environment, command=f"ln -sf {lunos} /usr/local/bin/opencode")
