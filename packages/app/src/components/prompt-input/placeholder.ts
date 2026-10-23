type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  example: string
  suggest: boolean
  /** XCOD-312: the Lunos account is disabled; the prompt says why it can't be used. */
  accountDisabled?: boolean
  t: (key: string, params?: Record<string, string>) => string
}

export function promptPlaceholder(input: PromptPlaceholderInput) {
  if (input.accountDisabled) return input.t("prompt.placeholder.accountDisabled")
  if (input.mode === "shell") return input.t("prompt.placeholder.shell", { example: input.example })
  if (input.commentCount > 1) return input.t("prompt.placeholder.summarizeComments")
  if (input.commentCount === 1) return input.t("prompt.placeholder.summarizeComment")
  if (!input.suggest) return input.t("prompt.placeholder.simple")
  return input.t("prompt.placeholder.normal", { example: input.example })
}

export function promptDesignPlaceholder(
  mode: PromptPlaceholderInput["mode"],
  placeholder: string,
  t: PromptPlaceholderInput["t"],
  accountDisabled = false,
) {
  if (mode === "shell" || accountDisabled) return placeholder
  return t("ui.promptInput.placeholder.normal", { slash: "/", at: "@" })
}
