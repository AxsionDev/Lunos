import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { For, Show } from "solid-js"
import { ExternalLink } from "@/components/external-link"
import { useAccount } from "@/context/account"
import { useLanguage } from "@/context/language"
import { disabledLines, SUPPORT_EMAIL } from "@/utils/account-disabled"

/**
 * XCOD-312: the full-screen notice of a disabled Lunos account, the same content as the TUI's: the
 * title, the reason category, the end date, and support@lunos.tech. Leaving it shows the app
 * read-only; the prompt then says why it can't be used.
 */
export function DisabledAccountNotice() {
  const account = useAccount()
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string>) =>
    language.t(key as Parameters<typeof language.t>[0], params as never)
  const contact = () => t("account.disabled.contact", { email: "\u0000" }).split("\u0000")

  return (
    <Show when={account?.notice() && account.disabled()}>
      {(disabled) => (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="account-disabled-title"
          class="fixed inset-0 z-[9998] flex flex-col items-center justify-center gap-6 bg-background-base p-6"
        >
          <div class="flex flex-col items-center gap-2 max-w-md text-center">
            <Splash class="w-12 h-15 mb-4" />
            <h1 id="account-disabled-title" class="text-16-medium text-text-strong">
              {t("account.disabled.title")}
            </h1>
            <For each={disabledLines(disabled(), t)}>
              {(line) => <p class="text-14-regular text-text-base">{line}</p>}
            </For>
            <p class="text-14-regular text-text-base">
              {contact()[0]}
              <ExternalLink href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</ExternalLink>
              {contact()[1]}
            </p>
            <p class="mt-2 text-12-regular text-text-weak">{t("account.disabled.readOnly")}</p>
          </div>
          <Button variant="secondary" size="large" onClick={() => account?.viewReadOnly()}>
            {t("account.disabled.viewSessions")}
          </Button>
        </div>
      )}
    </Show>
  )
}
