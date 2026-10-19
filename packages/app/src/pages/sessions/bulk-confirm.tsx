import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"

export type BulkConfirmOptions = {
  title: string
  lines: string[]
  /** The confirm button; a function when it names a count that depends on the chosen scope. */
  confirm: string | ((scope: string | undefined) => string)
  /** Permanent: the confirm button only works once this is typed back (XCOD-265 Delete archived). */
  typed?: { value: string; placeholder: string }
  /** A choice of which sessions the action reaches ("Stop all" in one project only). The first is the default. */
  scopes?: { value: string; label: string }[]
  scopeLabel?: string
}

/**
 * XCOD-265: the one confirmation of a bulk action in the Sessions window. The confirm button is the
 * default (Enter) and Esc cancels; resolves to the chosen scope, or undefined when cancelled.
 */
export function useBulkConfirm() {
  const dialog = useDialog()
  return (options: BulkConfirmOptions) =>
    new Promise<{ scope?: string } | undefined>((resolve) => {
      void dialog.show(
        () => (
          <BulkConfirm
            {...options}
            onDone={(result) => {
              resolve(result)
              dialog.close()
            }}
          />
        ),
        () => resolve(undefined),
      )
    })
}

function BulkConfirm(props: BulkConfirmOptions & { onDone: (result: { scope?: string } | undefined) => void }) {
  const language = useLanguage()
  const [typed, setTyped] = createSignal("")
  const [scope, setScope] = createSignal(props.scopes?.[0]?.value)
  const ready = () => !props.typed || typed().trim() === props.typed.value

  return (
    <Dialog title={props.title} fit>
      <form
        class="flex flex-col gap-4 pl-6 pr-2.5 pb-3"
        data-component="sessions-bulk-confirm"
        onSubmit={(event) => {
          event.preventDefault()
          if (ready()) props.onDone({ scope: scope() })
        }}
      >
        <div class="flex max-w-[520px] flex-col gap-1">
          <For each={props.lines}>{(line) => <p class="text-14-regular text-text-strong">{line}</p>}</For>
        </div>
        <Show when={props.scopes && props.scopes.length > 1 ? props.scopes : undefined}>
          {(scopes) => (
            <label class="flex items-center gap-2 text-14-regular text-text-strong">
              <span>{props.scopeLabel}</span>
              <select
                class="rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-14-regular"
                value={scope()}
                onChange={(event) => setScope(event.currentTarget.value)}
              >
                <For each={scopes()}>{(item) => <option value={item.value}>{item.label}</option>}</For>
              </select>
            </label>
          )}
        </Show>
        <Show when={props.typed}>
          {(spec) => (
            <input
              class="rounded border border-v2-border-border-base bg-transparent px-2 py-1 text-14-regular"
              inputMode="numeric"
              aria-label={spec().placeholder}
              placeholder={spec().placeholder}
              value={typed()}
              autofocus
              onInput={(event) => setTyped(event.currentTarget.value)}
            />
          )}
        </Show>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => props.onDone(undefined)}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="large" disabled={!ready()} autofocus={!props.typed}>
            {typeof props.confirm === "function" ? props.confirm(scope()) : props.confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
