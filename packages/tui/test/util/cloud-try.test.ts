// XCOD-317: "Try Lunos Cloud" on the home screen: when it's offered, and how it runs quickstart on
// this terminal (the TUI steps aside, the command gets the terminal itself, the TUI comes back).
import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import os from "node:os"
import { DISMISSED, offered, runOnTerminal } from "../../src/util/cloud-try"

describe("Try Lunos Cloud", () => {
  test("offered once signed in, where the host can run it here, until it's run or hidden", () => {
    const yes = { signedIn: true, dismissed: false, local: true, command: true }
    expect(offered(yes)).toBe(true)
    expect(offered({ ...yes, signedIn: false })).toBe(false)
    expect(offered({ ...yes, dismissed: true })).toBe(false)
    // A sandbox or `lunos attach` elsewhere: the run would start from another machine's checkout.
    expect(offered({ ...yes, local: false })).toBe(false)
    // An organisation's sign-in, offline, or no Lunos Cloud for runs: the host gives no command.
    expect(offered({ ...yes, command: false })).toBe(false)
    expect(DISMISSED).toBe("cloud_try_dismissed")
  })

  test("runs the command on the terminal, waits for enter, and comes back", async () => {
    const calls: string[] = []
    const started: { file: string; args: string[]; options: Record<string, unknown> }[] = []
    const renderer = {
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
      requestRender: () => {},
      currentRenderBuffer: { clear() {} },
    }
    const code = await runOnTerminal({
      command: { argv: [process.execPath, "-e", "process.exit(0)"], env: { PATH: process.env.PATH }, verbatim: false },
      renderer,
      cwd: os.tmpdir(),
      pause: async () => void calls.push("pause"),
      spawn: ((file: string, args: string[], options: Record<string, unknown>) => {
        started.push({ file, args, options })
        calls.push("spawn")
        return spawn(file, args, options)
      }) as never,
    })
    expect(code).toBe(0)
    expect(calls).toEqual(["suspend", "spawn", "pause", "resume"])
    // The terminal itself: Lunos holds no handle on what's typed (a git token) or printed.
    expect(started[0]!.options.stdio).toBe("inherit")
  })

  test("a command that can't start resolves null, and the TUI comes back", async () => {
    const calls: string[] = []
    const renderer = {
      suspend: () => calls.push("suspend"),
      resume: () => calls.push("resume"),
      requestRender: () => {},
      currentRenderBuffer: { clear() {} },
    }
    const code = await runOnTerminal({
      command: { argv: ["/nonexistent/lunos"], env: {}, verbatim: false },
      renderer,
      cwd: os.tmpdir(),
      pause: async () => void calls.push("pause"),
    })
    expect(code).toBeNull()
    expect(calls).toEqual(["suspend", "pause", "resume"])
  })
})
