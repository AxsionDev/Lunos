import { createEffect, createMemo, createResource } from "solid-js"
import { useRenderer } from "@opentui/solid"
import type { AgentFileEntry, SettingsSnapshot } from "@opencode-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog, type DialogNav } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { openEditor, openFileInEditor } from "../editor"
import { useOpencodeKeymap } from "../keymap"
import { DialogModel } from "./dialog-model"
import { DialogVariantSetting, useVariantModel, variantWarning } from "./dialog-variant-setting"

// XCOD-215: /settings → Agents and /agents, one screen (XCOD-210 built /agents; this replaces it).
// The list shows every agent with what it does; an agent's screen edits its `agent.<name>.*` keys
// with proper controls. Saves go through PATCH /config/settings, so organisation locks, model and
// residency checks are the same as everywhere else.

type Scope = "user" | "project"

export const AGENTS_HELP =
  "Agents are optional. Lunos works without changes here. Use this to give an agent a different model, limits or permissions. See docs/agents.md."

const KIND_LABEL = { main: "Main agents", subagent: "Subagents", helper: "Helpers" } as const
const KIND_SHORT = { main: "main", subagent: "subagent", helper: "helper" } as const
const HELPER_HELP: Record<string, string> = {
  title: "Names new sessions from their first message",
  summary: "Summarises a session for sharing and the session list",
  compaction: "Compacts a long conversation so it fits the model's context",
}

const COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"]

function kindOf(agent: AgentFileEntry) {
  return agent.kind ?? (agent.mode === "subagent" ? "subagent" : "main")
}

function describe(agent: AgentFileEntry) {
  return agent.description ?? HELPER_HELP[agent.name] ?? (agent.native ? "" : "Your agent")
}

function home(file: string) {
  const dir = process.env.HOME
  return dir && file.startsWith(dir + "/") ? "~" + file.slice(dir.length) : file
}

/** Locked by organisation policy: `agent`, `agent.<name>` or `agent.<name>.<field>` in `$locked`. */
function lockedKey(locked: readonly string[], key: string) {
  return locked.find((entry) => key === entry || key.startsWith(`${entry}.`))
}

/**
 * Highlights the row a screen was reopened on (XCOD-233: ← comes back to the row that opened the
 * screen). The rows load from the server after the list is drawn, so wait for them.
 */
function focusWhenLoaded<T>(list: DialogSelectRef<T>, options: () => { value: T }[], focus: T | undefined) {
  if (focus === undefined) return
  let done = false
  createEffect(() => {
    if (done || !options().some((option) => option.value === focus)) return
    done = true
    setTimeout(() => list.moveTo(focus), 0)
  })
}

// Hooks: call at component setup, not from a handler (Solid's contexts resolve only during setup).
function useAgentSave(
  scope: () => Scope,
  locked: () => readonly string[],
  after: (key: string) => void,
  nav?: (key: string) => DialogNav | undefined,
) {
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()
  const keymap = useOpencodeKeymap()
  return async (key: string, value: string | undefined) => {
    const lock = lockedKey(locked(), key)
    if (lock) {
      toast.show({
        variant: "warning",
        message: `${key} is set by your organisation's policy (${lock}) and can't be changed here`,
      })
      return after(key)
    }
    const result = await sdk.client.config
      .settingsSet({
        settingsSetInput: { key, value: value ?? "", scope: scope(), ...(value === undefined ? { unset: true } : {}) },
      })
      .catch(() => undefined)
    const data = result?.data
    if (!data || !data.ok) {
      toast.show({
        variant: "error",
        title: `${key} not saved`,
        message: data && !data.ok ? data.error : "The server didn't answer",
        duration: 8000,
      })
      return after(key)
    }
    toast.show({
      variant: "success",
      message:
        value === undefined
          ? `${key} ${data.changed ? "reset to default" : "wasn't set"} (${data.scope} config: ${home(data.file)})`
          : `${key} = ${value} (saved to ${data.scope} config: ${home(data.file)})`,
      duration: 5000,
    })
    if (data.restart && data.changed) {
      const restart = await DialogConfirm.show(
        dialog,
        "Restart required",
        `${key} takes effect after a restart. Restart Lunos now?`,
        "later",
        nav?.(key),
      )
      if (restart === true) {
        dialog.clear()
        keymap.dispatchCommand("app.restart")
        return
      }
    }
    after(key)
  }
}

/**
 * `onBack` is set when /settings opened the list (XCOD-233): then these screens are part of the
 * /settings window, ← goes back one level and Esc closes it all. /agents keeps Esc as it was.
 */
export function DialogAgentList(props: { scope?: Scope; focus?: string; onBack?: () => void }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const scope = () => props.scope ?? "user"
  const generation = dialog.generation
  /** In the /settings window: how a screen opened from here comes back to `focus`. */
  const navTo = (focus?: string): DialogNav | undefined =>
    props.onBack ? { back: () => reopen(focus), generation } : undefined
  const [agents] = createResource(async () => (await sdk.client.config.agents()).data ?? [])
  const [snapshot] = createResource(
    async () => (await sdk.client.config.settings()).data as SettingsSnapshot | undefined,
  )
  const locked = () => snapshot()?.locked ?? []
  const reopen = (focus?: string) =>
    dialog.replace(
      () => <DialogAgentList scope={scope()} focus={focus} onBack={props.onBack} />,
      undefined,
      props.onBack ? { back: props.onBack, generation } : undefined,
    )
  const save = useAgentSave(
    scope,
    locked,
    () => reopen(),
    () => navTo(),
  )

  const deprecated = createMemo(() => {
    const rows = snapshot()?.rows ?? []
    const mode = rows.find((row) => row.key === "mode" && row.source !== "default")
    const fields = (agents() ?? []).flatMap((agent) =>
      (["user", "project"] as const).flatMap((where) =>
        ["tools", "maxSteps"]
          .filter((key) => agent.overrides?.[where]?.[key] !== undefined)
          .map((key) => `agent.${agent.name}.${key}`),
      ),
    )
    return [...(mode ? ["mode"] : []), ...fields]
  })

  const options = createMemo(() => {
    const list = agents() ?? []
    const rank = { main: 0, subagent: 1, helper: 2 } as const
    const rows = list
      .toSorted((a, b) => rank[kindOf(a)] - rank[kindOf(b)] || a.name.localeCompare(b.name))
      .map((agent) => ({
        value: agent.name,
        title: agent.name,
        description: describe(agent),
        category: KIND_LABEL[kindOf(agent)],
        footer: [
          KIND_SHORT[kindOf(agent)],
          agent.model ? (agent.model === "inherit" ? "inherits" : agent.model) : "inherits",
          agent.disabled ? "off" : "on",
        ].join(" · "),
      }))
    return [
      { value: "+new", title: "New agent…", description: "an agent of your own, set up here", category: "Agents" },
      ...(deprecated().length
        ? [
            {
              value: "+migrate",
              title: "Migrate deprecated keys…",
              description: deprecated().join(", "),
              category: "Agents",
            },
          ]
        : []),
      ...rows,
    ]
  })

  async function create() {
    const name = (
      await DialogPrompt.show(dialog, "New agent", { placeholder: "name, e.g. reviewer", nav: navTo("+new") })
    )?.trim()
    if (!name) return reopen("+new")
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
      toast.show({ variant: "error", message: "Use letters, digits, - and _ for the name" })
      return reopen()
    }
    const description = (
      await DialogPrompt.show(dialog, `${name}: what it does`, {
        placeholder: "one line, shown in the agent list",
        nav: navTo("+new"),
      })
    )?.trim()
    if (description === undefined) return reopen("+new")
    await save(`agent.${name}.description`, description || name)
    detail(name)
  }

  function detail(name: string) {
    dialog.replace(
      () => <DialogAgentDetail name={name} scope={scope()} nav={!!props.onBack} onBack={() => reopen(name)} />,
      undefined,
      navTo(name),
    )
  }

  // Deprecated keys can be in either scope's files; migrate both.
  async function migrate() {
    const done: string[] = []
    for (const where of ["user", "project"] as const) {
      const result = (
        await sdk.client.config.agentsMigrate({ agentsMigrateInput: { scope: where } }).catch(() => undefined)
      )?.data
      if (!result || !result.ok) {
        toast.show({ variant: "error", message: result && !result.ok ? result.error : "The server didn't answer" })
        return reopen()
      }
      if (result.migrated.length) done.push(`${result.migrated.join(", ")} in ${home(result.file)}`)
    }
    toast.show({
      variant: "success",
      message: done.length ? `Migrated ${done.join("; ")}` : "Nothing to migrate",
      duration: 8000,
    })
    reopen()
  }

  return (
    <DialogSelect
      title={`Agents · ${scope()} config`}
      placeholder={AGENTS_HELP}
      current={props.focus}
      ref={(list) => focusWhenLoaded(list, options, props.focus)}
      options={options()}
      footerHints={[{ title: "open", label: "enter" }]}
      onSelect={(option) => {
        if (option.value === "+new") return void create()
        if (option.value === "+migrate") return void migrate()
        detail(option.value)
      }}
    />
  )
}

export function DialogAgentDetail(props: {
  name: string
  scope: Scope
  focus?: string
  onBack: () => void
  /** Part of the /settings window (XCOD-233): ← goes back one level, Esc closes it. */
  nav?: boolean
}) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const renderer = useRenderer()
  const { theme } = useTheme()
  const [agents] = createResource(async () => (await sdk.client.config.agents()).data ?? [])
  const [snapshot] = createResource(
    async () => (await sdk.client.config.settings()).data as SettingsSnapshot | undefined,
  )
  const agent = createMemo(() => agents()?.find((item) => item.name === props.name))
  const locked = () => snapshot()?.locked ?? []
  const generation = dialog.generation
  const reopen = (focus?: string) =>
    dialog.replace(
      () => (
        <DialogAgentDetail name={props.name} scope={props.scope} focus={focus} onBack={props.onBack} nav={props.nav} />
      ),
      undefined,
      props.nav ? { back: props.onBack, generation } : undefined,
    )
  /** A picker or prompt opened from field `field`; ← comes back to it. */
  const navTo = (field: string): DialogNav | undefined =>
    props.nav ? { back: () => reopen(field), generation } : undefined
  const key = (field: string) => `agent.${props.name}.${field}`
  const own = (field: string) => agent()?.overrides?.[props.scope]?.[field]
  // A whole-agent reset goes back to the list; a field change comes back to that field.
  const write = useAgentSave(
    () => props.scope,
    locked,
    (saved) => (saved === `agent.${props.name}` ? props.onBack() : reopen(saved.split(".")[2])),
    (saved) => navTo(saved.split(".")[2] ?? "+reset"),
  )
  const save = (field: string) => (value: string | undefined) => write(key(field), value)

  const fileFor = (target: "config") => snapshot()?.files?.[props.scope]?.[target]
  const variantFor = useVariantModel()
  /** XCOD-232: the model this agent's variant applies to, and its variants. */
  const variantApplies = () => {
    const item = agent()
    return item ? variantFor(key("variant"), { model: item.model, subagent: item.kind === "subagent" }) : undefined
  }

  function variant() {
    const value = own("variant") as string | undefined
    dialog.replace(
      () => (
        <DialogVariantSetting
          title={`${props.name}: variant`}
          settingKey={key("variant")}
          scope={props.scope}
          current={value ?? agent()?.variant}
          applies={variantApplies()}
          onPick={(picked) => void save("variant")(picked)}
          onClear={() => void save("variant")(undefined)}
        />
      ),
      undefined,
      navTo("variant"),
    )
  }

  async function editInFile(field: string, label: string) {
    const file = fileFor("config")
    if (!file) return reopen(field)
    const opened = await openFileInEditor({ file, renderer }).catch(() => false)
    toast.show({
      variant: "info",
      message: opened
        ? "Saved edits apply to new sessions"
        : `${label} is edited in the config file: set $EDITOR, or edit ${home(file)} ("agent" → "${props.name}" → "${field}")`,
      duration: 10000,
    })
    reopen(field)
  }

  async function number(field: string, label: string, hint: string) {
    const current = own(field)
    const value = await DialogPrompt.show(dialog, `${props.name}: ${label}`, {
      value: current === undefined ? "" : String(current),
      placeholder: `${hint}; empty = default`,
      nav: navTo(field),
    })
    if (value === null) return reopen(field)
    return save(field)(value.trim() === "" ? undefined : value.trim())
  }

  async function text(field: string, label: string, multiline: boolean) {
    const current =
      (own(field) as string | undefined) ?? (field === "prompt" ? agent()?.prompt : agent()?.description) ?? ""
    if (multiline) {
      const edited = await openEditor({ value: current, renderer }).catch(() => undefined)
      if (edited !== undefined) {
        if (edited === current) return reopen(field)
        return save(field)(edited.trim() === "" ? undefined : edited)
      }
    }
    const value = await DialogPrompt.show(dialog, `${props.name}: ${label}`, {
      value: current,
      placeholder: "empty = default",
      description: () => (
        <text fg={theme.textMuted}>{multiline ? "Set $EDITOR to edit this in your editor" : key(field)}</text>
      ),
      nav: navTo(field),
    })
    if (value === null) return reopen(field)
    return save(field)(value.trim() === "" ? undefined : value)
  }

  function choose(field: string, label: string, values: string[], current?: string) {
    dialog.replace(
      () => (
        <DialogSelect
          title={`${props.name}: ${label}`}
          skipFilter
          current={current ?? "default"}
          options={[
            { title: "default", value: "default", description: "remove the override" },
            ...values.map((value) => ({ title: value, value })),
          ]}
          onSelect={(option) => void save(field)(option.value === "default" ? undefined : option.value)}
        />
      ),
      undefined,
      navTo(field),
    )
  }

  function model() {
    const value = own("model") as string | undefined
    const slash = value?.indexOf("/") ?? -1
    const subagent = agent()?.kind === "subagent"
    dialog.replace(
      () => (
        <DialogModel
          title={`${props.name}: model`}
          choices={[
            {
              title: "Inherit",
              description: subagent ? "the main agent's model (default)" : "the session's model (default)",
              onSelect: () => void save("model")(undefined),
            },
            ...(subagent
              ? [{ title: "Small model", description: "small_model", onSelect: () => void save("model")("small") }]
              : []),
          ]}
          current={
            value && slash > 0 ? { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) } : undefined
          }
          onPick={(providerID, modelID) => void save("model")(`${providerID}/${modelID}`)}
        />
      ),
      undefined,
      navTo("model"),
    )
  }

  async function reset() {
    const ok = await DialogConfirm.show(
      dialog,
      `Reset ${props.name}`,
      `Remove every override for ${props.name} from ${props.scope} config?`,
      undefined,
      navTo("+reset"),
    )
    if (ok !== true) return reopen("+reset")
    await write(`agent.${props.name}`, undefined)
  }

  const options = createMemo(() => {
    const item = agent()
    if (!item) return []
    const helper = item.kind === "helper"
    const set = (field: string) => own(field) !== undefined
    const show = (field: string, value: unknown, fallback: string) =>
      `${value === undefined ? fallback : String(value)}${set(field) ? "" : " (default)"}${lockedKey(locked(), key(field)) ? " 🔒" : ""}`
    const rows = [
      { value: "model", title: "Model", footer: show("model", item.model, "inherits") },
      // XCOD-310: the approval a new session starts this workflow in; <leader>p switches it per session.
      ...(kindOf(item) === "main"
        ? [
            {
              value: "permission_mode",
              title: "Default approval",
              footer: show("permission_mode", own("permission_mode"), "manual"),
            },
          ]
        : []),
      { value: "disable", title: "On / off", footer: show("disable", item.disabled ? "off" : "on", "on") },
      ...(helper
        ? []
        : [
            { value: "mode", title: "Type", footer: show("mode", item.mode, item.mode) },
            {
              value: "hidden",
              title: "Hidden from the @ menu",
              footer: show("hidden", item.hidden ? "yes" : "no", "no"),
            },
            { value: "steps", title: "Max steps", footer: show("steps", item.steps, "default") },
            {
              value: "temperature",
              title: "Temperature",
              footer: show("temperature", item.temperature, "model default"),
            },
            { value: "top_p", title: "Top P", footer: show("top_p", item.topP, "model default") },
            {
              value: "variant",
              title: "Variant",
              footer:
                show("variant", item.variant, "default") +
                (variantWarning(item.variant, variantApplies())
                  ? ` ⚠ ${variantWarning(item.variant, variantApplies())}`
                  : ""),
            },
            { value: "description", title: "Description", footer: set("description") ? "set" : "default" },
            { value: "prompt", title: "Prompt", footer: set("prompt") ? "set" : "default" },
            { value: "permission", title: "Permissions", footer: set("permission") ? "set (config file)" : "default" },
            { value: "color", title: "Colour", footer: show("color", item.color, "default") },
            { value: "options", title: "Advanced (options, JSON)", footer: set("options") ? "set" : "none" },
          ]),
      ...(item.file
        ? [{ value: "+file", title: "Edit the agent file…", description: home(item.file), footer: "$EDITOR" }]
        : []),
      {
        value: "+reset",
        title: "Reset to default",
        description: `remove ${props.name}'s overrides from ${props.scope} config`,
      },
      { value: "+back", title: "← Back to agents" },
    ]
    return rows.map((row) => ({ ...row, category: row.value.startsWith("+") ? "Actions" : props.name }))
  })

  async function editFile() {
    const item = agent()
    if (!item?.file || item.text === undefined) return reopen("+file")
    const edited = await openEditor({ value: item.text, renderer }).catch(() => undefined)
    if (edited === undefined) {
      toast.show({
        variant: "info",
        message: `Set $EDITOR to edit agents here, or use \`lunos agent edit ${item.name}\``,
      })
      return reopen("+file")
    }
    if (edited !== item.text) {
      const result = (
        await sdk.client.config.agentSave({ agentSaveInput: { name: item.name, text: edited } }).catch(() => undefined)
      )?.data
      if (!result || !result.ok)
        toast.show({
          variant: "error",
          title: `${item.name} not saved`,
          message: result && !result.ok ? result.problems.join("\n") : "The server didn't answer",
          duration: 10000,
        })
      else toast.show({ variant: "success", message: `${item.name} saved (${home(result.file)}); new sessions use it` })
    }
    reopen("+file")
  }

  function select(field: string) {
    const item = agent()
    if (!item) return
    const lock = lockedKey(locked(), key(field))
    if (lock && !field.startsWith("+")) {
      toast.show({
        variant: "warning",
        message: `${key(field)} is set by your organisation's policy (${lock}) and can't be changed here`,
      })
      return
    }
    switch (field) {
      case "model":
        return model()
      case "permission_mode":
        return choose(
          "permission_mode",
          "default approval",
          ["manual", "auto"],
          own("permission_mode") as string | undefined,
        )
      case "disable":
        return void save("disable")(item.disabled ? undefined : "true")
      case "hidden":
        return void save("hidden")(item.hidden ? undefined : "true")
      case "mode":
        return choose("mode", "type", ["primary", "subagent", "all"], own("mode") as string | undefined)
      case "color":
        return choose("color", "colour", COLORS, own("color") as string | undefined)
      case "steps":
        return void number("steps", "max steps", "a whole number, e.g. 25")
      case "temperature":
        return void number("temperature", "temperature", "0 to 2")
      case "top_p":
        return void number("top_p", "top P", "0 to 1")
      case "variant":
        return variant()
      case "description":
        return void text("description", "description", false)
      case "prompt":
        return void text("prompt", "prompt", true)
      case "permission":
        return void editInFile("permission", "Permissions")
      case "options":
        return void editInFile("options", "Advanced options")
      case "+file":
        return void editFile()
      case "+reset":
        return void reset()
      case "+back":
        return props.onBack()
    }
  }

  return (
    <DialogSelect
      title={`${props.name} · ${props.scope} config`}
      placeholder={describe(agent() ?? ({ name: props.name } as AgentFileEntry)) || AGENTS_HELP}
      skipFilter
      current={props.focus}
      ref={(list) => focusWhenLoaded(list, options, props.focus)}
      options={options()}
      footerHints={[{ title: "change", label: "enter" }]}
      onSelect={(option) => select(option.value)}
    />
  )
}
