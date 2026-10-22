// XCOD-298: the budget meter. Before a turn the prompt shows "est. €0.08–0.30 · €12.40 left of €50
// (Oct)"; the sidebar shows each budget's spent, share used and forecast. Read from the server
// (GET /experimental/budget) again whenever the session's cost or messages change, so it moves
// while a turn runs. Nothing is shown for a project without a budget and a priced model.
import { For, Show, createMemo, createResource } from "solid-js"
import type { BudgetStatus } from "@opencode-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"
import { useTheme } from "../context/theme"

export function useBudget(sessionID: () => string | undefined) {
  const sdk = useSDK()
  const sync = useSync()
  const key = createMemo(() => {
    const id = sessionID()
    if (!id) return undefined
    const session = sync.session.get(id)
    const messages = sync.data.message[id]?.length ?? 0
    return { id, version: `${session?.cost ?? 0}:${messages}:${session?.time.updated ?? 0}` }
  })
  const [status] = createResource(key, async (input): Promise<BudgetStatus | undefined> => {
    const result = await sdk.client.experimental.budget.status({ sessionID: input.id }).catch(() => undefined)
    return result?.data
  })
  return status
}

const sign = (currency: string) => (currency === "EUR" ? "€" : "$")
const amount = (value: number, currency: string) => `${sign(currency)}${value.toFixed(2)}`

/** The sidebar's Budget block. */
export function BudgetMeter(props: { sessionID: string }) {
  const { theme } = useTheme()
  const status = useBudget(() => props.sessionID)
  return (
    <Show when={status()?.budgets.length}>
      <box>
        <text fg={theme.text}>
          <b>Budget</b> <span style={{ fg: theme.textMuted }}>{status()!.project.name}</span>
        </text>
        <For each={status()!.budgets}>
          {(item) => {
            const width = 20
            const filled = Math.min(width, Math.round((Math.min(item.percent, 100) / 100) * width))
            const color = item.percent >= 100 ? theme.error : item.percent >= 80 ? theme.warning : theme.success
            return (
              <box>
                <text fg={theme.textMuted}>
                  {item.scope === "organisation" ? "🔒 organisation · " : ""}
                  {item.period.label}
                </text>
                <text>
                  <span style={{ fg: color }}>{"█".repeat(filled)}</span>
                  <span style={{ fg: theme.textMuted }}>{"░".repeat(width - filled)}</span>{" "}
                  <span style={{ fg: theme.text }}>{Math.round(item.percent)}%</span>
                </text>
                <text fg={theme.textMuted}>
                  {amount(item.spent, item.currency)} of {amount(item.amount, item.currency)}
                  {item.forecast !== undefined ? ` · forecast ${amount(item.forecast, item.currency)}` : ""}
                </text>
                <Show when={item.unknown}>
                  <text fg={theme.warning}>+ {item.unknown} turns of unknown cost</text>
                </Show>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}
