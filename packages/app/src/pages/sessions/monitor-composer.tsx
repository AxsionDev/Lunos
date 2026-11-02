import type { SessionOverviewItem } from "@opencode-ai/sdk/v2/client"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { insertMention, mentionAt, mentionOptions, tags, untag, type RailRow } from "./monitor-model"

export type MonitorComposerProps = {
  /** What is typed; the rail's numbers add tags to it too. */
  text: string
  setText: (value: string) => void
  rows: readonly RailRow[]
  numbers: ReadonlyMap<string, number>
  byNumber: ReadonlyMap<number, string>
  byID: ReadonlyMap<string, SessionOverviewItem>
  projects: { value: string; label: string }[]
  project: string | undefined
  onProject: (value: string) => void
  stateLabel: (item: SessionOverviewItem) => string
  /** The last message of a session, for the preview. */
  preview: (item: SessionOverviewItem) => Promise<string | undefined>
  /** Resolves true when the prompt went out and the composer can be cleared. */
  submit: (text: string, interrupt: boolean) => Promise<boolean>
}

/**
 * XCOD-262: the centre of the Sessions window. With no tag the prompt starts a session in the chosen
 * project; `@2` (or `@` and part of a name, picked from the list) sends it to that session, shown
 * as a chip. Enter sends, Shift+Enter is a new line, Ctrl+Enter (⌘+Enter) interrupts a running
 * session and sends now. Text only: files and agents are attached in the session itself.
 */
export function MonitorComposer(props: MonitorComposerProps) {
  const language = useLanguage()
  const t = language.t
  const [caret, setCaret] = createSignal(0)
  const [active, setActive] = createSignal(0)
  // The `@` the list was closed for (Esc), so it stays closed until another one is typed.
  const [dismissed, setDismissed] = createSignal<number>()
  const [sending, setSending] = createSignal(false)
  const [preview, setPreview] = createSignal<{ id: string; text: string }>()
  let input: HTMLTextAreaElement | undefined

  const label = (item: SessionOverviewItem) => `@${props.numbers.get(item.id) ?? "?"} ${item.title}`
  const tagged = createMemo(() =>
    tags(props.text, props.byNumber)
      .targets.map((id) => props.byID.get(id))
      .filter((item): item is SessionOverviewItem => !!item),
  )
  const mention = createMemo(() => {
    const value = mentionAt(props.text, caret())
    return value && value.start !== dismissed() ? value : undefined
  })
  const options = createMemo(() => {
    const value = mention()
    return value ? mentionOptions(props.rows, props.numbers, value.query).slice(0, 8) : []
  })
  const open = () => options().length > 0
  createEffect(on(options, () => setActive(0)))

  // The last message of the first tagged session, so its context is seen before sending.
  createEffect(
    on(
      () => tagged()[0]?.id,
      (id) => {
        const item = id ? props.byID.get(id) : undefined
        if (!item) return setPreview(undefined)
        void props
          .preview(item)
          .then((text) => tagged()[0]?.id === id && setPreview(text ? { id: item.id, text } : undefined))
          .catch(() => setPreview(undefined))
      },
    ),
  )

  const sync = () => setCaret(input?.selectionStart ?? props.text.length)

  function pick(index: number) {
    const value = mention()
    const option = options()[index]
    if (!value || !option) return
    const next = insertMention(props.text, value, option.number)
    props.setText(next.text)
    setCaret(next.caret)
    queueMicrotask(() => input?.setSelectionRange(next.caret, next.caret))
  }

  async function send(interrupt: boolean) {
    const text = props.text
    if (sending() || !text.trim()) return
    setSending(true)
    try {
      // Cleared only if nothing new was typed while it was being sent.
      if ((await props.submit(text, interrupt)) && props.text === text) {
        props.setText("")
        setCaret(0)
        setDismissed(undefined)
      }
    } finally {
      setSending(false)
      input?.focus()
    }
  }

  const target = () => tagged()[0]
  const projectLabel = () => props.projects.find((item) => item.value === props.project)?.label

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3" data-component="sessions-monitor">
      <div class="min-h-0 flex-1 overflow-auto rounded-lg border border-v2-border-border-base p-3" aria-live="polite">
        <Show
          when={target()}
          fallback={
            <p class="text-14-regular text-v2-text-text-weak">
              {projectLabel()
                ? t("sessions.monitor.intro", { project: projectLabel()! })
                : t("sessions.monitor.noProject")}
            </p>
          }
        >
          {(item) => (
            <div class="flex flex-col gap-1">
              <p class="truncate text-14-medium text-v2-text-text-strong">
                {t("sessions.monitor.to", { sessions: tagged().map(label).join(", ") })}
              </p>
              <p class="text-12-regular text-v2-text-text-weak">
                {item().state === "running"
                  ? t("sessions.monitor.runningHint", { state: props.stateLabel(item()) })
                  : props.stateLabel(item())}
              </p>
              <Show when={preview()?.id === item().id}>
                <p class="whitespace-pre-wrap pt-2 text-14-regular text-v2-text-text-base">
                  {preview()!.text.length > 600 ? `${preview()!.text.slice(0, 600)}…` : preview()!.text}
                </p>
              </Show>
            </div>
          )}
        </Show>
      </div>
      <form
        class="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void send(false)
        }}
      >
        <Show when={tagged().length > 0}>
          <ul class="flex flex-wrap gap-1">
            <For each={tagged()}>
              {(item) => (
                <li class="flex items-center gap-1 rounded bg-v2-background-bg-raised py-0.5 pl-2 pr-1 text-12-medium text-v2-text-text-strong">
                  <span>{label(item)}</span>
                  <button
                    type="button"
                    class="rounded px-1"
                    aria-label={t("sessions.monitor.untag", { session: label(item) })}
                    onClick={() => {
                      const value = props.numbers.get(item.id)
                      if (value !== undefined) props.setText(untag(props.text, value))
                      input?.focus()
                    }}
                  >
                    ×
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class="relative">
          <Show when={open()}>
            <ul
              id="sessions-monitor-mentions"
              role="listbox"
              aria-label={t("sessions.title")}
              class="absolute bottom-full left-0 z-10 mb-1 max-h-64 w-full overflow-auto rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-1 shadow-md"
            >
              <For each={options()}>
                {(option, index) => (
                  <li
                    id={`sessions-monitor-mention-${index()}`}
                    role="option"
                    aria-selected={active() === index()}
                    class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-14-regular"
                    classList={{ "bg-v2-background-bg-raised": active() === index() }}
                    onMouseDown={(event) => {
                      event.preventDefault()
                      pick(index())
                    }}
                  >
                    <span class="truncate text-v2-text-text-strong">{label(option.item)}</span>
                    <span class="ml-auto shrink-0 text-12-regular text-v2-text-text-weak">
                      {props.stateLabel(option.item)}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <textarea
            ref={input}
            rows={3}
            class="w-full resize-y rounded-md border border-v2-border-border-base bg-transparent px-3 py-2 text-14-regular"
            aria-label={t("sessions.monitor.prompt")}
            placeholder={t("sessions.monitor.placeholder")}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open()}
            aria-controls={open() ? "sessions-monitor-mentions" : undefined}
            aria-activedescendant={open() ? `sessions-monitor-mention-${active()}` : undefined}
            value={props.text}
            onInput={(event) => {
              props.setText(event.currentTarget.value)
              sync()
            }}
            onClick={sync}
            onKeyUp={(event) => {
              if (event.key.startsWith("Arrow") && !open()) sync()
            }}
            onKeyDown={(event) => {
              if (event.isComposing) return
              if (open()) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  const step = event.key === "ArrowDown" ? 1 : -1
                  setActive((value) => (value + step + options().length) % options().length)
                  return
                }
                if (
                  (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) ||
                  event.key === "Tab"
                ) {
                  event.preventDefault()
                  pick(active())
                  return
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  setDismissed(mention()?.start)
                  return
                }
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send(event.ctrlKey || event.metaKey)
              }
            }}
          />
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label class="flex items-center gap-2 text-12-regular text-v2-text-text-weak">
            <span>{t("sessions.monitor.project")}</span>
            <select
              class="rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-12-regular"
              value={props.project ?? ""}
              onChange={(event) => props.onProject(event.currentTarget.value)}
            >
              <For each={props.projects}>{(item) => <option value={item.value}>{item.label}</option>}</For>
            </select>
          </label>
          <span class="flex-1 text-12-regular text-v2-text-text-weak">{t("sessions.monitor.keys")}</span>
          <button
            type="submit"
            class="rounded border border-v2-border-border-base px-3 py-1 text-14-medium"
            disabled={sending() || !props.text.trim()}
          >
            {t("sessions.monitor.send")}
          </button>
        </div>
      </form>
    </div>
  )
}
