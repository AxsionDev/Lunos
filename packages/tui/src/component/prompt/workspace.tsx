import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useDialog } from "../../ui/dialog"
import { useSDK } from "../../context/sdk"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import {
  confirmWorkspaceFileChanges,
  openWorkspaceSelect,
  warpWorkspaceSession,
  type WorkspaceSelection,
} from "../dialog-workspace-create"
import type { WorkspaceStatus } from "../workspace-label"

export function usePromptWorkspace(sessionID?: string) {
  const dialog = useDialog()
  const sdk = useSDK()
  const project = useProject()
  const sync = useSync()
  const toast = useToast()
  const [selection, setSelection] = createSignal<WorkspaceSelection>()
  const [creating, setCreating] = createSignal(false)
  const [creatingDots, setCreatingDots] = createSignal(3)
  const [notice, setNotice] = createSignal<string>()

  async function create(selection: Extract<WorkspaceSelection, { type: "new" }>) {
    setCreating(true)
    let result
    try {
      result = await sdk.client.experimental.workspace.create({ type: selection.workspaceType, branch: null })
    } catch (err) {
      setSelection(undefined)
      setCreating(false)
      toast.show({ title: "Creating workspace failed", message: errorMessage(err), variant: "error" })
      return
    }
    if (result.error || !result.data) {
      setSelection(undefined)
      setCreating(false)
      toast.show({
        title: "Creating workspace failed",
        message: errorMessage(result.error ?? "no response"),
        variant: "error",
      })
      return
    }

    await project.workspace.sync()
    const workspace = result.data
    setSelection({
      type: "existing",
      workspaceID: workspace.id,
      workspaceType: workspace.type,
      workspaceName: workspace.name,
    })
    setCreating(false)
    return workspace
  }

  async function warp(selection: WorkspaceSelection) {
    if (!sessionID) {
      setSelection(selection)
      dialog.clear()
      if (selection.type === "new") void create(selection)
      return
    }
    const sourceWorkspaceID = project.workspace.current()
    const copyChanges = await confirmWorkspaceFileChanges({ dialog, sdk, sourceWorkspaceID })
    if (copyChanges === undefined) return
    setSelection(selection)
    dialog.clear()

    const workspace =
      selection.type === "none"
        ? { id: null, name: "local project" }
        : selection.type === "existing"
          ? { id: selection.workspaceID, name: selection.workspaceName }
          : await create(selection)
    if (!workspace) return

    const warped = await warpWorkspaceSession({
      dialog,
      sdk,
      sync,
      project,
      toast,
      sourceWorkspaceID,
      workspaceID: workspace.id,
      sessionID,
      copyChanges,
    })
    if (warped) showNotice(workspace.name)
  }

  function showNotice(name: string) {
    setNotice(`Warped to ${name}`)
    setTimeout(() => setNotice(undefined), 4000)
  }

  function clearNotice() {
    setNotice(undefined)
  }

  function open() {
    void openWorkspaceSelect({ dialog, sdk, sync, project, toast, onSelect: warp })
  }

  // XCOD-158: `/sandbox` moves the session into a new sandbox (a docker workspace), by warp. File
  // changes are never copied across: the sandbox starts from the project with your uncommitted
  // changes, and its own changes come back only when it ends, as sandbox.results says.
  const sandboxed = () => {
    const current = project.workspace.current()
    return current ? project.workspace.get(current)?.type === "docker" : false
  }

  async function sandbox() {
    if (sandboxed()) {
      toast.show({ variant: "warning", message: "This session is already in a sandbox. `/sandbox end` ends it." })
      return
    }
    const selection = { type: "new" as const, workspaceType: "docker", workspaceName: "Docker sandbox" }
    setSelection(selection)
    if (!sessionID) {
      void create(selection)
      return
    }
    const sourceWorkspaceID = project.workspace.current()
    const workspace = await create(selection)
    if (!workspace) return
    const warped = await warpWorkspaceSession({
      dialog,
      sdk,
      sync,
      project,
      toast,
      sourceWorkspaceID,
      workspaceID: workspace.id,
      sessionID,
      copyChanges: false,
    })
    if (warped) showNotice(`sandbox ${workspace.name}`)
  }

  // `/sandbox end`: the session comes back to this machine first (removing a workspace deletes the
  // sessions still in it), then the sandbox hands its results back and sandbox.on_finish applies.
  async function endSandbox() {
    const current = project.workspace.current()
    const space = current ? project.workspace.get(current) : undefined
    if (!sessionID || !current || space?.type !== "docker") {
      toast.show({ variant: "warning", message: "This session isn't in a sandbox." })
      return
    }
    const id = space.name
    const settings = await sdk.client.config.settings().catch(() => undefined)
    const results = settings?.data?.sandbox?.known.find((item) => item.id === id)?.results ?? "branch"
    const back = await warpWorkspaceSession({
      dialog,
      sdk,
      sync,
      project,
      toast,
      sourceWorkspaceID: current,
      workspaceID: null,
      sessionID,
      copyChanges: false,
    })
    if (!back) return
    setSelection(undefined)
    toast.show({ variant: "info", message: `Ending sandbox ${id}: handing its results back…` })
    const removed = await sdk.client.experimental.workspace.remove({ id: current }).catch((error: unknown) => ({
      error,
      data: undefined,
    }))
    await project.workspace.sync()
    if (removed.error) {
      toast.show({
        variant: "error",
        message: `Sandbox ${id} couldn't be ended: ${errorMessage(removed.error)}. \`lunos sandbox list\` shows it.`,
      })
      return
    }
    const where =
      results === "patch"
        ? `the agent's changes are in .opencode/sandbox/${id}/changes.patch (git apply)`
        : results === "none"
          ? 'its changes weren\'t handed back (sandbox.results is "none")'
          : `the agent's changes are on branch ${space.branch ?? `lunos/sandbox/${id}`}`
    toast.show({
      variant: "success",
      message: `Sandbox ${id} ended: ${where}. Transcript and summary in .opencode/sandbox/${id}/.`,
    })
  }

  createEffect(() => {
    if (!creating()) {
      setCreatingDots(3)
      return
    }
    const timer = setInterval(() => setCreatingDots((dots) => (dots % 3) + 1), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const label = createMemo<
    | { type: "new"; workspaceType: string }
    | { type: "existing"; workspaceType: string; workspaceName: string; status?: WorkspaceStatus }
    | undefined
  >(() => {
    const selected = selection()
    if (!selected) return
    if (selected.type === "none") return
    if (sessionID && !creating()) return
    if (selected.type === "new") return { type: "new", workspaceType: selected.workspaceType }
    return {
      type: "existing",
      workspaceType: selected.workspaceType,
      workspaceName: selected.workspaceName,
      status: selected.type === "existing" ? "connected" : undefined,
    }
  })

  return { selection, creating, creatingDots, notice, label, open, warp, clearNotice, sandbox, endSandbox, sandboxed }
}
