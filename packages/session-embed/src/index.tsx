import "./embed.css"
import { render } from "solid-js/web"
import { For } from "solid-js"
import { MetaProvider } from "@solidjs/meta"
import { DialogProvider } from "@opencode-ai/ui/context/dialog"
import { MarkedProvider } from "@opencode-ai/ui/context/marked"
import { I18nProvider } from "@opencode-ai/ui/context"
import { pluralCategory, pluralKey, type UiI18nParams, type UiI18nPluralKey } from "@opencode-ai/ui/context/i18n"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { WorkerPoolProvider } from "@opencode-ai/ui/context/worker-pool"
import { DataProvider } from "@opencode-ai/session-ui/context"
import { SessionTurn } from "@opencode-ai/session-ui/session-turn"
import { FileSSR } from "@opencode-ai/session-ui/file-ssr"
import { getWorkerPools } from "@opencode-ai/session-ui/pierre/worker"
import { toData, type EmbedMessage, type EmbedSession } from "./data"
import { applyLunosTheme } from "./theme"

export type EmbedInput = {
  session: EmbedSession
  messages: EmbedMessage[]
}

const tpl = (text: string, p?: UiI18nParams) =>
  p ? text.replace(/{{\s*([^}]+?)\s*}}/g, (_, k) => (p[String(k)] === undefined ? "" : String(p[String(k)]))) : text

const locale = () => "en"
const t = (key: keyof typeof uiEn, p?: UiI18nParams) => tpl(uiEn[key] ?? String(key), p)
const plural = (key: UiI18nPluralKey, count: number, p?: UiI18nParams) =>
  t(pluralKey(key, pluralCategory("en", count)) as keyof typeof uiEn, { ...p, count })

function App(props: { input: EmbedInput }) {
  const { data, userMessageIDs } = toData(props.input.session, props.input.messages)
  const session = data.session[0]!
  return (
    <MetaProvider>
      <DialogProvider>
        <MarkedProvider>
          <I18nProvider value={{ locale, t, plural } as any}>
            <WorkerPoolProvider pools={getWorkerPools()}>
              <FileComponentProvider component={FileSSR}>
                <DataProvider data={data as any} directory={session.directory} sessionID={session.id}>
                  <div class="flex flex-col gap-15 items-start justify-start">
                    <For each={userMessageIDs}>
                      {(id) => (
                        <SessionTurn
                          sessionID={session.id}
                          messageID={id}
                          editToolDefaultOpen={false}
                          shellToolDefaultOpen={false}
                          classes={{
                            root: "min-w-0 w-full relative",
                            content: "flex flex-col justify-between !overflow-visible",
                            container: "px-4",
                          }}
                        />
                      )}
                    </For>
                  </div>
                </DataProvider>
              </FileComponentProvider>
            </WorkerPoolProvider>
          </I18nProvider>
        </MarkedProvider>
      </DialogProvider>
    </MetaProvider>
  )
}

/** Renders the session read-only into `el`, in the dark Catppuccin look (./theme); returns a dispose function. */
export function mount(el: HTMLElement, input: EmbedInput): () => void {
  applyLunosTheme(el)
  return render(() => <App input={input} />, el)
}
