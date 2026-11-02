"""End to end: a real Lunos server (``lunos serve``) driven by the SDK, with a scripted model.

The model is tests/mock_llm.py: ``CALL <tool> <json>`` in a prompt makes it call that tool, and it
answers ``result: <output>`` once the tool has run, or ``echo: <prompt>`` otherwise.
"""

from __future__ import annotations

import base64
import json

import pytest
from conftest import Env
from mock_llm import MockLLM

import lunos
from lunos.events import Done, Error, PermissionRequest, SubagentStarted, Text, TextDelta, ToolCall

pytestmark = pytest.mark.e2e

ASK_BASH = [{"permission": "bash", "pattern": "*", "action": "ask"}]
BASH = 'CALL bash {"command": "echo hello-from-bash", "description": "Say hello"}'


@lunos.tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


@lunos.tool
async def shout(text: str) -> dict[str, str]:
    """Upper-case some text (an async tool returning JSON)."""
    return {"shouted": text.upper()}


@lunos.tool
def broken() -> str:
    """Always fails."""
    raise RuntimeError("the tool broke")


def start(env: Env, **options: object) -> lunos.Lunos:
    return lunos.Lunos.start(directory=env.project, config=env.with_config(), env=env.vars, **options)  # type: ignore[arg-type]


def test_quickstart_streams_a_reply_and_handles_a_permission_request(env: Env) -> None:
    """The README's quick start: a session, a streamed reply, a permission request, done."""
    with start(env) as client:
        assert client.server_version
        session = client.sessions.create(agent="build", model="test/test-model", permission=ASK_BASH)
        seen = []
        for event in session.prompt(BASH):
            seen.append(event)
            if isinstance(event, PermissionRequest):
                assert event.permission == "bash"
                assert event.patterns == ["echo hello-from-bash"]
                session.approve(event)
        kinds = [type(e).__name__ for e in seen]
        assert "PermissionRequest" in kinds
        assert any(isinstance(e, TextDelta) for e in seen)
        tool = [e for e in seen if isinstance(e, ToolCall) and e.status == "completed"]
        assert tool and tool[0].tool == "bash" and "hello-from-bash" in (tool[0].output or "")
        done = seen[-1]
        assert isinstance(done, Done)
        assert done.text == "result: hello-from-bash"
        assert not done.aborted


def test_denied_permission_is_reported_to_the_agent(env: Env) -> None:
    with start(env) as client:
        session = client.sessions.create(permission=ASK_BASH)
        events = list(session.prompt(BASH, on_permission=lambda request: False))
        tool = [e for e in events if isinstance(e, ToolCall) and e.status == "error"]
        assert tool, [type(e).__name__ for e in events]
        assert isinstance(events[-1], Done)


@pytest.mark.anyio
async def test_async_client(env: Env) -> None:
    async with await lunos.AsyncLunos.start(directory=env.project, config=env.with_config(), env=env.vars) as client:
        session = await client.sessions.create()
        deltas = []
        async for event in session.prompt("hello async world"):
            if isinstance(event, TextDelta):
                deltas.append(event.text)
        assert "".join(deltas) == "echo: hello async world"
        done = await session.ask("again")
        assert done.text == "echo: again"
        assert len(await session.messages()) == 4


def test_python_tool_is_called_and_its_result_used(env: Env) -> None:
    with start(env, tools=[add, shout, broken]) as client:
        session = client.sessions.create()
        done = session.ask('CALL add {"a": 2, "b": 40}')
        assert done.text == "result: 42"
        assert client.tool_calls == [("add", {"a": 2, "b": 40})]

        done = session.ask('CALL shout {"text": "quiet"}')
        assert done.text == 'result: {"shouted": "QUIET"}'

        events = list(session.prompt("CALL broken {}"))
        failed = [e for e in events if isinstance(e, ToolCall) and e.status == "error"]
        assert failed and "the tool broke" in (failed[0].error or "")


def test_auto_approval_mode_approves_asks(env: Env) -> None:
    with start(env) as client:
        session = client.sessions.create(permission=ASK_BASH, approval_mode="auto")
        assert session.approval_mode() == "auto"
        events = list(session.prompt(BASH))
        asks = [e for e in events if isinstance(e, PermissionRequest)]
        assert asks and asks[0].auto_approved
        assert isinstance(events[-1], Done) and events[-1].text == "result: hello-from-bash"


def test_files_and_images_are_attached(env: Env, llm: MockLLM) -> None:
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    )
    (env.project / "notes.txt").write_text("the secret word is pineapple\n")
    with start(env) as client:
        session = client.sessions.create()
        before = len(llm.requests)
        done = session.ask(
            "read these", files=[env.project / "notes.txt"], images=[lunos.File(png, "image/png", "dot.png")]
        )
        assert done.text.startswith("echo: read these")
        sent = json.dumps([r for r in llm.requests[before:] if "read these" in json.dumps(r)])
        assert "pineapple" in sent
        assert "data:image/png;base64," in sent


def test_fork_and_abort(env: Env) -> None:
    with start(env) as client:
        session = client.sessions.create(permission=ASK_BASH)
        session.ask("first message")
        fork = session.fork()
        assert fork.id != session.id
        assert len(fork.messages()) == len(session.messages()) == 2

        events = []
        for event in session.prompt(BASH):
            events.append(event)
            if isinstance(event, PermissionRequest):
                session.abort()
        assert isinstance(events[-1], Done) and events[-1].aborted
        assert not any(isinstance(e, Error) for e in events)


def test_subagent_events_are_streamed(env: Env) -> None:
    task = json.dumps({"description": "Say hi", "prompt": "say hi from the subagent", "subagent_type": "general"})
    with start(env) as client:
        session = client.sessions.create()
        events = list(session.prompt(f"CALL task {task}"))
        started = [e for e in events if isinstance(e, SubagentStarted)]
        assert started and started[0].parent_id == session.id
        child = started[0].session_id
        assert any(isinstance(e, Text) and e.session_id == child and e.subagent for e in events)
        assert any(isinstance(e, ToolCall) and e.tool == "task" and e.status == "completed" for e in events)
        assert isinstance(events[-1], Done)
        assert [c.id for c in session.children()] == [child]


def test_generated_api(env: Env) -> None:
    with start(env) as client:
        session = client.sessions.create(title="from the api test")
        found = client.api.session.get(session.id)
        assert found.id == session.id and found.title == "from the api test"
        assert any(agent.name == "build" for agent in client.api.app.agents())
        assert client.api.global_.health()["healthy"] is True


def test_wrong_token_is_refused(env: Env) -> None:
    with start(env) as client:
        with pytest.raises(lunos.AuthenticationError):
            lunos.Lunos.connect(client.url, "not-the-password")
        other = lunos.Lunos.connect(client.url, client._async.server.password, directory=env.project)  # type: ignore[union-attr]
        assert other.server_version == client.server_version
        other.close()


# -- policy and residency: the same refusals as the TUI ------------------------------------------


def test_locked_model_is_refused(env: Env) -> None:
    env.lock({"$locked": ["model"], "model": "test/test-model"})
    with start(env) as client:
        session = client.sessions.create()
        with pytest.raises(lunos.PolicyLockedError) as refused:
            session.ask("hi", model="test/other-model")
        assert refused.value.key == "model"
        assert refused.value.message == (
            "model is set by your organisation's policy and can't be changed here (it is set to test/test-model)"
        )
        # The locked model itself is fine.
        assert session.ask("hi", model="test/test-model").text == "echo: hi"


def test_locked_approval_mode_is_refused(env: Env) -> None:
    env.lock({"$locked": ["agent.build.permission_mode"], "agent": {"build": {"permission_mode": "manual"}}})
    with start(env) as client:
        session = client.sessions.create(agent="build")
        with pytest.raises(lunos.PolicyLockedError) as refused:
            session.set_approval_mode("auto")
        assert refused.value.key == "agent.build.permission_mode"
        assert refused.value.message == "Auto-approve is turned off by your organisation"
        with pytest.raises(lunos.PolicyLockedError):
            client.sessions.create(agent="build", approval_mode="auto")
        session.set_approval_mode("manual")


def test_locked_auto_approval_is_applied(env: Env) -> None:
    env.lock({"$locked": ["agent.build.permission_mode"], "agent": {"build": {"permission_mode": "auto"}}})
    with start(env) as client:
        session = client.sessions.create(agent="build", permission=ASK_BASH)
        assert session.approval_mode() == "auto"
        with pytest.raises(lunos.PolicyLockedError) as refused:
            session.set_approval_mode("manual")
        assert refused.value.message == "Build: approval is set by your organisation"


def test_residency_policy_refuses_a_provider(env: Env, llm: MockLLM) -> None:
    env.lock(
        {
            "$locked": ["residency"],
            "residency": {"allow": ["eu"], "endpoints": {"test": {"region": "eu"}}},
        }
    )
    with start(env) as client:
        session = client.sessions.create()
        assert session.ask("in the eu").text == "echo: in the eu"
        before = len(llm.requests)
        with pytest.raises(lunos.ResidencyError) as refused:
            session.ask("elsewhere", model="elsewhere/test-model")
        assert "residency policy allows only: eu" in refused.value.message
        assert len(llm.requests) == before


def test_policy_lock_cannot_be_overridden_by_sdk_config(env: Env) -> None:
    """Config passed to start() is user config: a locked key keeps the organisation's value."""
    env.lock({"$locked": ["model"], "model": "test/test-model"})
    with lunos.Lunos.start(
        directory=env.project, config=env.with_config(model="test/other-model"), env=env.vars
    ) as client:
        session = client.sessions.create()
        done = session.ask("which model")
        assert done.text == "echo: which model"
        assert session.messages()[-1].info.modelID == "test-model"


# -- headless runs -------------------------------------------------------------------------------


def test_run_completes(env: Env) -> None:
    report = lunos.run("hello headless", sandbox=False, directory=env.project, env=env.child_env())
    assert report.ok and report.reason == "completed", report
    assert report.steps >= 1 and report.session
    assert report.file and report.file.endswith(".json")


def test_run_refuses_permissions_and_reports_them(env: Env) -> None:
    report = lunos.run(
        BASH, sandbox=False, directory=env.project, env=env.child_env(agent={"build": {"permission": {"bash": "ask"}}})
    )
    assert report.ok, report
    assert [d.permission for d in report.denied] == ["bash"]


def test_run_stops_at_the_step_limit(env: Env) -> None:
    report = lunos.run(
        'CALL bash {"command": "echo one", "description": "one"}',
        max_steps=1,
        sandbox=False,
        directory=env.project,
        env=env.child_env(permission={"bash": "allow"}),
    )
    assert report.reason == "steps", report
    assert report.ok
    assert report.steps == 1
