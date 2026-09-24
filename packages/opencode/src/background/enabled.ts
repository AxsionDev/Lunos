/**
 * Whether background subagents are available (XCOD-82). Opt-in through the documented
 * `subagent.background` config key. The old `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS`
 * environment variable still turns it on, so existing setups keep working.
 *
 * Kept opt-in rather than on by default: upstream still ships it as experimental, and its
 * follow-up fixes (#29179, #30790, #31162) were all about the model polling or sleeping while
 * waiting for a result. That's a prompt-quality risk worth an explicit choice.
 */
export function backgroundEnabled(flag: boolean, config: { subagent?: { background?: boolean } }) {
  return flag || config.subagent?.background === true
}
