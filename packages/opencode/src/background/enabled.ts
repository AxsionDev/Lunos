/**
 * Whether background subagents are available (XCOD-82). On by default since XCOD-287;
 * `subagent.background: false` turns them off. The old `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`
 * environment variable still turns them on.
 *
 * XCOD-82 kept this opt-in: upstream still ships it as experimental, and its follow-up fixes
 * (#29179, #30790, #31162) were all about the model polling or sleeping while waiting for a result.
 * XCOD-287 (PO decision) turns it on so Build can run subagents in parallel by default; the task
 * tool's own text still tells the model not to sleep or poll.
 */
export function backgroundEnabled(flag: boolean, config: { subagent?: { background?: boolean } }) {
  return flag || config.subagent?.background !== false
}
