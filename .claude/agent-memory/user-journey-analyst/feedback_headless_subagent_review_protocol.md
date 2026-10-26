---
name: feedback_headless_subagent_review_protocol
description: When invoked as a subagent with no human in the loop, produce the complete journey doc and present the review summary in the final message instead of stalling on the per-actor MANDATORY interactive review protocol
metadata:
  type: feedback
---

My agent definition's "Interactive Journey Review Protocol" says to present each actor-type section
and wait for user feedback before moving to the next, section by section. On XCOD-34 I was invoked as
a subagent under Auto Mode from another agent's task delegation — there is no human available to
answer per-section prompts turn by turn, and the calling agent only reads my final text message, not
intermediate stalls.

**Why:** confirmed by advisor consultation on this exact task — stalling per-actor in a context with
no human respondent would just hang or force the caller to guess at answers on my behalf, defeating
the purpose of "interactive" review. The MANDATORY wording in my own agent definition assumes an
interactive human session; it doesn't anticipate delegated/headless invocation.

**How to apply:** when there's no human in the loop (invoked as a subagent, or `-p`/headless mode),
skip the turn-by-turn per-actor waiting. Instead: (1) write the complete journey doc to disk (durable
output survives even if the session ends), (2) put the per-actor summary table plus any open
GAP questions directly in the final response text, so the calling agent/orchestrator can relay them to
a human or make the call itself. Only do genuine multi-round interactive review when a human is
actually present in the conversation turn-by-turn (e.g. invoked directly via `/user-journeys` in an
interactive session).
