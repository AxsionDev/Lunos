export * as BudgetNotify from "./notify"

// XCOD-298: e-mail at a budget threshold. The ticket asks for it through the mail outbox (XCOD-275),
// but that outbox lives in the Lunos console (the lunoshq repository), and the console has no API a
// client can send a notification through. So this is the seam: thresholds call `notify`, which goes
// nowhere until a sender is registered (`use`). Off by default either way; webhooks are a follow-up.

export interface Alert {
  /** "project:<id>" or "organisation". */
  budget: string
  project: string
  threshold: number
  period: string
  spent: number
  amount: number
  currency: string
}

export interface Sender {
  send(alert: Alert): Promise<void>
}

let sender: Sender | undefined

/** Registers where threshold alerts go (none by default). */
export function use(next: Sender | undefined) {
  sender = next
}

/** Never throws, never waits. */
export function notify(alert: Alert) {
  if (!sender) return
  void sender.send(alert).catch(() => undefined)
}
