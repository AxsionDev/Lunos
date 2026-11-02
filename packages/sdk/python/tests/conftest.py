from __future__ import annotations

import copy
import json
import os
import shutil
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from mock_llm import MockLLM, provider_config  # noqa: E402

HAVE_LUNOS = bool(os.environ.get("LUNOS_COMMAND") or shutil.which("lunos"))


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if HAVE_LUNOS:
        return
    skip = pytest.mark.skip(reason="needs the lunos binary on PATH, or LUNOS_COMMAND")
    for item in items:
        if "e2e" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
def llm() -> Iterator[MockLLM]:
    with MockLLM() as server:
        yield server


class Env:
    """An isolated Lunos home (config, data, state, cache) and project, so tests touch nothing of yours."""

    def __init__(self, root: Path, llm: MockLLM) -> None:
        self.root = root
        self.project = root / "project"
        self.project.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.project, check=True)
        (self.project / "README.md").write_text("# test project\n")
        self.managed = root / "managed"
        self.managed.mkdir()
        self.config = provider_config(llm.url)
        # A second model on the same provider, for the model lock.
        other = copy.deepcopy(self.config["provider"]["test"]["models"]["test-model"])
        other["id"] = "other-model"
        self.config["provider"]["test"]["models"]["other-model"] = other
        # A provider with no recorded jurisdiction, for the residency policy. It is never reached.
        us = copy.deepcopy(self.config["provider"]["test"])
        us.update(id="elsewhere", name="Elsewhere", options={"apiKey": "k", "baseURL": "https://llm.example.com/v1"})
        self.config["provider"]["elsewhere"] = us
        self.vars = {
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_STATE_HOME": str(root / "state"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "OPENCODE_TEST_MANAGED_CONFIG_DIR": str(self.managed),
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "true",
        }

    def lock(self, policy: dict[str, Any]) -> None:
        """Managed config (an organisation's policy), as MDM would deploy it."""
        (self.managed / "managed.json").write_text(json.dumps(policy))

    def with_config(self, **extra: Any) -> dict[str, Any]:
        return {**self.config, **extra}

    def child_env(self, **extra: Any) -> dict[str, str]:
        """For processes that read the config from the environment (``lunos.run``)."""
        return {**self.vars, "OPENCODE_CONFIG_CONTENT": json.dumps(self.with_config(**extra))}


@pytest.fixture
def env(tmp_path: Path, llm: MockLLM) -> Env:
    return Env(tmp_path, llm)
