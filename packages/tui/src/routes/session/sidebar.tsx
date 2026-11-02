import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import type { InputRenderable } from "@opentui/core"
import { PaneHide } from "../../component/right-pane"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { usePromptRef } from "../../context/prompt"
import { useBindings } from "../../keymap"
import { errorMessage } from "../../util/error"
import { RENAME_MAX, renameValue } from "../../util/session"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../config"
import { InstallationChannel, versionLabel } from "@opencode-ai/core/installation/version"
import { usePluginRuntime } from "../../plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import { bridgeLine, EXTERNAL_BADGE, externalAccent, externalOf } from "../../util/external"
import { ProjectSection } from "../../component/project-section"
import { useProjectDetail } from "../../component/project-detail"

// XCOD-308: the session whose title the sidebar is editing in place, if any (ctrl+r starts it too).
const [renaming, setRenaming] = createSignal<string>()
export const startRename = (sessionID: string) => setRenaming(sessionID)

function SidebarRename(props: { sessionID: string; title: string }) {
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const [target, setTarget] = createSignal<InputRenderable>()
  let input: InputRenderable | undefined
  const promptRef = usePromptRef()
  let done = false
  const stop = () => {
    done = true
    setRenaming(undefined)
    // Typing goes back to the prompt.
    promptRef.current?.focus()
  }
  const save = () => {
    if (done) return
    const title = renameValue(input?.plainText, props.title)
    stop()
    if (title === undefined) return
    void sdk.client.session
      .update({ sessionID: props.sessionID, title }, { throwOnError: true })
      .catch((cause) => toast.show({ variant: "error", message: errorMessage(cause) }))
  }
  // Enter and Esc are the field's while it is focused: Esc doesn't interrupt the turn, Enter doesn't send.
  useBindings(() => ({
    target,
    enabled: target() !== undefined,
    priority: 10,
    bindings: [
      { key: "return", cmd: save },
      { key: "escape", cmd: stop },
    ],
  }))
  return (
    <box flexDirection="column">
      <input
        ref={(value: InputRenderable) => {
          input = value
          setTarget(value)
          setTimeout(() => {
            if (!value.isDestroyed) value.focus()
          }, 1)
        }}
        value={props.title}
        maxLength={RENAME_MAX}
        onSubmit={save}
        focusedBackgroundColor={theme.backgroundElement}
        cursorColor={theme.primary}
        cursorStyle={tuiConfig.cursor}
        focusedTextColor={theme.text}
        placeholder="Automatic name"
        placeholderColor={theme.textMuted}
      />
      <text fg={theme.textMuted} wrapMode="word">
        enter save · esc cancel · empty for the automatic name
      </text>
    </box>
  )
}

export function Sidebar(props: { sessionID: string; overlay?: boolean; onHide?: () => void }) {
  const pluginRuntime = usePluginRuntime()
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const sdk = useSDK()
  // XCOD-158: what the session's sandbox runs, from its own server (the marker it was created with):
  // the image and its pinned digest, and the devcontainer it came from. Asked once per workspace;
  // nothing is shown outside a sandbox.
  const [sandbox] = createResource(
    () => ({ workspace: session()?.workspaceID ?? "" }),
    async (key) => {
      const result = await sdk.client.config
        .settings(key.workspace ? { workspace: key.workspace } : {})
        .catch(() => undefined)
      return result?.data?.sandbox?.inside
    },
  )
  const openProjectDetail = useProjectDetail()
  const short = (digest: string) => digest.replace(/^.*@/, "").replace(/^(sha256:[0-9a-f]{12})[0-9a-f]+$/, "$1")

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <Show when={props.onHide}>
              <PaneHide onHide={props.onHide!} />
            </Show>
            <pluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                {/* XCOD-308: click the title (or ctrl+r) to rename the session in place. */}
                <Show
                  when={renaming() === props.sessionID}
                  fallback={
                    <text fg={theme.text} onMouseUp={() => startRename(props.sessionID)}>
                      <b>{session()!.title}</b>
                    </text>
                  }
                >
                  <SidebarRename sessionID={props.sessionID} title={session()!.title} />
                </Show>
                <Show when={externalOf(session())}>
                  {(marker) => (
                    <text>
                      <span
                        style={{
                          fg: externalAccent(theme, marker().tool, tuiConfig.external_accent !== false) ?? theme.text,
                        }}
                      >
                        ●{" "}
                      </span>
                      <span style={{ fg: theme.textMuted }}>
                        {EXTERNAL_BADGE[marker().tool]} session{marker().model ? ` · ${marker().model}` : ""}
                      </span>
                    </text>
                  )}
                </Show>
                <Show when={bridgeLine(externalOf(session())?.bridge)}>
                  {(line) => <text fg={line().warning ? theme.warning : theme.textMuted}>{line().text}</text>}
                </Show>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={sandbox()}>
                  {(inside) => (
                    <text fg={theme.textMuted}>
                      sandbox {inside().id}
                      {inside().devcontainer ? ` · devcontainer ${short(inside().devcontainer!)}` : ""}
                      {inside().digest ? ` · ${short(inside().digest!)}` : ""}
                    </text>
                  )}
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </pluginRuntime.Slot>
            {/* XCOD-306: the session's project, with its budget (live) and everything defined for it. */}
            <ProjectSection sessionID={props.sessionID} onOpen={openProjectDetail} />
            <pluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <pluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span>{" "}
              <span style={{ fg: theme.text }}>
                <b>Lunos</b>
              </span>{" "}
              <span>{versionLabel().replace(/^Lunos /, "")}</span>
            </text>
          </pluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
