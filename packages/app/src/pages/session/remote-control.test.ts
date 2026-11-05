// XCOD-338: `/remote` in the desktop app: what it parses, when it asks, what it calls and says.
import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { parseRemote, remoteControl, type RemoteControlInput } from "./remote-control"

function harness(over: { on?: boolean; refuse?: string; confirm?: boolean; copy?: boolean } = {}) {
  const calls: Array<{ on: boolean }> = []
  const asked: string[] = []
  const toasts: Array<{ title: string; description?: string; variant: string }> = []
  let on = !!over.on
  const input = (want: RemoteControlInput["want"]): RemoteControlInput => ({
    sessionID: "ses_1",
    want,
    client: {
      remote: async () => ({ data: on ? { on, url: "https://app.lunos.tech/remote/rl_1" } : { on } }),
      remoteSet: async ({ on: next }) => {
        calls.push({ on: next })
        if (over.refuse) return { error: { data: { message: over.refuse } } }
        on = next
        return { data: next ? { on, url: "https://app.lunos.tech/remote/rl_1" } : { on } }
      },
    },
    confirm: async (c) => (asked.push(c.title), over.confirm ?? true),
    copy: async () => over.copy ?? true,
    toast: (t) => toasts.push(t),
    t: (key, params) => en[key].replace("{{url}}", params?.url ?? ""),
  })
  return { input, calls, asked, toasts, on: () => on }
}

describe("desktop /remote (XCOD-338)", () => {
  test("parses /remote, /remote on, /remote off; anything else is a prompt", () => {
    expect(parseRemote("/remote")).toBe("toggle")
    expect(parseRemote("  /remote ON ")).toBe("on")
    expect(parseRemote("/remote off")).toBe("off")
    expect(parseRemote("/remote please")).toBeUndefined()
    expect(parseRemote("/remotely")).toBeUndefined()
    expect(parseRemote("turn /remote on")).toBeUndefined()
  })

  test("on asks first, with what it allows, then turns it on and copies the link", async () => {
    const h = harness()
    expect(await remoteControl(h.input("on"))).toBe(true)
    expect(h.asked).toEqual([en["session.remote.on.title"]])
    expect(h.calls).toEqual([{ on: true }])
    expect(h.toasts.at(-1)).toMatchObject({
      variant: "success",
      description: "Link copied: https://app.lunos.tech/remote/rl_1",
    })
  })

  test("cancelling the confirmation turns nothing on", async () => {
    const h = harness({ confirm: false })
    expect(await remoteControl(h.input("toggle"))).toBe(false)
    expect(h.calls).toEqual([])
  })

  test("a refusal shows the reason the process gave (signed out, policy, ...)", async () => {
    const h = harness({ refuse: "Sign in to Lunos first (lunos login)" })
    expect(await remoteControl(h.input("on"))).toBe(false)
    expect(h.toasts.at(-1)).toMatchObject({
      variant: "error",
      title: en["toast.session.remote.onFailed.title"],
      description: "Sign in to Lunos first (lunos login)",
    })
  })

  test("typed /remote off ends it without asking; the toggle asks first", async () => {
    const typed = harness({ on: true })
    expect(await remoteControl(typed.input("off"))).toBe(false)
    expect(typed.asked).toEqual([])
    expect(typed.calls).toEqual([{ on: false }])

    const toggle = harness({ on: true, confirm: false })
    expect(await remoteControl(toggle.input("toggle"))).toBe(true)
    expect(toggle.asked).toEqual([en["session.remote.off.title"]])
    expect(toggle.calls).toEqual([])
  })

  test("already on / already off: says so, changes nothing", async () => {
    const on = harness({ on: true })
    await remoteControl(on.input("on"))
    expect(on.calls).toEqual([])
    expect(on.toasts[0]?.title).toContain("https://app.lunos.tech/remote/rl_1")
    const off = harness()
    await remoteControl(off.input("off"))
    expect(off.calls).toEqual([])
  })

  test("no clipboard: the link is still shown", async () => {
    const h = harness({ copy: false })
    await remoteControl(h.input("on"))
    expect(h.toasts.at(-1)?.description).toBe("https://app.lunos.tech/remote/rl_1")
  })
})
