// XCOD-298: /projects. A project is a repository (Lunos's own, no setup), or a named project grouping
// several repositories or directories, kept on this computer only. The list shows the project this
// folder counts in and the named ones; each opens its own view with tabs (Folders today; Resources
// and Budget slot in beside it through TABS).
import path from "path"
import { TextAttributes } from "@opentui/core"
import { For, Show, createResource, createSignal, onMount } from "solid-js"
import type { ProjectGroup } from "@opencode-ai/sdk/v2"
import { useDialog, type DialogNav } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSDK } from "../context/sdk"
import { useProject } from "../context/project"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { abbreviateHome } from "../runtime"
import { useTuiPaths } from "../context/runtime"

/** The per-project view's tabs. A later tab is one entry here and one `Match` in DialogProject. */
export const TABS = ["Folders"] as const
export type ProjectTab = (typeof TABS)[number]

const NEW = "+new"
const ARCHIVED = "+archived"

/** "3 folders", "1 folder", "no folders". */
export function folderCount(group: Pick<ProjectGroup, "folders">) {
  const count = group.folders.length
  return count === 0 ? "no folders" : `${count} ${count === 1 ? "folder" : "folders"}`
}

function useProjects() {
  const sdk = useSDK()
  const [data, { refetch }] = createResource(
    async () => (await sdk.client.experimental.projectGroup.list(undefined, { throwOnError: true })).data,
  )
  return { data, refetch }
}

export function DialogProjects(props: { select?: string; showArchived?: boolean; nav?: DialogNav }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const paths = useTuiPaths()
  const { data } = useProjects()
  const [showArchived] = createSignal(props.showArchived ?? false)
  const generation = dialog.generation
  onMount(() => dialog.setSize("large"))

  const reopen = (select?: string, archived = showArchived()) =>
    dialog.replace(
      () => <DialogProjects select={select} showArchived={archived} nav={props.nav} />,
      undefined,
      props.nav,
    )
  const back = (select?: string) => ({ back: () => reopen(select), generation })
  const short = (folder: string) => abbreviateHome(folder, paths.home)

  async function create() {
    const name = (
      await DialogPrompt.show(dialog, "New project", { placeholder: 'name, e.g. "Axsion web"', nav: back() })
    )?.trim()
    if (!name) return reopen()
    const here = data()?.current
    const created = await sdk.client.experimental.projectGroup
      .create({ name, folders: here?.implicit ? here.folders : [] }, { throwOnError: true })
      .catch((cause) => (toast.show({ variant: "error", message: errorMessage(cause) }), undefined))
    if (!created?.data) return reopen()
    openProject(created.data.id)
  }

  function openProject(id: string) {
    dialog.replace(() => <DialogProject id={id} onBack={() => reopen(id)} />, undefined, back(id))
  }

  const options = () => {
    const list = data()
    if (!list) return []
    const current = list.current
    const named = list.groups.filter((group) => showArchived() || !group.archived)
    return [
      {
        title: current.name,
        value: current.id,
        category: "This folder counts in",
        description: current.implicit ? "its repository · no setup" : folderCount(current),
        footer: current.implicit ? "repository" : "named",
      },
      ...named
        .filter((group) => group.id !== current.id)
        .map((group) => ({
          title: group.name,
          value: group.id,
          category: "Named projects",
          description: group.folders.map(short).join(", ") || "no folders yet",
          footer: group.archived ? "archived" : folderCount(group),
        })),
      { title: "New project…", value: NEW, category: "", description: "group several repositories or folders" },
      ...(list.groups.some((group) => group.archived)
        ? [{ title: showArchived() ? "Hide archived" : "Show archived", value: ARCHIVED, category: "" }]
        : []),
    ]
  }

  return (
    <DialogSelect<string>
      title="Projects"
      current={props.select ?? data()?.current.id}
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingTop={1}>
          <text fg={data.error ? theme.error : theme.textMuted}>
            {data.error ? errorMessage(data.error) : "Loading projects…"}
          </text>
        </box>
      }
      onSelect={(option) => {
        if (option.value === NEW) return void create()
        if (option.value === ARCHIVED) return reopen(ARCHIVED, !showArchived())
        const current = data()?.current
        if (current?.implicit && option.value === current.id)
          return dialog.replace(
            () => <DialogRepository group={current} onCreate={() => void create()} onBack={() => reopen(current.id)} />,
            undefined,
            back(current.id),
          )
        openProject(option.value)
      }}
    />
  )
}

/** The repository project this folder counts in: nothing to set up, but it can become a named one. */
function DialogRepository(props: { group: ProjectGroup; onCreate: () => void; onBack: () => void }) {
  const paths = useTuiPaths()
  return (
    <DialogSelect<string>
      title={props.group.name}
      options={[
        ...props.group.folders.map((folder) => ({
          title: abbreviateHome(folder, paths.home),
          value: folder,
          category: "Repository",
          disabled: true,
        })),
        {
          title: "Make it a named project…",
          value: NEW,
          category: "",
          description: "then add the other repositories or folders that belong with it",
        },
      ]}
      onSelect={(option) => {
        if (option.value === NEW) props.onCreate()
      }}
    />
  )
}

const ADD = "+add"
const RENAME = "+rename"
const ARCHIVE = "+archive"

/** One named project, on a tab. */
export function DialogProject(props: { id: string; tab?: ProjectTab; select?: string; onBack: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const paths = useTuiPaths()
  const project = useProject()
  const { data } = useProjects()
  const [tab, setTab] = createSignal<ProjectTab>(props.tab ?? TABS[0])
  const generation = dialog.generation
  onMount(() => dialog.setSize("large"))

  const group = () => data()?.groups.find((item) => item.id === props.id)
  const fail = (cause: unknown) => (toast.show({ variant: "error", message: errorMessage(cause) }), undefined)
  const reopen = (select?: string) =>
    dialog.replace(() => <DialogProject id={props.id} tab={tab()} select={select} onBack={props.onBack} />, undefined, {
      back: props.onBack,
      generation,
    })
  const here = { back: () => reopen(), generation }

  async function add() {
    const typed = (
      await DialogPrompt.show(dialog, "Add a folder", {
        placeholder: `~/…, /… or relative to ${abbreviateHome(project.instance.directory(), paths.home)}`,
        nav: here,
      })
    )?.trim()
    if (!typed) return reopen(ADD)
    const expanded = typed === "~" || typed.startsWith("~/") ? path.join(paths.home, typed.slice(1)) : typed
    const folder = path.resolve(project.instance.directory() || process.cwd(), expanded)
    await sdk.client.experimental.projectGroup
      .add({ groupID: props.id, folders: [folder] }, { throwOnError: true })
      .catch(fail)
    reopen(folder)
  }

  async function remove(folder: string) {
    const name = group()?.name ?? "this project"
    const sure = await DialogConfirm.show(
      dialog,
      "Remove folder",
      `Remove ${abbreviateHome(folder, paths.home)} from ${name}? Its sessions count in their repository's project again. Nothing on disk changes.`,
      "Remove",
      here,
    )
    if (sure)
      await sdk.client.experimental.projectGroup
        .remove({ groupID: props.id, folders: [folder] }, { throwOnError: true })
        .catch(fail)
    reopen(sure ? ADD : folder)
  }

  async function rename() {
    const current = group()
    const name = (await DialogPrompt.show(dialog, "Rename project", { value: current?.name, nav: here }))?.trim()
    if (name && name !== current?.name)
      await sdk.client.experimental.projectGroup.update({ groupID: props.id, name }, { throwOnError: true }).catch(fail)
    reopen(RENAME)
  }

  async function archive() {
    const current = group()
    if (!current) return
    if (!current.archived) {
      const sure = await DialogConfirm.show(
        dialog,
        "Archive project",
        `Archive ${current.name}? Its folders count in their repositories' projects again; its history is kept, and you can bring it back.`,
        "Archive",
        here,
      )
      if (!sure) return reopen(ARCHIVE)
    }
    await sdk.client.experimental.projectGroup
      .update({ groupID: props.id, archived: !current.archived }, { throwOnError: true })
      .catch(fail)
    reopen(ARCHIVE)
  }

  const options = () => {
    const current = group()
    if (!current) return []
    // Folders
    return [
      ...current.folders.map((folder) => ({
        title: abbreviateHome(folder, paths.home),
        value: folder,
        category: "Folders",
        footer: "enter to remove",
      })),
      { title: "Add a folder…", value: ADD, category: "Folders" },
      { title: "Rename…", value: RENAME, category: "Project", footer: current.name },
      {
        title: current.archived ? "Bring it back" : "Archive…",
        value: ARCHIVE,
        category: "Project",
        footer: current.archived ? "archived" : undefined,
      },
    ]
  }

  return (
    <DialogSelect<string>
      title={group()?.name ?? "Project"}
      titleView={
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {"Projects › " + (group()?.name ?? "…")}
            {group()?.archived ? " (archived)" : ""}
          </text>
          <Show when={TABS.length > 1}>
            <box flexDirection="row" gap={2}>
              <For each={TABS}>
                {(item) => (
                  <text
                    fg={item === tab() ? theme.primary : theme.textMuted}
                    attributes={item === tab() ? TextAttributes.BOLD | TextAttributes.UNDERLINE : undefined}
                    onMouseUp={() => setTab(item)}
                  >
                    {item === tab() ? `[${item}]` : item}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </box>
      }
      current={props.select}
      options={options()}
      emptyView={
        <box paddingLeft={4} paddingTop={1}>
          <text fg={data.error ? theme.error : theme.textMuted}>
            {data.error ? errorMessage(data.error) : data() ? "This project no longer exists" : "Loading…"}
          </text>
        </box>
      }
      onSelect={(option) => {
        if (option.value === ADD) return void add()
        if (option.value === RENAME) return void rename()
        if (option.value === ARCHIVE) return void archive()
        void remove(option.value)
      }}
    />
  )
}
