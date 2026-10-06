export * as RunBudget from "./run-budget"

/**
 * XCOD-211: an unattended run's step and spend limits, enforced where steps start. `lunos agent run`
 * watches the JSON stream, but it only sees a step once it has finished, and by the time its SIGINT
 * lands the run may have started more (seen under CI load: a step limit of 3 gave 4 steps, and a
 * whole extra step ran after spend passed its limit). So it also sets these on the `lunos run` it
 * starts (the sandbox passes them on). Every model step in that process, the subagents' included,
 * takes one from the step budget before it calls the model, and none starts once spend has passed
 * its limit. Spend is only known when a step finishes, so the step that crosses it still runs.
 */
export const STEPS = "LUNOS_MAX_STEPS"
export const COST = "LUNOS_MAX_COST"
export const KEYS = [STEPS, COST] as const
/**
 * When an unattended run's time is up, in epoch milliseconds. `lunos run --unattended` reads it on
 * the host and aborts the session then, so a step in progress stops too and the run ends normally.
 */
export const DEADLINE = "LUNOS_RUN_DEADLINE"

let steps = 0
let spent = 0

/** False once a budget is used up; always true when none is set. */
export function take(env: Record<string, string | undefined> = process.env) {
  const cost = Number(env[COST])
  if (cost > 0 && spent > cost) return false
  const limit = Number(env[STEPS])
  if (!(limit > 0)) return true
  if (steps >= limit) return false
  steps++
  return true
}

/** A finished step's cost. */
export function spend(cost: number) {
  if (cost > 0) spent += cost
}

/** For tests. */
export function reset() {
  steps = 0
  spent = 0
}
