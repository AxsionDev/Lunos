import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { createStore, reconcile } from "solid-js/store"
import { budgetLine, type ProjectSection } from "./sessions-overview"

/**
 * XCOD-309: the budget line each project section shows in /sessions and the Agent Monitor ("€12.40 of
 * €50 (Oct)"), by project id, when the project has a budget. There is one status per project, asked
 * in one of its folders, so it is read when a Projects view is shown and then at most once a minute;
 * kept across re-opening the views.
 */
const [budgets, setBudgets] = createStore<Record<string, string>>({})
let read = 0

export const projectBudgets = budgets

export async function loadProjectBudgets(client: OpencodeClient, sections: ProjectSection[]) {
  if (Date.now() - read < 60_000) return
  read = Date.now()
  const lines = await Promise.all(
    sections
      .filter((section) => section.directory)
      .map(async (section) => {
        const status = await client.experimental.budget
          .status({ directory: section.directory })
          .then((result) => result.data)
          .catch(() => undefined)
        const budget = status?.budgets.find((item) => item.scope === "project")
        return [section.id, budget ? budgetLine(budget) : ""] as const
      }),
  )
  setBudgets(reconcile(Object.fromEntries(lines.filter(([, value]) => value))))
}
