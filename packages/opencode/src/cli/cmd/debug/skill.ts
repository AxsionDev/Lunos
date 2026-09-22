import { EOL } from "os"
import { Effect } from "effect"
import { Skill } from "../../../skill"
import { effectCmd } from "../../effect-cmd"

export const SkillCommand = effectCmd({
  command: "skill",
  describe: "list all available skills",
  builder: (yargs) => yargs,
  handler: Effect.fn("Cli.debug.skill")(function* () {
    const skill = yield* Skill.Service
    const skills = yield* skill.all()
    // `process.stdout.write` does not block on a pipe, so the process can exit with
    // the buffer undrained — output then stops dead at the pipe's capacity (measured
    // at 131072 bytes) and the JSON is truncated mid-string, so `lunos debug skill
    // | jq` silently sees a fraction of the skills. Awaiting the write makes piping safe.
    yield* Effect.promise(() => Bun.write(Bun.stdout, JSON.stringify(skills, null, 2) + EOL))
  }),
})
