"""Quick start: a session, a streamed reply, a permission request, done.

python quickstart.py "Run the tests and tell me what fails"
"""

import sys

import lunos
from lunos.events import Done, PermissionRequest, TextDelta, ToolCall

prompt = " ".join(sys.argv[1:]) or "What does this project do?"

with lunos.Lunos.start() as client:
    session = client.sessions.create(agent="build")
    for event in session.prompt(prompt):
        if isinstance(event, TextDelta) and not event.subagent:
            print(event.text, end="", flush=True)
        elif isinstance(event, ToolCall) and event.status == "running":
            print(f"\n[{event.tool}] {event.title or ''}", flush=True)
        elif isinstance(event, PermissionRequest):
            answer = input(f"\nAllow {event.permission}: {', '.join(event.patterns)}? [y/N] ")
            if answer.strip().lower() == "y":
                session.approve(event)
            else:
                session.deny(event, "The user said no.")
        elif isinstance(event, Done):
            print(f"\n\ndone, cost {event.cost:.4f}")
