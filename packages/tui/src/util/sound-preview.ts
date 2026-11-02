// XCOD-311: previews a sound as a select's highlight moves, the way the desktop settings do
// (packages/app/src/components/settings-v2/general-controller-behavior.ts): each highlight stops
// the last preview and waits PREVIEW_DELAY_MS, so moving quickly through the list plays only the
// one it stops on, once, and sounds never stack.

export const PREVIEW_DELAY_MS = 100

/** Plays a sound; resolves to a function that stops it, or undefined when nothing played. */
export type PreviewPlayer = (sound: string) => Promise<(() => void) | undefined>

export function createSoundPreview(
  player: PreviewPlayer,
  timers: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: setTimeout, clear: clearTimeout },
) {
  let cleanup: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let run = 0

  const stop = () => {
    run += 1
    cleanup?.()
    if (timeout !== undefined) timers.clear(timeout)
    cleanup = undefined
    timeout = undefined
  }

  /** Undefined (None, Custom file…) only stops what's playing. */
  const play = (sound: string | undefined) => {
    stop()
    if (!sound) return
    const current = ++run
    timeout = timers.set(() => {
      timeout = undefined
      void player(sound)
        .catch(() => undefined)
        .then((next) => {
          if (run === current) {
            cleanup = next
            return
          }
          next?.()
        })
    }, PREVIEW_DELAY_MS)
  }

  return { play, stop }
}
