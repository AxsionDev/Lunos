// XCOD-124: page-level corrections for things upstream's docs describe that Lunos doesn't have
// (OpenCode Zen and Go, opncd.ai sharing, upstream's community pages and install channels).
// Applied by prepare.ts before rebrand(). Each `find` must match exactly once: when upstream
// rewrites the text, the build fails and the patch gets revisited, instead of silently lapsing.

export type Patch = [find: string | RegExp, replace: string]

const EU_EXAMPLE = "For example, with Mistral you would use `mistral/mistral-large-latest`."
const ZEN_EXAMPLE =
  "For example, if you're using [OpenCode Zen](/docs/zen), you would use `opencode/gpt-5.1-codex` for GPT 5.1 Codex."

export const PATCHES: Record<string, Patch[]> = {
  index: [
    [
      /- \*\*Using Homebrew on macOS and Linux\*\*[\s\S]*?Support for installing Lunos on Windows using Bun is currently in progress\.\n/,
      [
        "#### Windows",
        "",
        ":::tip[Recommended: Use WSL]",
        "For the best experience on Windows, we recommend using [Windows Subsystem for Linux (WSL)](/docs/windows-wsl) and the install script above.",
        ":::",
        "",
        "Or install with npm:",
        "",
        "```bash",
        "npm install -g lunos-ai@latest --allow-scripts=lunos-ai",
        "```",
        "",
        "Lunos isn't published to Homebrew, the AUR, Chocolatey, Scoop, mise or Docker yet.",
        "",
      ].join("\n"),
    ],
    [
      /If you are new to using LLM providers, we recommend using \[OpenCode Zen\]\(\/docs\/zen\)\.[\s\S]*?(?=Alternatively, you can select one of the other providers\.)/,
      [
        "To keep your code and prompts with an EU provider, use one such as Mistral, Scaleway, OVHcloud or Hetzner, and see [Data residency](/docs/data-residency).",
        "",
        "1. Create an API key with your provider, for example in the [Mistral console](https://console.mistral.ai/api-keys).",
        "",
        "2. Run the `/connect` command in the TUI and search for your provider.",
        "",
        "   ```txt",
        "   /connect",
        "   ```",
        "",
        "3. Paste your API key.",
        "",
      ].join("\n"),
    ],
    ["Alternatively, you can select one of the other providers.", "Lunos works with many other providers too."],
  ],
  cli: [[/#### install\n[\s\S]*?(?=#### run)/, ""]],
  agents: [[ZEN_EXAMPLE, EU_EXAMPLE]],
  models: [[ZEN_EXAMPLE, EU_EXAMPLE]],
  config: [
    [
      "You can configure the [share](/docs/share) feature through the `share` option.",
      "You can configure session sharing through the `share` option. Lunos turns sharing off unless you enable it.",
    ],
  ],
  plugins: [
    [
      "For examples, check out the [plugins](/docs/ecosystem#plugins) created by the community.",
      "For examples, browse the plugins in the Lunos marketplace with `lunos marketplace`.",
    ],
    [
      "Browse available plugins in the [ecosystem](/docs/ecosystem#plugins).",
      "Browse available plugins with `lunos marketplace`.",
    ],
  ],
  sdk: [[" For examples, check out the [projects](/docs/ecosystem#projects) built by the community.", ""]],
  tools: [
    [
      "This tool is only available when using the Lunos or OpenCode Go provider, or when either",
      "This tool is off unless either",
    ],
  ],
  tui: [
    [
      "Share current session. [Learn more](/docs/share).",
      "Share current session. Off in Lunos unless you enable `share` in [config](/docs/config#sharing).",
    ],
    ["Unshare current session. [Learn more](/docs/share#un-sharing).", "Unshare current session."],
  ],
  troubleshooting: [
    [
      "[**github.com/anomalyco/opencode/issues**](https://github.com/anomalyco/opencode/issues)",
      "[**github.com/AxsionDev/Lunos/issues**](https://github.com/AxsionDev/Lunos/issues)",
    ],
    [/2\. \*\*Join our Discord\*\*\n[\s\S]*?\(https:\/\/opencode\.ai\/discord\)\n/, ""],
  ],
}

export function applyPatches(page: string, text: string) {
  let out = text
  for (const [find, replace] of PATCHES[page] ?? []) {
    const count =
      typeof find === "string" ? out.split(find).length - 1 : (out.match(new RegExp(find.source, "g")) ?? []).length
    if (count !== 1) throw new Error(`patches: "${String(find).slice(0, 70)}" matches ${count} times in ${page}.mdx`)
    out = out.replace(find, replace)
  }
  return out
}
