export * as StepBudget from "./step-budget"

/**
 * XCOD-211: an unattended run's step limit, enforced where steps start. `lunos agent run` watches
 * the JSON stream, but it only sees a step once it has finished, and by the time its SIGINT lands
 * the run may have started several more (seen under CI load: limit 3, 5 steps). So it also sets
 * LUNOS_MAX_STEPS on the `lunos run` it starts (the sandbox passes it on), and every model step in
 * that process, the subagents' included, takes one from this budget before it calls the model.
 */
export const ENV = "LUNOS_MAX_STEPS"

let used = 0

/** False once the budget is spent; always true when no budget is set. */
export function take(env: Record<string, string | undefined> = process.env) {
  const limit = Number(env[ENV])
  if (!(limit > 0)) return true
  if (used >= limit) return false
  used++
  return true
}

/** For tests. */
export function reset() {
  used = 0
}
