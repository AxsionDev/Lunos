export * as ConfigVoice from "./voice"

import { Schema } from "effect"

/**
 * XCOD-336: push-to-talk dictation into the prompt, transcribed on this computer by whisper.cpp.
 * There is no cloud speech option: audio stays in memory and is never written to disk or sent
 * anywhere. Lock `voice` (or `voice.enabled`) with `$locked` to turn it off for an organisation,
 * which hides the TUI key and the desktop mic button. Declared in both config schemas.
 *
 * Deliberately no setting for the whisper.cpp executable's path: a repository's config must not be
 * able to make a key press run a program of its choosing.
 */

export const MODELS = ["tiny", "base", "small", "medium"] as const
export type Model = (typeof MODELS)[number]

export const Info = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Voice input in the prompt (TUI key prompt.voice, desktop mic button). Default true",
  }),
  model: Schema.optional(Schema.Literals(MODELS)).annotate({
    description:
      "The whisper.cpp model: tiny (75 MB), base (142 MB, default), small (466 MB) or medium (1.5 GB). Larger is more accurate and slower",
  }),
  language: Schema.optional(Schema.String).annotate({
    description:
      "The spoken language as a whisper language code (en, bg, de, fr, ...), or auto to detect it (default). Set it when detection picks a neighbouring language",
  }),
  auto_send: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description:
      "Send the transcript after this many seconds without typing. Off (0) by default: the transcript waits in the prompt for you to edit and send",
  }),
}).annotate({ identifier: "VoiceConfig" })
export type Info = Schema.Schema.Type<typeof Info>
