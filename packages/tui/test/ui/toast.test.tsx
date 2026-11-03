import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { ToastProvider, useToast, type ToastContext } from "../../src/ui/toast"

function withToast(run: (toast: ToastContext) => void | Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      let toast!: ToastContext
      const Probe = () => {
        toast = useToast()
        return null
      }
      ToastProvider({
        get children() {
          return Probe()
        },
      } as any)
      Promise.resolve(run(toast)).then(
        () => (dispose(), resolve()),
        (e) => (dispose(), reject(e)),
      )
    })
  })
}

const sandbox = () => ({
  variant: "error" as const,
  title: "Sandbox didn't start",
  message: "image lunos-sandbox:not-here can't be pulled",
  sticky: true,
  log: true,
  actions: [
    { label: "Retry", onSelect() {} },
    { label: "Settings", onSelect() {} },
  ],
})
const policy = () => ({
  variant: "warning" as const,
  title: "Organisation policy",
  message: "Couldn't fetch your organisation's policy from cloud.",
  duration: 20,
})

describe("toast (XCOD-342)", () => {
  test("a passing toast over a sticky one doesn't change it, and the sticky one comes back whole", () =>
    withToast(async (toast) => {
      toast.show(sandbox())
      toast.show(policy())
      expect(toast.currentToast?.title).toBe("Organisation policy")
      expect(toast.currentToast?.actions).toBeUndefined()
      expect(toast.currentToast?.log).toBeUndefined()
      await Bun.sleep(60)
      expect(toast.currentToast?.title).toBe("Sandbox didn't start")
      expect(toast.currentToast?.message).toContain("can't be pulled")
      expect(toast.currentToast?.actions?.map((a) => a.label)).toEqual(["Retry", "Settings"])
    }))

  test("a sticky toast over a passing one shows only its own content", () =>
    withToast((toast) => {
      toast.show(policy())
      toast.show(sandbox())
      expect(toast.currentToast?.title).toBe("Sandbox didn't start")
      expect(toast.currentToast?.message).toContain("can't be pulled")
    }))

  test("dismissing the passing toast brings the sticky one back unchanged", () =>
    withToast((toast) => {
      toast.show(sandbox())
      toast.show({ ...policy(), duration: 10_000 })
      toast.dismiss()
      expect(toast.currentToast?.message).toContain("can't be pulled")
      expect(toast.currentToast?.title).toBe("Sandbox didn't start")
      toast.dismiss()
      expect(toast.currentToast).toBeNull()
    }))
})
