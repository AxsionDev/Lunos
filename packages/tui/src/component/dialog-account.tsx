import { createResource } from "solid-js"
import { useAccount } from "../context/account"
import { useTheme } from "../context/theme"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { failureKind, failureText, organisationLine, platformRoleText, type Details } from "../util/account"

// XCOD-273: /account (also /settings → Account): who you are, your plan, organisations and devices,
// and the account's actions. What Lunos Cloud doesn't serve yet is named, never made up. XCOD-274:
// your role, in each organisation ("Owner · Acme GmbH"), and invitations waiting for you.

/** What to type to confirm deleting the account. */
export const DELETE_WORD = "delete"

export function accountLines(details: Details) {
  const user = details.user
  return [
    `${user.name ? `${user.name} · ` : ""}${user.email ?? user.sub}`,
    `Plan: ${user.plan ?? "not reported"}`,
    `Signed in with ${user.issuer}${user.kept ? `, kept in ${user.kept}` : ""}`,
    ...(details.platformRole ? [`Role: ${platformRoleText(details.platformRole)}`] : []),
    `Organisations: ${details.organisations?.length ? details.organisations.map(organisationLine).join(", ") : "none"}`,
    ...(details.invitations?.length
      ? [
          `Invitations: ${details.invitations
            .map((item) => `${item.name}${item.role ? ` (as ${item.role})` : ""}`)
            .join(", ")}`,
        ]
      : []),
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
  const [details, { refetch }] = createResource(async () => {
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
  const invitations = () => {
    const value = details()
    return value && "details" in value ? (value.details.invitations ?? []) : []
  }

  return (
    <DialogSelect
      title="Your Lunos account"
      footer={footer()}
      skipFilter
      options={
        signedIn()
          ? [
              ...invitations().flatMap((item) => [
                {
                  title: `Accept the invitation to ${item.name}`,
                  value: `accept:${item.org}`,
                  description: item.role ? `as ${item.role}` : undefined,
                },
                { title: `Decline the invitation to ${item.name}`, value: `decline:${item.org}` },
              ]),
              { title: "Sign out", value: "logout", description: "on this computer" },
              { title: "Sign out everywhere", value: "everywhere", description: "every device and browser" },
              { title: "Delete my account", value: "delete", description: "removed within 30 days" },
            ]
          : [{ title: "Sign in", value: "login", description: "with your free Lunos account" }]
      }
      onSelect={async (option) => {
        if (!host) return
        const invitation = /^(accept|decline):(.+)$/.exec(String(option.value))
        if (invitation && host.answerInvitation) {
          const message = await host
            .answerInvitation(invitation[2]!, invitation[1] === "accept")
            .catch((error: unknown) => {
              toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
              return undefined
            })
          if (message) toast.show({ variant: "success", message })
          return refetch()
        }
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
          // Typed, not a highlighted button: this can't be undone.
          const typed = await DialogPrompt.show(dialog, "Delete your Lunos account?", {
            description: () => (
              <text fg={theme.textMuted} wrapMode="word">
                Lunos Cloud deletes your synced sessions and devices now, takes you out of your organisations, and
                deletes the account within 30 days. You're signed out here. Your code and local sessions on this
                computer stay. This can't be undone. Type {DELETE_WORD} to confirm.
              </text>
            ),
            placeholder: DELETE_WORD,
          })
          if (typed === null) return
          if (typed.trim().toLowerCase() !== DELETE_WORD)
            return DialogAlert.show(
              dialog,
              "Your account wasn't deleted",
              `You typed "${typed.trim()}", not "${DELETE_WORD}".`,
            )
          const result = await host.deleteAccount().catch((error: unknown) => {
            const text = failureText(failureKind(error), error instanceof Error ? error.message : String(error))
            return { deleted: false as const, title: "Your account wasn't deleted", message: text.why }
          })
          if (!result.deleted) return DialogAlert.show(dialog, result.title, result.message)
          await DialogAlert.show(dialog, "Account deleted", result.message)
          return account.signedOut()
        }
      }}
    />
  )
}
