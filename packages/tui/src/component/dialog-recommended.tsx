import { createResource, onMount } from "solid-js"
import type { SettingsSnapshot } from "@opencode-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useDialog, type DialogNav } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogModel } from "./dialog-model"
import { RECOMMENDED_REASON_MAX, recommendedReasonProblem } from "../util/settings"

// XCOD-229: /settings → Recommended. The models the pickers list under Recommended (ctrl+l), each
// with why. Unset, it's Lunos's curated list (XCOD-213); the first change writes the whole list to
// the scope in the header, and Reset removes it again. Saves go through PATCH /config/settings: the
// model must be available here, an organisation lock refuses every change, comments are kept.

type Scope = "user" | "project"

export function DialogRecommended(props: { scope: Scope; focus?: string; onBack: () => void }) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const generation = dialog.generation
  const [snapshot] = createResource(
    async () => (await sdk.client.config.settings().catch(() => undefined))?.data as SettingsSnapshot | undefined,
  )
  const row = () => snapshot()?.rows.find((item) => item.key === "recommended")
  const list = () => (row()?.value ?? {}) as Record<string, string>
  const lunosDefault = () => row()?.source === "default"
  // Model IDs and reasons need the width; replace() starts every screen medium.
  onMount(() => dialog.setSize("large"))

  const reopen = (focus?: string) =>
    dialog.replace(() => <DialogRecommended scope={props.scope} focus={focus} onBack={props.onBack} />, undefined, {
      back: props.onBack,
      generation,
    })
  const navTo = (focus: string): DialogNav => ({ back: () => reopen(focus), generation })

  function locked() {
    if (!row()?.locked) return false
    toast.show({
      variant: "warning",
      message: "recommended is set by your organisation's policy and can't be changed here",
    })
    return true
  }

  /** Saves the whole list (undefined: removes the key, back to Lunos's defaults) and comes back. */
  async function write(next: Record<string, string> | undefined, focus?: string) {
    const result = await sdk.client.config
      .settingsSet({
        settingsSetInput: {
          key: "recommended",
          value: next ? JSON.stringify(next) : "",
          scope: props.scope,
          ...(next ? {} : { unset: true }),
        },
      })
      .catch(() => undefined)
    const data = result?.data
    if (!data || !data.ok)
      toast.show({
        variant: "error",
        title: "Recommended not saved",
        message: data && !data.ok ? data.error : "The server didn't answer",
        duration: 8000,
      })
    else
      toast.show({
        variant: "success",
        message: next
          ? `Recommended saved (${data.scope} config)`
          : data.changed
            ? `Recommended reset to Lunos's defaults (removed from ${data.scope} config)`
            : `Recommended isn't set in ${data.scope} config: Lunos's defaults already apply`,
        duration: 5000,
      })
    reopen(focus)
  }

  /** The reason prompt: optional, at most RECOMMENDED_REASON_MAX characters. Null when cancelled. */
  async function reason(id: string, value: string, back: string): Promise<string | null> {
    const typed = await DialogPrompt.show(dialog, `Why ${id}?`, {
      value,
      placeholder: `optional, up to ${RECOMMENDED_REASON_MAX} characters; shown under the model`,
      nav: navTo(back),
    })
    if (typed === null) return null
    const problem = recommendedReasonProblem(typed)
    if (!problem) return typed.trim()
    toast.show({ variant: "error", message: problem })
    return reason(id, typed, back)
  }

  function add() {
    dialog.replace(
      () => (
        <DialogModel
          title="Add to Recommended"
          onPick={async (providerID, modelID) => {
            const id = `${providerID}/${modelID}`
            const why = await reason(id, list()[id] ?? "", "+add")
            if (why === null) return reopen("+add")
            await write({ ...list(), [id]: why }, id)
          }}
        />
      ),
      undefined,
      navTo("+add"),
    )
  }

  function entry(id: string) {
    dialog.replace(
      () => (
        <DialogSelect<string>
          title={id}
          placeholder={list()[id] || "no reason given"}
          skipFilter
          options={[
            { title: "Edit reason", value: "edit" },
            { title: "Remove", value: "remove", description: "from the Recommended list" },
          ]}
          onSelect={async (option) => {
            if (option.value === "remove") {
              const { [id]: _, ...rest } = list()
              return write(rest, "+add")
            }
            const why = await reason(id, list()[id] ?? "", id)
            if (why === null) return reopen(id)
            await write({ ...list(), [id]: why }, id)
          }}
        />
      ),
      undefined,
      navTo(id),
    )
  }

  async function reset() {
    const ok = await DialogConfirm.show(
      dialog,
      "Reset to Lunos defaults",
      `Remove recommended from ${props.scope} config? The pickers go back to Lunos's curated list (unless another config sets one).`,
      undefined,
      navTo("+reset"),
    )
    if (ok !== true) return reopen("+reset")
    await write(undefined, "+reset")
  }

  const status = (id: string) => {
    const slash = id.indexOf("/")
    const model = sync.data.provider.find((item) => item.id === id.slice(0, slash))?.models[id.slice(slash + 1)]
    if (!model) return "not available here"
    if (model.blocked) return "blocked by policy"
  }

  const options = () => {
    const entries = Object.entries(list()).map(([id, why]) => ({
      title: id,
      value: id,
      details: [why || "(no reason)"],
      footer: [lunosDefault() ? "Lunos default" : "", status(id) ?? ""].filter(Boolean).join(" · ") || undefined,
      category: lunosDefault() ? "Lunos defaults" : "Recommended models",
    }))
    // Actions first, as in Agents: the list can be longer than the screen.
    return [
      { title: "Add model…", value: "+add", category: "Actions" },
      {
        title: "Reset to Lunos defaults",
        value: "+reset",
        description: `remove recommended from ${props.scope} config`,
        category: "Actions",
      },
      ...entries,
    ]
  }

  return (
    <DialogSelect<string>
      title={`Recommended · ${props.scope} config${row()?.locked ? " · 🔒 managed" : ""}`}
      placeholder="Curated picks, shown under Recommended in the model picker (not an evaluation)"
      skipFilter
      current={props.focus}
      ref={(ref: DialogSelectRef<string>) => props.focus && focusWhenReady(ref, options, props.focus)}
      options={snapshot() ? options() : []}
      footerHints={[{ title: "change", label: "enter" }]}
      onSelect={(option) => {
        if (locked()) return
        if (option.value === "+add") return add()
        if (option.value === "+reset") return void reset()
        entry(option.value)
      }}
    />
  )
}

function focusWhenReady<T>(ref: DialogSelectRef<T>, options: () => { value: T }[], focus: T) {
  const start = Date.now()
  const tick = () => {
    if (options().some((option) => option.value === focus)) return ref.moveTo(focus)
    if (Date.now() - start < 3000) setTimeout(tick, 50)
  }
  setTimeout(tick, 0)
}
