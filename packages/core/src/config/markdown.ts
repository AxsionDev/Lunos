export * as ConfigMarkdown from "./markdown"

import matter from "gray-matter"

// XCOD-208: front matter is data, so only YAML (gray-matter's default) and JSON are accepted. Any
// other front-matter language is refused, and the non-data engines are replaced as a backstop.
const LANGUAGES = new Set(["", "yaml", "yml", "json"])

function refuse(): never {
  throw new Error("front matter must be YAML or JSON")
}

const OPTIONS = { engines: { js: refuse, javascript: refuse } } as const

function language(content: string) {
  const match = content.replace(/^\uFEFF/, "").match(/^---([^\r\n]*)/)
  return match ? match[1].trim().toLowerCase() : ""
}

function read(content: string) {
  const lang = language(content)
  if (!LANGUAGES.has(lang)) throw new Error(`front matter must be YAML or JSON, not "${lang}"`)
  return matter(content, OPTIONS)
}

export function parse(content: string) {
  try {
    return read(content)
  } catch {
    return read(sanitize(content))
  }
}

export function parseOption(content: string) {
  try {
    return parse(content)
  } catch {
    return undefined
  }
}

// Other coding agents accept unquoted colons in frontmatter values. Retry
// those values as YAML block scalars so existing config files keep working.
export function sanitize(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]
  const result = frontmatter.split(/\r?\n/).flatMap((line) => {
    if (line.trim().startsWith("#") || line.trim() === "" || /^\s+/.test(line)) return [line]
    const entry = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!entry) return [line]
    const value = entry[2].trim()
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) return [line]
    if (!value.includes(":")) return [line]
    return [`${entry[1]}: |-`, `  ${value}`]
  })
  return content.replace(frontmatter, () => result.join("\n"))
}
