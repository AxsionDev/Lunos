// XCOD-298: the budget meter. Before a turn the prompt shows "est. €0.08–0.30 · €12.40 left of €50
// (Oct)"; the sidebar's Project section (XCOD-306) shows each budget's spent, share used and
// forecast. Read from the server (GET /experimental/budget) again whenever the session's cost or
// messages change, so it moves while a turn runs.
import { createMemo, createResource } from "solid-js"
import type { BudgetStatus } from "@opencode-ai/sdk/v2"
import { useSDK } from "../context/sdk"
import { useSync } from "../context/sync"

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
