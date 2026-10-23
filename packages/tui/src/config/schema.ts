// The tui.json schema, without the Solid context, so the CLI can read it outside the TUI (XCOD-128).
import { Schema } from "effect"
import { TuiKeybind } from "./keybind"
import { NO_SOUND, SOUND_EVENTS, isSoundID } from "@opencode-ai/ui/sounds"

export const AttentionSoundName = Schema.Literals([
  "default",
  "question",
  "permission",
  "error",
  "done",
  "subagent_done",
  // XCOD-311: a subagent blocked on your approval or answer, and a budget threshold reached.
  "waiting",
  "budget_warning",
])
export type AttentionSoundName = Schema.Schema.Type<typeof AttentionSoundName>

export const PluginOptions = Schema.Record(Schema.String, Schema.Unknown)
export const PluginSpec = Schema.Union([Schema.String, Schema.mutable(Schema.Tuple([Schema.String, PluginOptions]))])

export const LeaderTimeoutDefault = 2000
export const LeaderTimeout = Schema.Int.check(Schema.isGreaterThan(0)).annotate({
  description: "Leader key timeout in milliseconds",
})

export const ScrollSpeed = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0.001))
export const ScrollAcceleration = Schema.Struct({
  enabled: Schema.Boolean.annotate({ description: "Enable scroll acceleration" }),
}).annotate({ description: "Scroll acceleration settings" })
export const DiffStyle = Schema.Literals(["auto", "stacked"]).annotate({
  description: "Control diff rendering style: 'auto' adapts to terminal width, 'stacked' always shows single column",
})
export const Cursor = Schema.Struct({
  style: Schema.optional(Schema.Literals(["block", "underline", "line", "default"])).annotate({
    description: "Cursor shape. Use 'default' to preserve the terminal setting",
  }),
  blinking: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the cursor blinks. Has no effect when style is 'default'",
  }),
}).annotate({ description: "Terminal cursor settings" })

export const AttentionSounds = Schema.Record(AttentionSoundName, Schema.optionalKey(Schema.String)).annotate({
  description:
    'Per event: a bundled sound ID (e.g. "alert-04"), "none" for silence, or a path to an .mp3, .aac or .wav file',
})
export type AttentionSoundPaths = Schema.Schema.Type<typeof AttentionSounds>
/** XCOD-311: a bundled sound ID or `none`, as opposed to a file path (which is resolved against tui.json). */
export function isNamedSound(value: string) {
  const text = value.trim()
  return text === NO_SOUND || isSoundID(text)
}
/** XCOD-311: what /settings calls each `attention.*` key, and each event (`attention.sounds.done`, …). */
export const AttentionLabels: Record<string, string> = {
  enabled: "Alerts",
  notifications: "Desktop notifications",
  sound: "Sounds",
  volume: "Volume",
  sound_pack: "Sound pack",
  notify_when: "When",
  notify_subagents: "Subagents",
  ...Object.fromEntries(SOUND_EVENTS.map((item) => [`sounds.${item.id}`, item.label])),
}
export const AttentionNotifyWhen = Schema.Literals(["blurred", "always"])
export const Attention = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Turns alerts (desktop notifications and sounds) on or off as a whole (default: false)",
  }),
  notifications: Schema.optional(Schema.Boolean).annotate({ description: "Desktop notifications (default: true)" }),
  sound: Schema.optional(Schema.Boolean).annotate({ description: "Sounds (default: true)" }),
  volume: Schema.optional(
    Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1)),
  ).annotate({ description: "Sound volume, 0 to 1 (default: 0.4)" }),
  sound_pack: Schema.optional(Schema.String).annotate({
    description: "The sound pack: the built-in one, or one a plugin registers",
  }),
  sounds: Schema.optional(AttentionSounds),
  notify_when: Schema.optional(AttentionNotifyWhen).annotate({
    description: "'blurred' notifies only while Lunos is in the background, 'always' even in front (default: blurred)",
  }),
  notify_subagents: Schema.optional(Schema.Boolean).annotate({
    description: "A subagent finishing also sends a desktop notification (default: false)",
  }),
}).annotate({ description: "Attention notification and sound settings" })

export const QuestionDismissWindowDefault = 2000
export const QuestionUndoWindowDefault = 5000
const Millis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const QuestionPrompt = Schema.Struct({
  dismiss_window: Schema.optional(Millis).annotate({
    description:
      "Milliseconds in which a second Esc dismisses an agent question; the first only warns. 0 dismisses on the first Esc (default 2000)",
  }),
  undo_window: Schema.optional(Millis).annotate({
    description:
      "Milliseconds after dismissing a question during which ctrl+z brings it back before the agent is told. 0 tells the agent at once (default 5000)",
  }),
}).annotate({ description: "Guards against dismissing an agent's question by accident" })

export const DoubleEscapeWindowDefault = 1000

const PromptSize = Schema.Int.check(Schema.isGreaterThan(0))
export const Prompt = Schema.Struct({
  max_height: Schema.optional(PromptSize).annotate({ description: "Prompt textarea max height" }),
  max_width: Schema.optional(Schema.Union([PromptSize, Schema.Literal("auto")])).annotate({
    description: "Home prompt max width: a positive integer for a fixed cap, or 'auto' to scale with terminal width",
  }),
}).annotate({ description: "Prompt size settings" })

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  theme: Schema.optional(Schema.String).annotate({ description: "Colour theme, by name (see /themes)" }),
  keybinds: Schema.optional(TuiKeybind.KeybindOverrides),
  plugin: Schema.optional(Schema.Array(PluginSpec)),
  plugin_enabled: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  leader_timeout: Schema.optional(LeaderTimeout),
  attention: Schema.optional(Attention),
  prompt: Schema.optional(Prompt),
  scroll_speed: Schema.optional(ScrollSpeed).annotate({ description: "TUI scroll speed" }),
  scroll_acceleration: Schema.optional(ScrollAcceleration),
  diff_style: Schema.optional(DiffStyle),
  cursor: Schema.optional(Cursor),
  mouse: Schema.optional(Schema.Boolean).annotate({ description: "Enable or disable mouse capture (default: true)" }),
  reduced_motion: Schema.optional(Schema.Boolean).annotate({
    description:
      "true turns off every animation (the home screen's moon reflection, spinners, placeholder cycling) and the in-app toggle can't turn them back on. Unset: off by default when NO_COLOR is set or TERM=dumb",
  }),
  question: Schema.optional(QuestionPrompt),
  external_accent: Schema.optional(Schema.Boolean).annotate({
    description:
      'false keeps the theme\'s colours in Claude Code and Codex sessions; the "Lunos · Claude Code" badge and the ▸ label stay (default: true)',
  }),
  double_escape_clear: Schema.optional(Schema.Boolean).annotate({
    description:
      "Esc twice in the prompt clears it while the session is idle; the cleared prompt can be undone and is kept in history (default: true)",
  }),
  left_opens_monitor: Schema.optional(Schema.Boolean).annotate({
    description:
      "← on an empty prompt (home or a top-level session) opens the Agent Monitor; /monitor and the agent_monitor keybind still do with this off (default: true)",
  }),
  double_escape_ms: Schema.optional(PromptSize).annotate({
    description: "Milliseconds in which a second Esc clears the prompt (default 1000)",
  }),
  whats_new: Schema.optional(Schema.Boolean).annotate({
    description:
      'false stops the "What\'s new" panel on the first start after an update. /whatsnew and lunos changelog still work (default: true)',
  }),
  tips: Schema.optional(Schema.Boolean).annotate({
    description:
      "false turns off the tips on the home screen and under the working indicator. /tips still lists them (default: true)",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
