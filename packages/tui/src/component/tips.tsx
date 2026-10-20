import { createEffect, createSignal, For, on, onCleanup, Show, useContext, type Accessor } from "solid-js"
import { Flag } from "@opencode-ai/core/flag/flag"
import { useKV } from "../context/kv"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"
import { AccountContext } from "../context/account"
import { useTuiConfig } from "../config"
import { TuiKeybind } from "../config/keybind"
import { formatKeySequence, useOpencodeKeymap } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import * as Tips from "../util/tips"

/** How long a turn runs before a tip shows under the working indicator. */
export const WORKING_TIP_DELAY = 3000

/** Feature flags a tip's `requires: flag:<name>` can name, and whether each is on. */
const FLAGS: Record<string, boolean> = {
  workspaces: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
}

export type TipStore = ReturnType<typeof createTipStore>

let current: { kv: unknown; store: TipStore } | undefined
let counted = false

/**
 * XCOD-278: one deck for the home screen, the working indicator, `tips.next` and `/tips`, kept in kv
 * as `tips_deck`. Made by the first component that asks; the contexts it reads live as long as the app.
 */
export function useTipStore() {
  const kv = useKV()
  const sync = useSync()
  const config = useTuiConfig()
  const account = useContext(AccountContext)
  const keymap = useOpencodeKeymap()
  if (current?.kv === kv) return current.store
  const store = createTipStore({
    kv,
    config,
    keymap,
    context: () =>
      Tips.context({
        config: sync.data.config as Tips.ContextConfig,
        signedIn: account?.user() !== undefined,
        platform: process.platform,
        flags: FLAGS,
      }),
  })
  current = { kv, store }
  return store
}

/** The store, once a component has made it; commands run outside any component. */
export function tipStore() {
  return current?.store
}

function createTipStore(input: {
  kv: ReturnType<typeof useKV>
  config: ReturnType<typeof useTuiConfig>
  keymap: ReturnType<typeof useOpencodeKeymap>
  context: () => Tips.Context
}) {
  const key = (name: string) => {
    const command = TuiKeybind.CommandMap[name as keyof typeof TuiKeybind.CommandMap] ?? name
    // The first binding, as the rest of the TUI shows a command's key.
    const first = input.config.keybinds.get(command)[0]
    if (!first) return
    // "shift+return,ctrl+return" is two keys: a tip names one.
    const sequence = typeof first.key === "string" ? first.key.split(",")[0]!.trim() : first.key
    return formatKeySequence(Array.from(input.keymap.parseKeySequence(sequence)), input.config) || undefined
  }
  const ids = Tips.TIPS.map((tip) => tip.id)
  const preferred = new Set(Tips.TIPS.filter((tip) => tip.category === Tips.FIRST_STEPS).map((tip) => tip.id))
  // The tip just drawn for the home screen, so `tips.next` there can replace it.
  const [home, setHome] = createSignal<string>()

  const store = {
    home,
    /** Off with "Hide tips" or `"tips": false`; `/tips` still lists them. */
    enabled() {
      return input.config.tips !== false && !input.kv.get("tips_hidden", false)
    },
    /** The tip's text with the user's keys, or undefined when one of them is unbound. */
    render(tip: Tips.Tip) {
      return Tips.render(tip.text, key)
    },
    /** Draws the next tip and records it; undefined until kv has loaded, so nothing is written over it. */
    next(where: "home" | "working" = "working") {
      if (!input.kv.ready) return
      const context = input.context()
      const rendered = new Map<string, string>()
      for (const tip of Tips.TIPS) {
        if (!Tips.eligible(tip, context)) continue
        const text = store.render(tip)
        if (text) rendered.set(tip.id, text)
      }
      let deck = Tips.deck(input.kv.get("tips_deck"))
      if (!counted) {
        counted = true
        deck = { ...deck, starts: deck.starts + 1 }
      }
      const result = Tips.draw(deck, ids, {
        eligible: new Set(rendered.keys()),
        random: Math.random,
        preferred: deck.starts <= Tips.FIRST_STEPS_STARTS ? preferred : undefined,
      })
      input.kv.set("tips_deck", result.deck)
      const text = result.id ? rendered.get(result.id) : undefined
      if (where === "home") setHome(text)
      return text
    },
    /** Every tip for `/tips`, whether it was seen, and its text (the raw text when a key is unbound). */
    list() {
      const seen = new Set(Tips.deck(input.kv.get("tips_deck")).seen)
      return Tips.TIPS.map((tip) => ({ tip, text: store.render(tip) ?? tip.text, seen: seen.has(tip.id) }))
    },
  }
  return store
}

/** A tip's text, its commands and keys highlighted. */
export function TipText(props: { text: string; wrap?: boolean }) {
  const { theme } = useTheme()
  return (
    <text flexShrink={1} wrapMode={props.wrap === false ? "none" : "word"} truncate={props.wrap === false}>
      <For each={Tips.parts(props.text)}>
        {(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}
      </For>
    </text>
  )
}

/**
 * One line under the working indicator once a turn has run for 3 s: a new tip each turn, so it differs
 * from the home screen's and the last turn's. A short turn shows none.
 */
export function WorkingTip(props: { busy: Accessor<boolean> }) {
  const store = useTipStore()
  const { theme } = useTheme()
  const [tip, setTip] = createSignal<string>()
  createEffect(
    on(props.busy, (busy) => {
      setTip(undefined)
      if (!busy || !store.enabled()) return
      const timer = setTimeout(() => setTip(store.next()), WORKING_TIP_DELAY)
      onCleanup(() => clearTimeout(timer))
    }),
  )
  return (
    <Show when={tip() && store.enabled() ? tip() : undefined}>
      {(text) => (
        <box paddingLeft={3} flexDirection="row" width="100%">
          <text flexShrink={0} fg={theme.warning}>
            Tip:{" "}
          </text>
          <TipText text={text()} wrap={false} />
        </box>
      )}
    </Show>
  )
}

/** `/tips`: every tip by category, searchable, each marked seen or not yet. */
export function DialogTips() {
  const store = useTipStore()
  const dialog = useDialog()
  dialog.setSize("xlarge")
  const items = store.list()
  const seen = items.filter((item) => item.seen).length
  return (
    <DialogSelect
      title={`Tips · ${seen} of ${items.length} seen`}
      placeholder="Search tips"
      options={items.map((item) => ({
        title: Tips.plain(item.text),
        value: item.tip.id,
        category: item.tip.category,
        footer: item.seen ? "seen" : "new",
        truncateTitle: false,
      }))}
      onSelect={() => dialog.clear()}
    />
  )
}
