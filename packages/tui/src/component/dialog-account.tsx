import { createResource } from "solid-js"
import { useAccount } from "../context/account"
import { useTheme } from "../context/theme"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { failureKind, failureText, type Details } from "../util/account"

// XCOD-273: /account (also /settings → Account): who you are, your plan, organisations and devices,
// and the account's actions. What Lunos Cloud doesn't serve yet is named, never made up.

export function accountLines(details: Details) {
  const user = details.user
  return [
    `${user.name ? `${user.name} · ` : ""}${user.email ?? user.sub}`,
    `Plan: ${user.plan ?? "not reported"}`,
    `Signed in with ${user.issuer}${user.kept ? `, kept in ${user.kept}` : ""}`,
    ...(details.platformRole ? [`Lunos role: ${details.platformRole}`] : []),
    `Organisations: ${
      details.organisations?.length
        ? details.organisations.map((item) => (item.role ? `${item.org} (${item.role})` : item.org)).join(", ")
        : "none"
    }`,
    ...(details.devices
      ? [
          `Devices: ${
            details.devices.length
              ? details.devices
                  .map(
                    (item) =>
                      `${item.name}${item.platform ? ` (${item.platform})` : ""}${item.current ? " · this one" : ""}${item.revoked ? " · signed out" : ""}`,
                  )
                  .join(", ")
              : "none"
          }`,
        ]
      : []),
    ...details.missing,
  ]
}

export function DialogAccount() {
  const account = useAccount()
  const host = account.host
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [details] = createResource(async () => {
    if (!host) return { error: "Lunos accounts aren't available in this client." }
    const signed = await host.current()
    if (!signed) return { signedOut: true as const }
    return host.details().then(
      (value) => ({ details: value }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    )
  })

  const footer = () => {
    const value = details()
    if (!value) return <text fg={theme.textMuted}>Loading your account…</text>
    if ("signedOut" in value) return <text fg={theme.textMuted}>Not signed in. Sign in with /login.</text>
    if ("error" in value) return <text fg={theme.error}>{value.error}</text>
    return (
      <box flexDirection="column">
        {accountLines(value.details).map((line, index) => (
          <text fg={index === 0 ? theme.text : theme.textMuted} wrapMode="word">
            {line}
          </text>
        ))}
      </box>
    )
  }

  const signedIn = () => {
    const value = details()
    return value !== undefined && "details" in value
  }

  return (
    <DialogSelect
      title="Your Lunos account"
      footer={footer()}
      skipFilter
      options={
        signedIn()
          ? [
              { title: "Sign out", value: "logout", description: "on this computer" },
              { title: "Sign out everywhere", value: "everywhere", description: "every device and browser" },
              { title: "Delete my account", value: "delete", description: "removed within 30 days" },
            ]
          : [{ title: "Sign in", value: "login", description: "with your free Lunos account" }]
      }
      onSelect={async (option) => {
        if (!host) return
        if (option.value === "login") {
          dialog.clear()
          return account.login()
        }
        if (option.value === "logout") {
          dialog.clear()
          const result = await host.logout()
          toast.show({
            variant: "info",
            message: result.revoked ? "Signed out." : "Signed out here; the sign-in service couldn't be told.",
          })
          return account.signedOut()
        }
        if (option.value === "everywhere") {
          const sure = await DialogConfirm.show(
            dialog,
            "Sign out everywhere?",
            "Every device and browser signed in to this account is signed out, this one included.",
            "Cancel",
          )
          if (sure !== true) return
          const result = await host.logoutEverywhere()
          toast.show({
            variant: result.ended ? "info" : "warning",
            message: result.message ?? "Signed out everywhere.",
          })
          return account.signedOut()
        }
        if (option.value === "delete") {
          const sure = await DialogConfirm.show(
            dialog,
            "Delete your Lunos account?",
            "Your account, synced sessions and devices are deleted within 30 days, and you're signed out. Your code and local sessions on this computer stay. This can't be undone.",
            "Cancel",
          )
          if (sure !== true) return
          const result = await host.deleteAccount().catch((error: unknown) => {
            const text = failureText(failureKind(error), error instanceof Error ? error.message : String(error))
            return { failed: `${text.why}` }
          })
          if ("failed" in result) return DialogAlert.show(dialog, "Your account wasn't deleted", result.failed)
          await DialogAlert.show(dialog, "Account deleted", result.message)
          return account.signedOut()
        }
      }}
    />
  )
}
