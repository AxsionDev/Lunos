export * as ConfigMemoryBackend from "./memory-backend"

/**
 * XCOD-134: `memory.backend` credentials must be `{env:VAR}` or `{file:path}` references. Checked in
 * the config loader on each layer's text *before* substitution (after it, a reference and a literal
 * look the same), so a literal password is refused when config is loaded, in every layer: files,
 * OPENCODE_CONFIG_CONTENT, managed and remote config.
 */

export const DOCS =
  "https://github.com/AxsionDev/Lunos/blob/dev/docs/deployment/self-hosted.md#external-memory-database"

const REFERENCE = /^\{(env|file):[^}]+\}$/

/**
 * What's wrong with a raw (unsubstituted) config's memory credentials. Empty when nothing is. The
 * messages name the key, never the value.
 */
export function credentialProblems(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return []
  const memory = (raw as Record<string, unknown>).memory
  if (!memory || typeof memory !== "object") return []
  const backend = (memory as Record<string, unknown>).backend
  if (!backend || typeof backend !== "object") return []
  const out: string[] = []
  for (const key of ["username", "password"] as const) {
    const value = (backend as Record<string, unknown>)[key]
    if (value === undefined) continue
    if (typeof value !== "string" || !REFERENCE.test(value.trim()))
      out.push(
        `memory.backend.${key} must be an {env:VAR} or {file:path} reference, not a literal value. Put the ${key} in an environment variable or a file and reference it (see ${DOCS})`,
      )
  }
  const url = (backend as Record<string, unknown>).url
  if (typeof url === "string" && /^[a-z0-9+.-]+:\/\/[^/@]*@/i.test(url))
    out.push(
      `memory.backend.url must not contain credentials; use memory.backend.username and password as {env:} or {file:} references (see ${DOCS})`,
    )
  return out
}
