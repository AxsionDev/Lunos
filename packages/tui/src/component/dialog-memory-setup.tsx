import type { SettingRow } from "@opencode-ai/sdk/v2"
import { MemorySetup } from "@opencode-ai/core/memory-setup"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useOpencodeKeymap } from "../keymap"
import { DialogModel } from "./dialog-model"

// XCOD-249: /settings → Memory → "Set up memory…". Six short steps, each with a recommended answer,
// so pressing Enter through them gives a working setup; then a summary that saves. Nothing is
// written before Save, so Esc at any step leaves the config as it was, and nothing is downloaded
// before step 4 is confirmed (the download happens in step 6's check). Every other memory option
// stays under Advanced in the settings list.

type Scope = "user" | "project"
type Check = { ok: boolean; scope?: string; ms?: number; error?: string; fix?: string }

const RETENTION = [
  { title: "Keep facts until I remove them", value: 0, description: "recommended" },
  { title: "30 days", value: 30 },
  { title: "90 days", value: 90 },
  { title: "Custom…", value: -1 },
]

export function useMemorySetup() {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const keymap = useOpencodeKeymap()

  return (input: { scope: Scope; rows: readonly SettingRow[]; onExit: () => void }) => {
    const memory = sync.data.config.memory as Parameters<typeof MemorySetup.initial>[0]
    const rows = input.rows as readonly MemorySetup.Row[]
    const stop = MemorySetup.blocked(rows, memory)
    if (stop) {
      toast.show({ variant: "warning", title: "Memory can't be set up", message: stop, duration: 10000 })
      return
    }
    const draft = MemorySetup.initial(memory)
    let check: Check | undefined
    let download = false
    const fixed = (key: MemorySetup.Key) => MemorySetup.locked(rows, key)
    const show = (render: () => any, back?: () => void) =>
      dialog.replace(render, undefined, back ? { back } : { back: input.onExit })
    const smallModel = () => sync.data.config.small_model ?? sync.data.config.model ?? "the main model"

    // 1. Turn on memory?
    const step1 = () => {
      if (fixed("memory.enabled")) return step2()
      show(() => (
        <DialogSelect
          title="Set up memory · 1 of 6 · Turn on memory?"
          placeholder="Memory remembers facts about your project and recalls them in later sessions. It's off by default."
          skipFilter
          current={draft.enabled}
          options={[
            { title: "On", value: true, description: "recommended" },
            { title: "Off", value: false, description: "nothing is remembered or recalled" },
          ]}
          onSelect={(option) => {
            draft.enabled = option.value
            if (!draft.enabled) return summary(step1)
            step2()
          }}
        />
      ))
    }

    // 2. Where is memory kept?
    const step2 = () => {
      if (fixed("memory.backend")) return step3()
      show(
        () => (
          <DialogSelect
            title="Set up memory · 2 of 6 · Where is memory kept?"
            skipFilter
            current={draft.backend.type}
            options={[
              { title: "On this machine", value: "embedded", description: "recommended" },
              {
                title: "A team Neo4j database…",
                value: "neo4j",
                description: "URL, region and credentials by reference",
              },
            ]}
            onSelect={(option) => {
              if (option.value === "embedded") {
                draft.backend = { type: "embedded" }
                if (draft.encryption === "off" && !memory?.encryption) draft.encryption = "os-keychain"
                return step3()
              }
              void neo4j()
            }}
          />
        ),
        step1,
      )
    }

    const ask = (dlg: DialogContext, title: string, placeholder: string, value: string) =>
      DialogPrompt.show(dlg, title, { placeholder, value })

    const neo4j = async () => {
      const current = draft.backend.type === "neo4j" ? draft.backend : undefined
      const url = await ask(dialog, "Neo4j URL", "bolt+s://graph.internal:7687", current?.url ?? "")
      if (url === null || url === undefined) return step2()
      const jurisdiction = await ask(
        dialog,
        "Where it runs",
        'region, e.g. "EU-DE" (checked against your residency policy)',
        current?.jurisdiction ?? "",
      )
      if (jurisdiction === null || jurisdiction === undefined) return step2()
      const username = await ask(
        dialog,
        "Username",
        "{env:NEO4J_USER} or {file:path}",
        current?.username ?? "{env:NEO4J_USER}",
      )
      if (username === null || username === undefined) return step2()
      const password = await ask(
        dialog,
        "Password",
        "{env:NEO4J_PASSWORD} or {file:path}; a literal password is refused",
        current?.password ?? "{env:NEO4J_PASSWORD}",
      )
      if (password === null || password === undefined) return step2()
      const backend = {
        type: "neo4j" as const,
        url: url.trim(),
        jurisdiction: jurisdiction.trim(),
        username: username.trim(),
        password: password.trim(),
      }
      // The same checks as connecting (TLS, references, region against the residency policy).
      const result = await sdk.client.memory.setup
        .backend({ memorySetupInput: { memory: MemorySetup.block({ ...draft, backend, encryption: "off" }) } })
        .catch(() => undefined)
      const verdict = result?.data
      if (!verdict?.ok) {
        toast.show({
          variant: "error",
          title: "That database can't be used",
          message: verdict?.error ?? "The server didn't answer",
          duration: 12000,
        })
        return step2()
      }
      for (const warning of verdict.warnings) toast.show({ variant: "warning", message: warning, duration: 10000 })
      draft.backend = backend
      draft.encryption = "off"
      step3()
    }

    // 3. Which model extracts facts?
    const step3 = () => {
      if (fixed("memory.model")) return step4()
      show(
        () => (
          <DialogSelect
            title="Set up memory · 3 of 6 · Which model extracts facts?"
            skipFilter
            current={draft.model ? "pick" : "small"}
            options={[
              { title: "The small model", value: "small", description: `${smallModel()} (recommended)` },
              {
                title: draft.model ? `Another model: ${draft.model}` : "Pick a model…",
                value: "pick",
                description: "models your policy blocks are marked",
              },
            ]}
            onSelect={(option) => {
              if (option.value === "small") {
                draft.model = undefined
                return step4()
              }
              show(
                () => (
                  <DialogModel
                    title="Memory model"
                    onPick={(providerID, modelID) => {
                      draft.model = `${providerID}/${modelID}`
                      step4()
                    }}
                  />
                ),
                step3,
              )
            }}
          />
        ),
        step2,
      )
    }

    // 4. First-start download.
    const step4 = () => {
      const offline = !!process.env.LUNOS_OFFLINE
      show(
        () => (
          <DialogSelect
            title="Set up memory · 4 of 6 · First-start download"
            placeholder={offline ? MemorySetup.OFFLINE_DOWNLOAD : MemorySetup.DOWNLOAD}
            skipFilter
            current={download || !check ? "now" : "later"}
            options={[
              {
                title: offline ? "Use what's already cached" : "Download now",
                value: "now",
                description: "recommended: step 6 downloads and checks it",
              },
              { title: "Later", value: "later", description: "the first session that uses memory downloads it" },
            ]}
            onSelect={(option) => {
              download = option.value === "now"
              step5()
            }}
          />
        ),
        step3,
      )
    }

    // 5. Privacy: retention, then encryption.
    const step5 = () => {
      if (fixed("memory.retention.days")) return encryption()
      show(
        () => (
          <DialogSelect
            title="Set up memory · 5 of 6 · How long are facts kept?"
            skipFilter
            current={RETENTION.find((item) => item.value === (draft.retentionDays ?? 0))?.value ?? -1}
            options={RETENTION}
            onSelect={async (option) => {
              if (option.value >= 0) {
                draft.retentionDays = option.value || undefined
                return encryption()
              }
              const days = await ask(
                dialog,
                "Keep facts for how many days?",
                "e.g. 180",
                String(draft.retentionDays ?? ""),
              )
              const parsed = Number(days)
              if (!Number.isInteger(parsed) || parsed <= 0) {
                if (days) toast.show({ variant: "warning", message: `"${days}" isn't a whole number of days` })
                return step5()
              }
              draft.retentionDays = parsed
              encryption()
            }}
          />
        ),
        step4,
      )
    }

    const encryption = () => {
      if (fixed("memory.encryption")) return step6()
      const external = draft.backend.type === "neo4j"
      show(
        () => (
          <DialogSelect
            title="Set up memory · 5 of 6 · Encrypt the fact ledger?"
            placeholder={
              external
                ? "The OS keychain holds one person's key, so a shared database is encrypted at rest on the server instead."
                : "The key stays in your OS keychain. This covers Lunos's fact ledger, not the engine's own database files."
            }
            skipFilter
            current={draft.encryption}
            options={
              external
                ? [{ title: "Off (encrypt the database on the server)", value: "off" as const }]
                : [
                    {
                      title: "Encrypt with the OS keychain",
                      value: "os-keychain" as const,
                      description: "recommended",
                    },
                    { title: "Off", value: "off" as const },
                  ]
            }
            onSelect={(option) => {
              draft.encryption = option.value
              step6()
            }}
          />
        ),
        step5,
      )
    }

    // 6. Check it works.
    const step6 = () => {
      if (!download) return summary(encryption)
      const result = check
      show(
        () => (
          <DialogSelect
            title="Set up memory · 6 of 6 · Check it works"
            placeholder={
              result
                ? result.ok
                  ? `✓ Remembered, recalled and removed a test fact in ${result.scope} memory (${((result.ms ?? 0) / 1000).toFixed(1)} s)`
                  : `✗ ${result.error}${result.fix ? ` — ${result.fix}` : ""}`
                : "Remembers a test fact, recalls it, then removes it. The first run downloads the engine and can take a few minutes."
            }
            skipFilter
            options={[
              ...(result?.ok ? [{ title: "Continue", value: "next", description: "to the summary" }] : []),
              {
                title: result ? "Run the check again" : "Run the check",
                value: "run",
                description: result ? "" : "recommended",
              },
              ...(result && !result.ok ? [{ title: "Continue without a passing check", value: "next" }] : []),
              ...(!result ? [{ title: "Skip", value: "next" }] : []),
            ]}
            onSelect={(option) => {
              if (option.value === "next") return summary(step6)
              void running()
            }}
          />
        ),
        encryption,
      )
    }

    const running = async () => {
      show(
        () => (
          <DialogSelect
            title="Set up memory · 6 of 6 · Checking…"
            placeholder="Starting memory with these settings, then remembering and recalling a test fact."
            options={[]}
            locked
            emptyView={<text>Checking… the first start downloads packages and the embedding model.</text>}
          />
        ),
        step6,
      )
      const result = await sdk.client.memory.setup
        .check({ memorySetupInput: { memory: MemorySetup.block(draft) } })
        .catch(() => undefined)
      check = (result?.data as Check | undefined) ?? { ok: false, error: "The server didn't answer" }
      step6()
    }

    // Summary: what is saved, and where. Save, Back or Cancel.
    const summary = (back: () => void) => {
      const writes = MemorySetup.writes(draft, memory, rows)
      const conflicts = MemorySetup.conflicts(rows, input.scope)
      const lines = [
        ...(writes.length
          ? writes.map((write) => ("unset" in write ? `${write.key}: removed` : `${write.key} = ${write.value}`))
          : ["Nothing changes."]),
        ...rows
          .filter((row) => row.locked && MemorySetup.KEYS.some((key) => row.key === key))
          .map((row) => `${row.key}: set by your organisation`),
        ...conflicts.map((line) => `⚠ ${line}`),
      ]
      show(
        () => (
          <DialogSelect
            title={`Set up memory · Summary (saves to the ${input.scope} config)`}
            placeholder={lines.join(" · ")}
            skipFilter
            options={[
              {
                title: "Save",
                value: "save",
                description: writes.length ? `${writes.length} setting(s)` : "nothing to save",
              },
              { title: "Back", value: "back" },
              { title: "Cancel", value: "cancel", description: "nothing is saved" },
            ]}
            onSelect={(option) => {
              if (option.value === "back") return back()
              if (option.value === "cancel") return input.onExit()
              void save(writes)
            }}
          />
        ),
        back,
      )
    }

    const save = async (writes: MemorySetup.Write[]) => {
      for (const write of writes) {
        const result = await sdk.client.config
          .settingsSet({
            settingsSetInput:
              "unset" in write
                ? { key: write.key, value: "", scope: input.scope, unset: true }
                : { key: write.key, value: write.value, scope: input.scope },
          })
          .catch(() => undefined)
        const data = result?.data
        if (!data?.ok) {
          toast.show({
            variant: "error",
            title: `${write.key} not saved`,
            message: data && !data.ok ? data.error : "The server didn't answer",
            duration: 10000,
          })
          return input.onExit()
        }
      }
      if (!writes.length) return input.onExit()
      toast.show({ variant: "success", message: `Memory setup saved to the ${input.scope} config`, duration: 6000 })
      const restart = await DialogConfirm.show(
        dialog,
        "Restart required",
        "Memory settings take effect after a restart. Restart Lunos now?",
        "later",
      )
      if (restart === true) {
        dialog.clear()
        keymap.dispatchCommand("app.restart")
        return
      }
      input.onExit()
    }

    step1()
  }
}
