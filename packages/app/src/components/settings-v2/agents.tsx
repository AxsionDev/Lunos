import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { TextareaV2 } from "@opencode-ai/ui/v2/textarea-v2"
import type { AgentFileEntry } from "@opencode-ai/sdk/v2"
import { type Accessor, type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// XCOD-215: Settings → Agents, the desktop/web side of the TUI's /settings → Agents. Every change is
// one `agent.<name>.<field>` key through PATCH /config/settings, so organisation locks and the model
// check are the server's, the same as the TUI and `lunos settings set`.

type Scope = "user" | "project"
type Kind = "main" | "subagent" | "helper"

const KINDS: Kind[] = ["main", "subagent", "helper"]
const MODES = ["primary", "subagent", "all"]
const COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"]
const INHERIT = "inherit"

const kindOf = (agent: AgentFileEntry): Kind => agent.kind ?? (agent.mode === "subagent" ? "subagent" : "main")

export const SettingsAgentsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const models = useModels()
  const client = createMemo(() => serverSdk().createClient({ directory: props.directory() }))
  const [scope, setScope] = createSignal<Scope>("user")
  const [selected, setSelected] = createSignal<string>()
  const [agents, { refetch }] = createResource(
    () => props.directory() ?? "",
    async () => (await client().config.agents()).data ?? [],
  )
  const [snapshot, settings] = createResource(
    () => props.directory() ?? "",
    async () => (await client().config.settings()).data,
  )
  const locked = () => snapshot()?.locked ?? []
  const isLocked = (key: string) => locked().some((entry) => key === entry || key.startsWith(`${entry}.`))
  const agent = createMemo(() => agents()?.find((item) => item.name === selected()))
  const own = (field: string) => agent()?.overrides?.[scope()]?.[field]
  const deprecated = createMemo(
    () =>
      snapshot()?.rows.some((row) => row.key === "mode" && row.source !== "default") ||
      (agents() ?? []).some((item) =>
        (["user", "project"] as const).some((where) =>
          ["tools", "maxSteps"].some((key) => item.overrides?.[where]?.[key] !== undefined),
        ),
      ),
  )

  async function save(key: string, value: string | undefined) {
    const result = await client()
      .config.settingsSet({
        settingsSetInput: { key, value: value ?? "", scope: scope(), ...(value === undefined ? { unset: true } : {}) },
      })
      .catch(() => undefined)
    const data = result?.data
    if (!data || !data.ok) {
      showToast({ variant: "error", title: key, description: data && !data.ok ? data.error : String(result?.error) })
      return false
    }
    showToast({ variant: "success", description: language.t("settings.agents.saved", { key, file: data.file }) })
    await Promise.all([refetch(), settings.refetch()])
    return true
  }

  const field = (name: string) => (value: string | undefined) => save(`agent.${selected()}.${name}`, value)
  // A refused value (out of range, locked, not a model) must not stay in the field looking saved.

  async function create(name: string, description: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) return
    if (await save(`agent.${name}.description`, description || name)) setSelected(name)
  }

  async function migrate() {
    for (const where of ["user", "project"] as const) {
      const result = (
        await client()
          .config.agentsMigrate({ agentsMigrateInput: { scope: where } })
          .catch(() => undefined)
      )?.data
      if (!result || !result.ok) {
        showToast({ variant: "error", description: result && !result.ok ? result.error : "" })
        return
      }
      if (result.migrated.length) showToast({ variant: "success", description: result.migrated.join(", ") })
    }
    await Promise.all([refetch(), settings.refetch()])
  }

  const modelOptions = createMemo(() => [
    INHERIT,
    ...(kindOf(agent() ?? ({ mode: "primary" } as AgentFileEntry)) === "subagent" ? ["small"] : []),
    ...models.list().map((item) => `${item.provider.id}/${item.id}`),
  ])

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-tab-header--stacked">
        <h2 class="settings-v2-tab-title">{language.t("settings.agents.title")}</h2>
        <p class="text-v2-text-text-muted">{language.t("settings.agents.help")}</p>
      </div>
      <div class="settings-v2-tab-body">
        <SettingsListV2>
          <SettingsRowV2 title={language.t("settings.agents.scope")} description="">
            <SelectV2
              appearance="inline"
              data-action="settings-agents-scope"
              options={["user", "project"] as Scope[]}
              current={scope()}
              placement="bottom-end"
              gutter={6}
              label={(option) => language.t(`settings.agents.scope.${option}`)}
              onSelect={(option) => option && setScope(option)}
            />
          </SettingsRowV2>
        </SettingsListV2>

        <Show
          when={agent()}
          fallback={
            <AgentList
              agents={agents() ?? []}
              deprecated={deprecated()}
              onOpen={setSelected}
              onCreate={create}
              onMigrate={migrate}
            />
          }
        >
          {(item) => (
            <div class="settings-v2-section" data-component="settings-agent-detail">
              <div class="flex items-center justify-between gap-2">
                <h3 class="settings-v2-section-title">{item().name}</h3>
                <ButtonV2 variant="ghost" size="small" onClick={() => setSelected(undefined)}>
                  {language.t("settings.agents.back")}
                </ButtonV2>
              </div>
              <SettingsListV2>
                <SettingsRowV2 title={language.t("settings.agents.field.model")} description={item().model ?? INHERIT}>
                  <SelectV2
                    appearance="inline"
                    data-action="settings-agent-model"
                    disabled={isLocked(`agent.${item().name}.model`)}
                    options={modelOptions()}
                    current={(own("model") as string | undefined) ?? INHERIT}
                    placement="bottom-end"
                    gutter={6}
                    label={(option) => (option === INHERIT ? language.t("settings.agents.inherit") : option)}
                    onSelect={(option) => option && void field("model")(option === INHERIT ? undefined : option)}
                  />
                </SettingsRowV2>
                <SettingsRowV2 title={language.t("settings.agents.field.enabled")} description="">
                  <Switch
                    checked={!item().disabled}
                    disabled={isLocked(`agent.${item().name}.disable`)}
                    onChange={(on) => void field("disable")(on ? undefined : "true")}
                    hideLabel
                  >
                    {language.t("settings.agents.field.enabled")}
                  </Switch>
                </SettingsRowV2>
                <Show when={kindOf(item()) !== "helper"}>
                  <SettingsRowV2 title={language.t("settings.agents.field.type")} description="">
                    <SelectV2
                      appearance="inline"
                      data-action="settings-agent-mode"
                      disabled={isLocked(`agent.${item().name}.mode`)}
                      options={MODES}
                      current={item().mode}
                      placement="bottom-end"
                      gutter={6}
                      onSelect={(option) => option && void field("mode")(option)}
                    />
                  </SettingsRowV2>
                  <SettingsRowV2 title={language.t("settings.agents.field.hidden")} description="">
                    <Switch
                      checked={item().hidden === true}
                      disabled={isLocked(`agent.${item().name}.hidden`)}
                      onChange={(on) => void field("hidden")(on ? "true" : undefined)}
                      hideLabel
                    >
                      {language.t("settings.agents.field.hidden")}
                    </Switch>
                  </SettingsRowV2>
                  <NumberRow
                    title={language.t("settings.agents.field.steps")}
                    value={own("steps") as number | undefined}
                    disabled={isLocked(`agent.${item().name}.steps`)}
                    onSave={field("steps")}
                  />
                  <NumberRow
                    title={language.t("settings.agents.field.temperature")}
                    value={own("temperature") as number | undefined}
                    disabled={isLocked(`agent.${item().name}.temperature`)}
                    onSave={field("temperature")}
                  />
                  <NumberRow
                    title={language.t("settings.agents.field.topP")}
                    value={own("top_p") as number | undefined}
                    disabled={isLocked(`agent.${item().name}.top_p`)}
                    onSave={field("top_p")}
                  />
                  <SettingsRowV2 title={language.t("settings.agents.field.color")} description="">
                    <SelectV2
                      appearance="inline"
                      data-action="settings-agent-color"
                      disabled={isLocked(`agent.${item().name}.color`)}
                      options={["default", ...COLORS]}
                      current={(own("color") as string | undefined) ?? "default"}
                      placement="bottom-end"
                      gutter={6}
                      label={(option) => (option === "default" ? language.t("common.default") : option)}
                      onSelect={(option) => option && void field("color")(option === "default" ? undefined : option)}
                    />
                  </SettingsRowV2>
                  <TextRow
                    title={language.t("settings.agents.field.description")}
                    value={(own("description") as string | undefined) ?? item().description ?? ""}
                    disabled={isLocked(`agent.${item().name}.description`)}
                    onSave={field("description")}
                  />
                  <TextRow
                    title={language.t("settings.agents.field.prompt")}
                    value={(own("prompt") as string | undefined) ?? ""}
                    multiline
                    disabled={isLocked(`agent.${item().name}.prompt`)}
                    onSave={field("prompt")}
                  />
                </Show>
              </SettingsListV2>
              <p class="text-v2-text-text-muted">
                {language.t("settings.agents.inFile", { file: snapshot()?.files?.[scope()]?.config ?? "" })}
              </p>
              <ButtonV2
                variant="outline"
                size="small"
                data-action="settings-agent-reset"
                disabled={isLocked(`agent.${item().name}`)}
                onClick={() => void save(`agent.${item().name}`, undefined)}
              >
                {language.t("common.reset")}
              </ButtonV2>
            </div>
          )}
        </Show>
      </div>
    </>
  )
}

const AgentList: Component<{
  agents: AgentFileEntry[]
  deprecated: boolean
  onOpen: (name: string) => void
  onCreate: (name: string, description: string) => void
  onMigrate: () => void
}> = (props) => {
  const language = useLanguage()
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  return (
    <>
      <Show when={props.deprecated}>
        <ButtonV2 variant="warning" size="small" data-action="settings-agents-migrate" onClick={props.onMigrate}>
          {language.t("settings.agents.migrate")}
        </ButtonV2>
      </Show>
      <For each={KINDS}>
        {(kind) => (
          <Show when={props.agents.some((agent) => kindOf(agent) === kind)}>
            <div class="settings-v2-section">
              <h3 class="settings-v2-section-title">{language.t(`settings.agents.kind.${kind}`)}</h3>
              <SettingsListV2>
                <For each={props.agents.filter((agent) => kindOf(agent) === kind)}>
                  {(agent) => (
                    <SettingsRowV2 title={agent.name} description={agent.description ?? ""}>
                      <ButtonV2
                        variant="ghost"
                        size="small"
                        data-agent={agent.name}
                        onClick={() => props.onOpen(agent.name)}
                      >
                        {`${agent.model ?? language.t("settings.agents.inherit")} · ${agent.disabled ? "off" : "on"}`}
                      </ButtonV2>
                    </SettingsRowV2>
                  )}
                </For>
              </SettingsListV2>
            </div>
          </Show>
        )}
      </For>
      <div class="settings-v2-section">
        <h3 class="settings-v2-section-title">{language.t("settings.agents.new")}</h3>
        <div class="flex items-center gap-2">
          <TextInputV2
            appearance="base"
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
            placeholder="name"
          />
          <TextInputV2
            appearance="base"
            value={description()}
            onInput={(event) => setDescription(event.currentTarget.value)}
            placeholder={language.t("settings.agents.field.description")}
          />
          <ButtonV2
            variant="outline"
            size="small"
            data-action="settings-agents-create"
            disabled={!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name())}
            onClick={() => props.onCreate(name(), description())}
          >
            {language.t("common.save")}
          </ButtonV2>
        </div>
      </div>
    </>
  )
}

const NumberRow: Component<{
  title: string
  value: number | undefined
  disabled: boolean
  onSave: (value: string | undefined) => Promise<boolean>
}> = (props) => {
  const language = useLanguage()
  return (
    <SettingsRowV2 title={props.title} description="">
      <TextInputV2
        appearance="base"
        inputMode="decimal"
        disabled={props.disabled}
        value={props.value === undefined ? "" : String(props.value)}
        placeholder={language.t("common.default")}
        onChange={(event) => {
          const input = event.currentTarget
          const saved = props.value === undefined ? "" : String(props.value)
          const text = input.value.trim()
          if (text === saved) return
          void props.onSave(text === "" ? undefined : text).then((ok) => {
            if (!ok) input.value = saved
          })
        }}
      />
    </SettingsRowV2>
  )
}

const TextRow: Component<{
  title: string
  value: string
  multiline?: boolean
  disabled: boolean
  onSave: (value: string | undefined) => Promise<boolean>
}> = (props) => {
  const language = useLanguage()
  const save = (input: HTMLInputElement | HTMLTextAreaElement) => {
    const text = input.value
    if (text === props.value) return
    void props.onSave(text.trim() === "" ? undefined : text).then((ok) => {
      if (!ok) input.value = props.value
    })
  }
  return (
    <SettingsRowV2 title={props.title} description="">
      <Show
        when={props.multiline}
        fallback={
          <TextInputV2
            appearance="base"
            disabled={props.disabled}
            value={props.value}
            placeholder={language.t("common.default")}
            onChange={(event) => save(event.currentTarget)}
          />
        }
      >
        <TextareaV2
          rows={4}
          disabled={props.disabled}
          value={props.value}
          placeholder={language.t("common.default")}
          onChange={(event) => save(event.currentTarget)}
        />
      </Show>
    </SettingsRowV2>
  )
}
