import { EOL } from "os"
import { cmd } from "./cmd"
import { BrowserBridge } from "@/browser/bridge"
import { ConfigBrowser } from "@opencode-ai/core/config/browser"

// XCOD-327: `lunos browser pair` prints the code the Lunos extension needs to connect to this
// Lunos on 127.0.0.1. It's only ever shown here, to the user at their own terminal, never to a model.

const out = (line = "") => process.stdout.write(line + EOL)

const PairCommand = cmd({
  command: "pair",
  describe: "show the pairing code for the Lunos browser extension",
  handler: async () => {
    const token = await BrowserBridge.token()
    out("Pairing code for the Lunos extension (keep it private):")
    out()
    out(`  ${token}`)
    out()
    out("1. In Chrome, Edge or Brave open chrome://extensions, turn on Developer mode and choose Load unpacked:")
    out("   the browser-extension folder of the Lunos source (it isn't in any extension store yet).")
    out("2. Open the Lunos extension, paste the code and press Connect.")
    out(
      `3. Set browser.mode to "extension" and browser.enabled to true in /settings › Permissions › Browser & computer.`,
    )
    out(`The extension connects to 127.0.0.1:${ConfigBrowser.DEFAULT_PORT} only (browser.port changes it).`)
  },
})

export const BrowserCommand = cmd({
  command: "browser",
  describe: "browser control: pair the Lunos extension",
  builder: (yargs) => yargs.command(PairCommand).demandCommand(),
  handler: () => {},
})
