// XCOD-124: rebrands upstream opencode's docs to Lunos at build time. The .mdx sources stay as
// upstream wrote them (plus Lunos's earlier in-place edits), so each weekly upstream merge
// (XCOD-118) doesn't conflict on docs pages; whatever "opencode" a merge brings in is rebranded
// here instead.
//
// It renames the product, the command, the npm package and install/support links. It keeps
// every identifier the Lunos binary still reads: `opencode.json`, `.opencode/`, `OPENCODE_*`,
// `@opencode-ai/*`, the `$schema` URLs, and third-party names (see the Naming page).

/** Identifiers that stay "opencode" because Lunos still uses them, or because they aren't ours. */
const KEEP: RegExp[] = [
  /https:\/\/opencode\.ai\/(?:config|tui|theme)\.json/g, // $schema URLs the CLI writes
  /\bopencode\.jsonc?\b/g,
  /\bopencode\.local\b/g,
  /\.well-known\/opencode\b/g,
  /(?:~|\$HOME|\$XDG_[A-Z_]+|%[A-Z]+%|[A-Za-z]:)?[\\/]?(?:\.config|\.local[\\/]share|\.cache|\.local[\\/]state|Application Support|Support|AppData[\\/](?:Roaming|Local))[\\/]opencode\b/g,
  /(?<![\w-])\.opencode\b/g,
  /\b[A-Z_]*OPENCODE[A-Z_]*\b/g,
  /@opencode-ai\/[\w-]+/g,
  /\bai\.opencode\.[\w.]+/g,
  /\bcreateOpencode(?:Client|Server)?\b/g,
  // The server-ready line `lunos serve` still prints, because the SDK waits for it (XCOD-127).
  /\bopencode server listening\b/g,
  /\bx-opencode-[\w-]+/g,
  // Third-party plugins and repos that happen to have "opencode" in their name.
  /\bopencode-(?!ai\b)[\w-]+/g,
  /\bopencode\.nvim\b/g,
  /github\.com\/(?!anomalyco\/)[\w.-]+\/[\w.-]*opencode[\w.-]*/g,
]

/** Rewrites applied before the generic product-name rename. Order matters. */
const REWRITE: [RegExp, string][] = [
  [
    /curl -fsSL https:\/\/opencode\.ai\/install \| bash/g,
    "curl -fsSL https://raw.githubusercontent.com/AxsionDev/Lunos/dev/install | bash",
  ],
  [/\bnpm (?:install|i) -g opencode-ai(?:@latest)?/g, "npm install -g lunos-ai@latest --allow-scripts=lunos-ai"],
  [/\bbun (?:install|add) -g opencode-ai(?:@latest)?/g, "bun install -g lunos-ai@latest"],
  [/\bpnpm (?:install|add) -g opencode-ai(?:@latest)?/g, "pnpm install -g lunos-ai@latest"],
  [/\byarn global add opencode-ai(?:@latest)?/g, "yarn global add lunos-ai@latest"],
  [/\bopencode-ai\b/g, "lunos-ai"],
  [
    /https:\/\/github\.com\/anomalyco\/opencode\/(issues|releases|discussions)/g,
    "https://github.com/AxsionDev/Lunos/$1",
  ],
  [/https:\/\/github\.com\/anomalyco\/opencode\b/g, "https://github.com/AxsionDev/Lunos"],
  [/https:\/\/opencode\.ai\/docs\/?/g, "/docs/"],
]

type Segment = { code: boolean; text: string }

/** Splits MDX into code (fenced blocks and inline code) and everything else. */
function segments(text: string): Segment[] {
  const out: Segment[] = []
  // Fences may be indented (inside list items); the closing fence matches the opening one.
  const pattern = /(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?\n\2\3[^\n]*|`[^`\n]+`/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const start = match.index! + (match[1]?.length ?? 0)
    if (start > last) out.push({ code: false, text: text.slice(last, start) })
    out.push({ code: true, text: text.slice(start, match.index! + match[0].length) })
    last = match.index! + match[0].length
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) })
  return out
}

/** Frontmatter is prose (titles and descriptions) apart from its keys. */
function splitFrontmatter(text: string) {
  const match = text.match(/^---\n[\s\S]*?\n---\n/)
  return match ? [match[0], text.slice(match[0].length)] : ["", text]
}

export function rebrand(source: string) {
  const kept: string[] = []
  const protect = (text: string) => {
    let out = text
    for (const pattern of KEEP) out = out.replace(pattern, (m) => `\u0000${kept.push(m) - 1}\u0000`)
    return out
  }
  const restore = (text: string) => text.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)])
  const rename = (text: string, code: boolean) => {
    let out = protect(text)
    for (const [pattern, to] of REWRITE) out = out.replace(pattern, to)
    // Any other opencode.ai URL is upstream's service: leave it as it is, so check-built.ts
    // reports it and the page gets fixed, rather than renaming it to a domain that doesn't exist.
    out = out.replace(/\bopencode\.ai\b[^\s)"'`>]*/g, (m) => `\u0000${kept.push(m) - 1}\u0000`)
    // In code, `opencode` is the command. In prose it's the product.
    out = out.replace(/\bOpen[Cc]ode\b/g, "Lunos").replace(/\bopencode\b/g, code ? "lunos" : "Lunos")
    return restore(out)
  }
  const [front, body] = splitFrontmatter(source)
  return (
    rename(front, false) +
    segments(body)
      .map((part) => rename(part.text, part.code))
      .join("")
  )
}

/** Removes `## Heading` sections (up to the next heading of the same or higher level). */
export function dropSections(source: string, headings: string[]) {
  let out = source
  for (const heading of headings) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const start = out.match(new RegExp(`^(#{1,6}) ${escaped}\\s*$`, "m"))
    if (!start) throw new Error(`dropSections: heading "${heading}" not found`)
    const level = start[1].length
    const from = start.index!
    const rest = out.slice(from + start[0].length)
    const next = rest.match(new RegExp(`^#{1,${level}} `, "m"))
    const to = next ? from + start[0].length + next.index! : out.length
    out = out.slice(0, from) + out.slice(to)
  }
  return out
}
