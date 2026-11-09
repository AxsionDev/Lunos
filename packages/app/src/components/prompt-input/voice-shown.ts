/**
 * XCOD-336: whether the prompt has a mic button. Only where this computer transcribes (the desktop
 * app's platform.voice): the web app's server may be on another machine. An organisation turns it
 * off with `voice.enabled: false` (lockable), which removes the button rather than disabling it.
 */
export function voiceButtonShown(input: { local: boolean; config: { enabled?: boolean } | undefined }) {
  return input.local && input.config?.enabled !== false
}
