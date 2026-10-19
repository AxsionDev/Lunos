import { EOL } from "os"
import { cmd } from "../cmd"
import { writeStdout } from "../../stdout"

export const StartupCommand = cmd({
  command: "startup",
  describe: "print startup timing",
  builder: (yargs) => yargs,
  async handler() {
    await writeStdout(performance.now().toString() + EOL)
  },
})
