"""A Python function the agent can call.

    python custom_tool.py

The agent gets a ``ticket_status`` tool. It runs here, in this Python process. Lunos calls it
over a local MCP connection that only this client can use.
"""

from typing import Literal

import lunos

TICKETS = {
    "XCOD-337": {"title": "Python SDK", "status": "in review", "assignee": "platform-team"},
    "XCOD-211": {"title": "Unattended agent runs", "status": "done", "assignee": "platform-team"},
}


@lunos.tool
def ticket_status(key: str, field: Literal["status", "title", "assignee", "all"] = "all") -> dict | str:
    """Look up a ticket in the team's tracker by its key, e.g. XCOD-337."""
    ticket = TICKETS.get(key.upper())
    if ticket is None:
        raise KeyError(f"no ticket {key}")
    return ticket if field == "all" else ticket[field]


with lunos.Lunos.start(tools=[ticket_status]) as client:
    session = client.sessions.create(approval_mode="auto")
    done = session.ask("Which of XCOD-337 and XCOD-211 is still open? Use the ticket tool.")
    print(done.text)
    print("tool calls:", client.tool_calls)
