import { createResource, createMemo } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"
import { openEditor } from "../editor"

// XCOD-210: /agents. Every agent, built-ins included; enter opens an agent's file in $VISUAL /
// $EDITOR, and the server checks the result against the models, tools, skills and MCP servers
// available here before writing it, the same check as `lunos agent edit`.

export function DialogAgents(props: { focus?: string }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()
  const renderer = useRenderer()

  const [agents] = createResource(async () => (await sdk.client.config.agents()).data ?? [])

  const options = createMemo(() =>
    (agents() ?? []).map((agent) => ({
      value: agent.name,
      title: agent.name,
      description: agent.description,
      footer: [
        agent.mode,
        agent.hidden ? "hidden" : "",
        agent.file ? "" : agent.native ? "built in" : "not editable here",
      ]
        .filter(Boolean)
        .join(" · "),
    })),
  )

  async function edit(name: string) {
    const agent = agents()?.find((item) => item.name === name)
    if (!agent) return
    if (agent.file === undefined || agent.text === undefined) {
      toast.show({
        variant: "info",
        message: agent.native
          ? `${name} is built in. \`lunos agent create\` makes an agent of your own to edit.`
          : `${name} is defined in a JSON config file; edit it there.`,
      })
      return
    }
    const text = await openEditor({ value: agent.text, renderer }).catch((error: unknown) => {
      toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
      return undefined
    })
    if (text === undefined) {
      if (!process.env.VISUAL && !process.env.EDITOR)
        toast.show({ variant: "info", message: `Set $EDITOR to edit agents here, or use \`lunos agent edit ${name}\`` })
      return
    }
    if (text === agent.text) return
    const result = (await sdk.client.config.agentSave({ agentSaveInput: { name, text } }).catch(() => undefined))?.data
    if (!result) {
      toast.show({ variant: "error", message: `${name} not saved: the server didn't answer` })
      return
    }
    if (!result.ok) {
      toast.show({
        variant: "error",
        title: `${name} not saved`,
        message: result.problems.join("\n"),
        duration: 10000,
      })
      return
    }
    toast.show({ variant: "success", message: `${name} saved (${result.file}); new sessions use it` })
    dialog.replace(() => <DialogAgents focus={name} />)
  }

  return (
    <DialogSelect
      title="Agents"
      placeholder="Type to filter agents"
      current={props.focus}
      options={options()}
      footerHints={[{ title: "edit in $EDITOR", label: "enter" }]}
      onSelect={(option) => void edit(option.value)}
    />
  )
}
