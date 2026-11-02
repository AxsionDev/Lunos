/**
 * XCOD-236: set when Ctrl+C is ending an attached run (`--cloud`, `--sandbox`). The server the run
 * is attached to is being stopped, so the client's connection closing is expected: it isn't an
 * error to print, and the run's own handler says how it ended.
 */
export const RunEnding = { interrupted: false }
