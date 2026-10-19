// XCOD-270: what the external-fixture recorder takes out of Claude Code's and Codex's traffic before
// a line is written: the key it was given (by value), anything shaped like a key, token, JWT or
// e-mail, values under secret-looking JSON keys, and the machine's paths (the throwaway HOME, the
// project, the repo, bun, the real home directory), so a recording says `<home>` rather than a path
// with the user's name in it. Session and thread ids are kept: a replayed resume needs them.

export interface Context {
  /** Literal values to remove wherever they appear (the API key the tool was given). */
  secrets: string[]
  /** [path, placeholder] pairs; each path is also matched in its macOS `/private` and dash-encoded forms. */
  paths: [string, string][]
  /** The local user name, when it shouldn't appear even outside a path. */
  user?: string
}

const PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{6,}/g, "<redacted:anthropic-key>"],
  [/sk-proj-[A-Za-z0-9_-]{6,}/g, "<redacted:openai-key>"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<redacted:key>"],
  [/\bsess-[A-Za-z0-9_-]{6,}/g, "<redacted:session-token>"],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "<redacted:jwt>"],
  [/\b(Bearer|Basic)\s+(?!<redacted)[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "<redacted:email>"],
]

/** JSON keys whose string value is a secret or identifies the account, whatever it looks like. */
const SECRET_KEY =
  /(token|api_?key|secret|password|passwd|authorization|cookie|credentials?)$|^(account|org|organization|user)_?(id|uuid)$|^e-?mail(_?address)?$/i

/** A path as the tools may report it: as given, under macOS's /private, and dash-encoded (Claude Code's project dirs). */
function variants(input: string) {
  const forms = new Set([input])
  if (input.startsWith("/private/")) forms.add(input.slice("/private".length))
  else if (/^\/(var|tmp)\//.test(input)) forms.add("/private" + input)
  for (const form of [...forms]) forms.add(form.replace(/[^A-Za-z0-9]/g, "-"))
  return [...forms].filter((form) => form.length > 3)
}

export function compile(context: Context) {
  const literal: [string, string][] = [
    ...context.secrets
      .filter((value) => value.length >= 6)
      .map((value): [string, string] => [value, "<redacted:secret>"]),
    ...context.paths.flatMap(([from, to]) => variants(from).map((form): [string, string] => [form, to])),
  ].sort((a, b) => b[0].length - a[0].length)
  const user = context.user && context.user.length >= 3 ? context.user : undefined
  const string = (input: string) => {
    let output = input
    for (const [from, to] of literal) output = output.split(from).join(to)
    for (const [pattern, to] of PATTERNS) output = output.replace(pattern, to)
    if (user) output = output.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "<user>")
    return output
  }
  const value = (input: unknown, key?: string): unknown => {
    if (typeof input === "string") return key && SECRET_KEY.test(key) ? `<redacted:${key}>` : string(input)
    if (Array.isArray(input)) return input.map((item) => value(item))
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [string(k), value(v, k)]))
    return input
  }
  return { string, value }
}

/** What would still identify someone or something secret in recorded text; empty when it's clean. */
export function scan(text: string, user?: string) {
  const checks: [string, RegExp][] = [
    ["anthropic key", /sk-ant-[A-Za-z0-9]/],
    ["key", /\bsk-[A-Za-z0-9_-]{6,}/],
    ["session token", /\bsess-[A-Za-z0-9]/],
    ["JWT", /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\./],
    ["bearer token", /\bBearer\s+(?!<redacted)\S{8,}/i],
    ["e-mail", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
    ["macOS home path", /\/Users\/[^<\s"]/],
    ["Linux home path", /\/home\/(?!user\/)[^<\s"/]+/],
    ...(user && user.length >= 3 ? [["user name", new RegExp(`\\b${user}\\b`)] as [string, RegExp]] : []),
  ]
  return text
    .split("\n")
    .flatMap((line, index) =>
      checks.flatMap(([name, pattern]) => (pattern.test(line) ? [{ line: index + 1, kind: name }] : [])),
    )
}
