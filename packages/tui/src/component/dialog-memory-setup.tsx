import type { MemorySetupEnvironment, MemorySetupTemplate, SettingRow } from "@opencode-ai/sdk/v2"
import { MemorySetup } from "@opencode-ai/core/memory-setup"
import { MemoryStorage } from "@opencode-ai/core/memory-storage"
import { createSignal, For } from "solid-js"
import { useTheme } from "../context/theme"
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
type Template = { name: string; scope: Scope }

/** "What this means" (or any short text) under a list, wrapped. */
function Lines(props: { lines: readonly string[] }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" paddingTop={1}>
      <For each={props.lines}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
    </box>
  )
}

/** A card that can't be picked yet: shown greyed out rather than hidden. */
function Muted(props: { text: string }) {
  const { theme } = useTheme()
  return <text fg={theme.textMuted}>{props.text}</text>
}

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
    let draft = MemorySetup.initial(memory)
    let check: Check | undefined
    // XCOD-264: the storage step's facts about this machine, fetched once per run of the wizard.
    let env: MemorySetupEnvironment | undefined
    // A Docker template that was started: its .env holds what the block's {env:} references need.
    let template: Template | undefined
    let move: boolean | undefined
    const environment = async () => {
      env ??= await sdk.client.memory.setup
        .environment()
        .then((result) => result.data)
        .catch(() => undefined)
      return env ?? { environment: { paths: {}, localModels: [] }, templates: [] }
    }
    let download = false
    const fixed = (key: MemorySetup.Key) => MemorySetup.locked(rows, key)
    const show = (render: () => any, back?: () => void) =>
      dialog.replace(render, undefined, back ? { back } : { back: input.onExit })
    const saveScope = () => input.scope
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
            if (!draft.enabled) return void summary(step1)
            step2()
          }}
        />
      ))
    }

    // 2. Where should memory be stored? (XCOD-264): start from a template, or choose from the cards.
    const step2 = () => {
      if (fixed("memory.backend")) return step3()
      show(
        () => (
          <DialogSelect
            title="Set up memory · 2 of 6 · Where should memory be stored?"
            skipFilter
            current={draft.backend.type === "embedded" && !template ? "choose" : undefined}
            options={[
              { title: "Choose storage myself", value: "choose", description: "the options, explained" },
              {
                title: "Start from a template",
                value: "template",
                description: "ready-made setups; some run a database in Docker",
              },
            ]}
            onSelect={(option) => void (option.value === "template" ? templates() : cards())}
          />
        ),
        step1,
      )
    }

    const cards = async (note?: string, highlight?: MemoryStorage.Kind) => {
      const { environment: machine } = await environment()
      const list = MemoryStorage.cards(machine as MemoryStorage.Environment)
      const start = list.find((card) => card.kind === (highlight ?? draft.backend.type)) ?? list[0]
      const [shown, setShown] = createSignal(start)
      show(
        () => (
          <DialogSelect
            title="Where should memory be stored?"
            skipFilter
            renderFilter={false}
            current={start.kind}
            options={list.map((card) => ({
              title: card.title,
              value: card.kind,
              titleView: card.unavailable ? <Muted text={card.title} /> : undefined,
              description: card.unavailable ?? card.recommended ?? card.summary,
            }))}
            onMove={(option) => setShown(list.find((card) => card.kind === option.value) ?? start)}
            footer={
              <Lines
                lines={[
                  ...(note ? [note, ""] : []),
                  `What this means — ${shown().title}${shown().unavailable ? ` (${shown().unavailable})` : ""}`,
                  ...MemoryStorage.meaning(shown()),
                ]}
              />
            }
            actions={[
              { command: "dialog.memory.setup.compare", title: "compare", withoutSelection: true, onTrigger: compare },
              { command: "dialog.memory.setup.help", title: "help me choose", withoutSelection: true, onTrigger: help },
            ]}
            onSelect={(option) => {
              const card = list.find((item) => item.kind === option.value)!
              if (card.unavailable)
                return toast.show({ variant: "info", message: `${card.title}: ${card.unavailable}`, duration: 5000 })
              if (card.kind === "embedded") {
                draft.backend = { type: "embedded" }
                template = undefined
                if (draft.encryption === "off" && !memory?.encryption) draft.encryption = "os-keychain"
                return step3()
              }
              void database(card.kind as MemorySetup.Database)
            }}
          />
        ),
        step2,
      )
    }

    const compare = async () => {
      const { environment: machine } = await environment()
      show(
        () => (
          <DialogSelect
            title="Compare where memory can be stored"
            skipFilter
            renderFilter={false}
            options={[{ title: "Back to the options", value: "back" }]}
            footer={<Lines lines={MemoryStorage.compareLines(machine as MemoryStorage.Environment, 28)} />}
            onSelect={() => void cards()}
          />
        ),
        () => void cards(),
      )
      dialog.setSize("xlarge")
    }

    const help = () => {
      const q = MemoryStorage.HELP_QUESTIONS
      const ask2 = (who: MemoryStorage.Who) => {
        if (who === "me") return void recommend(MemoryStorage.choose({ who, runs: "none" }))
        show(
          () => (
            <DialogSelect
              title={`Help me choose · ${q.runs.message}`}
              skipFilter
              options={q.runs.options.map((item) => ({ title: item.label, value: item.value }))}
              onSelect={(option) => void recommend(MemoryStorage.choose({ who, runs: option.value }))}
            />
          ),
          help,
        )
      }
      show(
        () => (
          <DialogSelect
            title={`Help me choose · ${q.who.message}`}
            skipFilter
            options={q.who.options.map((item) => ({ title: item.label, value: item.value }))}
            onSelect={(option) => ask2(option.value)}
          />
        ),
        () => void cards(),
      )
    }

    const recommend = (pick: { kind: MemoryStorage.Kind; reason: string }) =>
      cards(`Recommended: ${MemoryStorage.label(pick.kind)}. ${pick.reason}`, pick.kind)

    const ask = (dlg: DialogContext, title: string, placeholder: string, value: string) =>
      DialogPrompt.show(dlg, title, { placeholder, value })

    const USER = { neo4j: "{env:NEO4J_USER}", postgres: "{env:POSTGRES_USER}" }
    const PASSWORD = { neo4j: "{env:NEO4J_PASSWORD}", postgres: "{env:POSTGRES_PASSWORD}" }
    const URL_EXAMPLE = { neo4j: "bolt+s://graph.internal:7687", postgres: "postgres://db.internal:5432/lunos" }

    // A team database: URL, region and credentials by reference, then Test connection.
    const database = async (type: MemorySetup.Database) => {
      const current = draft.backend.type === type ? draft.backend : undefined
      const name = MemoryStorage.label(type)
      const url = await ask(dialog, `${name}: URL`, URL_EXAMPLE[type], current?.url ?? "")
      if (url === null || url === undefined) return cards()
      const jurisdiction = await ask(
        dialog,
        "Where it runs",
        'region, e.g. "EU-DE" (checked against your residency policy)',
        current?.jurisdiction ?? "",
      )
      if (jurisdiction === null || jurisdiction === undefined) return cards()
      const username = await ask(dialog, "Username", `${USER[type]} or {file:path}`, current?.username ?? USER[type])
      if (username === null || username === undefined) return cards()
      const password = await ask(
        dialog,
        "Password",
        `${PASSWORD[type]} or {file:path}; a literal password is refused`,
        current?.password ?? PASSWORD[type],
      )
      if (password === null || password === undefined) return cards()
      const backend = {
        type,
        url: url.trim(),
        jurisdiction: jurisdiction.trim(),
        username: username.trim(),
        password: password.trim(),
      }
      void test(backend)
    }

    type Database = Extract<MemorySetup.Backend, { url: string }>
    const test = async (backend: Database, from?: Template) => {
      show(
        () => (
          <DialogSelect
            title={`${MemoryStorage.label(backend.type)} · Testing the connection…`}
            options={[]}
            locked
            emptyView={<text>Connecting, then writing, reading and deleting a probe…</text>}
          />
        ),
        () => void cards(),
      )
      const result = await sdk.client.memory.setup
        .test({ memorySetupInput: { memory: { backend, encryption: "off" }, ...(from ? { template: from } : {}) } })
        .then((item) => item.data)
        .catch(() => undefined)
      const use = () => {
        draft.backend = backend
        draft.encryption = "off"
        template = from
        step3()
      }
      if (result?.ok) {
        toast.show({
          variant: "success",
          message: `Connected to ${result.server}: wrote, read and deleted a probe`,
          duration: 6000,
        })
        for (const warning of result.warnings ?? [])
          toast.show({ variant: "warning", message: warning, duration: 10000 })
        return use()
      }
      const error = result?.error ?? { stage: "connect", message: "The server didn't answer", type: "server" }
      // A setting or the residency policy refusing the database can't be saved; a failed connection can.
      const refused = error.stage === "settings" || error.stage === "residency"
      show(
        () => (
          <DialogSelect
            title={`${MemoryStorage.label(backend.type)} · ${refused ? "That database can't be used" : "The connection failed"}`}
            skipFilter
            renderFilter={false}
            options={[
              { title: "Test again", value: "again" },
              { title: "Change the settings", value: "edit" },
              ...(refused ? [] : [{ title: "Use these settings anyway", value: "use" }]),
              { title: "Back to the options", value: "back" },
            ]}
            footer={<Lines lines={[`✗ ${error.stage}: ${error.message}`, ...(error.fix ? [error.fix] : [])]} />}
            onSelect={(option) => {
              if (option.value === "again") return void test(backend, from)
              if (option.value === "edit") return void database(backend.type)
              if (option.value === "use") return use()
              void cards()
            }}
          />
        ),
        () => void cards(),
      )
    }

    // Templates (XCOD-264 PO addition): ready-made setups, some with a database in Docker.
    const templates = async () => {
      const { templates: list } = await environment()
      if (!list.length) return cards()
      const [shown, setShown] = createSignal<MemorySetupTemplate>(list[0])
      show(
        () => (
          <DialogSelect
            title="Start from a template"
            skipFilter
            renderFilter={false}
            options={list.map((item) => ({
              title: `${item.title}${item.organisation ? " (your organisation)" : ""}`,
              value: item.name,
              titleView: item.unavailable ? <Muted text={item.title} /> : undefined,
              description: item.unavailable ? "can't be used here" : undefined,
            }))}
            onMove={(option) => setShown(list.find((item) => item.name === option.value) ?? list[0])}
            footer={
              <Lines
                lines={[
                  ...(shown().description ? [shown().description!] : []),
                  `Leaves the computer: ${shown().leaves}.`,
                  ...(shown().unavailable ? [`Can't be used: ${shown().unavailable}`] : []),
                ]}
              />
            }
            onSelect={(option) => {
              const item = list.find((entry) => entry.name === option.value)!
              if (item.unavailable)
                return toast.show({ variant: "warning", message: `${item.title}: ${item.unavailable}`, duration: 8000 })
              void applyTemplate(item)
            }}
          />
        ),
        step2,
      )
    }

    const pickOne = (title: string, options: { title: string; value: string }[], back: () => void) =>
      new Promise<string | undefined>((resolve) =>
        show(
          () => (
            <DialogSelect title={title} skipFilter options={options} onSelect={(option) => resolve(option.value)} />
          ),
          () => {
            resolve(undefined)
            back()
          },
        ),
      )

    const applyTemplate = async (item: MemorySetupTemplate) => {
      const { environment: machine } = await environment()
      const values: { localModel?: string; vendor?: MemorySetup.Database } = {}
      if (item.requires?.includes("local-model")) {
        values.localModel =
          machine.localModels.length > 1
            ? await pickOne(
                "Which local model extracts facts?",
                machine.localModels.map((model) => ({ title: model, value: model })),
                templates,
              )
            : machine.localModels[0]
        if (!values.localModel) return
      }
      if (item.ask?.length) {
        const vendor = await pickOne(
          `${item.title} · Which database?`,
          [
            { title: "PostgreSQL", value: "postgres" },
            { title: "Neo4j", value: "neo4j" },
          ],
          templates,
        )
        if (!vendor) return
        draft = MemorySetup.apply(
          draft,
          MemoryStorage.memoryOf(item as MemoryStorage.Template, { vendor: vendor as MemorySetup.Database }),
        )
        return database(vendor as MemorySetup.Database)
      }
      const block = MemoryStorage.memoryOf(item as MemoryStorage.Template, values)
      if (!item.requires?.includes("docker")) {
        draft = MemorySetup.apply(draft, block)
        template = undefined
        return step3()
      }
      return preview(item, [])
    }

    // A Docker template: everything it writes, in full, before anything is written.
    const preview = async (item: MemorySetupTemplate, overwrite: string[]) => {
      const input = { name: item.name, scope: saveScope() }
      const got = await sdk.client.memory.setup
        .templatePreview({ memorySetupTemplateInput: input })
        .then((result) => result.data)
        .catch(() => undefined)
      if (!got?.ok) {
        toast.show({ variant: "error", message: got?.error ?? "The server didn't answer", duration: 10000 })
        return templates()
      }
      const existing = got.files.filter((file) => file.exists).map((file) => file.name)
      show(
        () => (
          <DialogSelect
            title={`${item.title} · Preview (nothing is written yet)`}
            skipFilter
            renderFilter={false}
            options={[
              existing.length
                ? {
                    title: `Replace ${existing.join(", ")} and write`,
                    value: "replace",
                    description: "these files already exist",
                  }
                : { title: "Write these files", value: "write", description: got.dir },
              { title: "Back", value: "back" },
              ...got.files.map((file) => ({
                title: `${file.path}${file.exists ? " (exists)" : ""}`,
                value: `file:${file.name}`,
                details: file.content.trimEnd().split("\n"),
              })),
              {
                title: "Memory config (credentials as {env:} references only)",
                value: "file:config",
                details: JSON.stringify(got.memory, null, 2).split("\n"),
              },
            ]}
            footer={<Lines lines={[...(got.licence ? [got.licence] : []), `Leaves the computer: ${item.leaves}.`]} />}
            onSelect={(option) => {
              if (option.value === "back") return void templates()
              if (option.value === "write" || option.value === "replace")
                return void write(item, got.memory, option.value === "replace" ? existing : overwrite)
            }}
          />
        ),
        () => void templates(),
      )
      dialog.setSize("large")
    }

    const write = async (item: MemorySetupTemplate, block: Record<string, unknown>, overwrite: string[]) => {
      const scope = saveScope()
      const got = await sdk.client.memory.setup
        .templateApply({ memorySetupTemplateInput: { name: item.name, scope, overwrite } })
        .then((result) => result.data)
        .catch(() => undefined)
      if (!got?.ok) {
        toast.show({ variant: "error", message: got?.error ?? "The server didn't answer", duration: 12000 })
        return preview(item, [])
      }
      toast.show({
        variant: "success",
        message: `Wrote ${got.files.map((file) => file.name).join(", ")} to ${got.dir}`,
      })
      draft = MemorySetup.apply(draft, block)
      startStep(item, got.command, got.dir)
    }

    const startStep = (item: MemorySetupTemplate, command: string, dir: string, error?: string[]) => {
      const env = [
        `Lunos reads the database's user and password from the environment. Before starting Lunos, load them:`,
        `  set -a; . ${dir}/.env; set +a`,
      ]
      show(
        () => (
          <DialogSelect
            title={`${item.title} · Start the database?`}
            skipFilter
            renderFilter={false}
            options={[
              { title: "Start it now", value: "now", description: "waits for it to be healthy, up to 2 minutes" },
              { title: "I'll start it myself", value: "later", description: "shows the command to copy" },
            ]}
            footer={<Lines lines={[...(error ?? []), "Start it now runs:", command, "", ...env]} />}
            onSelect={(option) => {
              if (option.value === "later") {
                template = undefined
                toast.show({ variant: "info", title: "Start it with", message: command, duration: 20000 })
                return step5()
              }
              void starting(item, command, dir)
            }}
          />
        ),
        () => void templates(),
      )
      dialog.setSize("large")
    }

    const starting = async (item: MemorySetupTemplate, command: string, dir: string) => {
      show(
        () => (
          <DialogSelect
            title={`${item.title} · Starting…`}
            options={[]}
            locked
            emptyView={<text>Running {command} and waiting for the healthcheck (up to 2 minutes)…</text>}
          />
        ),
        () => void templates(),
      )
      const scope = saveScope()
      const result = await sdk.client.memory.setup
        .templateStart({ memorySetupTemplateInput: { name: item.name, scope } })
        .then((got) => got.data)
        .catch(() => undefined)
      if (!result?.ok) {
        const error = result?.error
        return startStep(item, command, dir, [
          `✗ ${error?.stage ?? "start"}: ${error?.message ?? "The server didn't answer"}`,
          ...(error?.fix ? [error.fix] : []),
          "",
        ])
      }
      toast.show({
        variant: "success",
        message: `The database is healthy (${(Number(result.ms ?? 0) / 1000).toFixed(1)} s)`,
      })
      template = { name: item.name, scope }
      // Step 6 checks memory works against it.
      download = true
      step5()
    }

    // 3. Which model extracts facts?
    const step3 = () => {
      // A team database makes no model calls, and downloads nothing.
      if (draft.backend.type !== "embedded") return step5()
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
        () => (draft.backend.type === "embedded" ? step4() : step2()),
      )
    }

    const encryption = () => {
      if (fixed("memory.encryption")) return step6()
      const external = draft.backend.type !== "embedded"
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
      if (!download) return void summary(encryption)
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
              if (option.value === "next") return void summary(step6)
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
        .check({ memorySetupInput: { memory: MemorySetup.block(draft), ...(template ? { template } : {}) } })
        .catch(() => undefined)
      check = (result?.data as Check | undefined) ?? { ok: false, error: "The server didn't answer" }
      step6()
    }

    // Summary: what is saved, and where, and what the chosen storage means. Save, Back or Cancel.
    // Switching storage (XCOD-264) asks what happens to the facts already stored: Move or Start empty.
    const summary = async (back: () => void) => {
      const writes = MemorySetup.writes(draft, memory, rows)
      const conflicts = MemorySetup.conflicts(rows, input.scope)
      const switching = MemorySetup.switching(memory, draft)
      const { environment: machine } = await environment()
      const card = MemoryStorage.cards(machine as MemoryStorage.Environment, {
        host: draft.backend.type === "embedded" ? undefined : hostOf(draft.backend.url),
      }).find((item) => item.kind === draft.backend.type)
      const lines = [
        ...(writes.length
          ? writes.map((write) => ("unset" in write ? `${write.key}: removed` : `${write.key} = ${write.value}`))
          : ["Nothing changes."]),
        ...rows
          .filter((row) => row.locked && MemorySetup.KEYS.some((key) => row.key === key))
          .map((row) => `${row.key}: set by your organisation`),
        ...conflicts.map((line) => `⚠ ${line}`),
      ]
      const meaning =
        draft.enabled && card ? ["", `Stored: ${card.title}. What this means:`, ...MemoryStorage.meaning(card)] : []
      const moving = switching ? ["", `You're switching storage. ${MemorySetup.MOVE}`, MemorySetup.START_EMPTY] : []
      show(
        () => (
          <DialogSelect
            title={`Set up memory · Summary (saves to the ${input.scope} config)`}
            skipFilter
            renderFilter={false}
            options={[
              ...(switching
                ? [
                    { title: "Save and move my facts", value: "move", description: `${writes.length} setting(s)` },
                    { title: "Save and start empty", value: "save", description: "the old facts stay where they are" },
                  ]
                : [
                    {
                      title: "Save",
                      value: "save",
                      description: writes.length ? `${writes.length} setting(s)` : "nothing to save",
                    },
                  ]),
              { title: "Back", value: "back" },
              { title: "Cancel", value: "cancel", description: "nothing is saved" },
            ]}
            footer={<Lines lines={[...lines, ...meaning, ...moving]} />}
            onSelect={(option) => {
              if (option.value === "back") return back()
              if (option.value === "cancel") return input.onExit()
              move = option.value === "move"
              void save(writes, back)
            }}
          />
        ),
        back,
      )
      dialog.setSize("large")
    }

    // Move my facts: before the new settings are saved, while the old storage is the one in use.
    const moveFacts = async () => {
      show(
        () => (
          <DialogSelect
            title="Set up memory · Moving your facts…"
            options={[]}
            locked
            emptyView={<text>Exporting every fact from the current storage and importing it into the new one…</text>}
          />
        ),
        input.onExit,
      )
      const result = await sdk.client.memory.setup
        .move({ memorySetupInput: { memory: MemorySetup.block(draft), ...(template ? { template } : {}) } })
        .then((got) => got.data)
        .catch(() => undefined)
      if (!result?.ok) {
        toast.show({
          variant: "error",
          title: "Your facts weren't moved, and nothing was saved",
          message: result?.error ?? "The server didn't answer",
          duration: 15000,
        })
        return false
      }
      toast.show({
        variant: "success",
        message: `Moved ${result.facts ?? 0} fact(s), each with where it came from. The old copy is unchanged.`,
        duration: 8000,
      })
      return true
    }

    const save = async (writes: MemorySetup.Write[], back: () => void) => {
      if (move && !(await moveFacts())) return summary(back)
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

function hostOf(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}
