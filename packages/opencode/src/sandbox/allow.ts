import { Jurisdiction } from "@opencode-ai/core/jurisdiction"
import { Residency } from "@opencode-ai/core/residency"
import type { SandboxConfig } from "./config"

// XCOD-157: what a sandbox may reach under `sandbox.network: "policy"`, computed on the host when the
// sandbox is created and handed to its egress proxy. Entries are "host:port"; a leading "." matches
// any subdomain. Everything else is refused, and the refusal is logged.
//
// - Model endpoints: each configured provider's baseURL, and the API hosts of providers you have
//   credentials for. Under a residency policy, only providers the policy allows.
// - Remote MCP servers from config.
// - The npm registry, for LSP servers and packages the agent installs.
// - sandbox.allow, from your global and managed config (never a repository's).

/** API hosts of providers whose SDK has no baseURL in config: the host it calls by default. */
export const DEFAULT_HOSTS: Record<string, readonly string[]> = {
  anthropic: ["api.anthropic.com"],
  openai: ["api.openai.com"],
  google: ["generativelanguage.googleapis.com"],
  groq: ["api.groq.com"],
  xai: ["api.x.ai"],
  deepseek: ["api.deepseek.com"],
  openrouter: ["openrouter.ai"],
  cerebras: ["api.cerebras.ai"],
  togetherai: ["api.together.xyz"],
  "fireworks-ai": ["api.fireworks.ai"],
  perplexity: ["api.perplexity.ai"],
  "github-copilot": ["api.githubcopilot.com", "api.individual.githubcopilot.com", "api.github.com"],
}

/** *_API_KEY variables whose provider id isn't simply the prefix, lower-cased. */
const ENV_PROVIDERS: Record<string, string> = {
  GOOGLE_GENERATIVE_AI_API_KEY: "google",
  GEMINI_API_KEY: "google",
  TOGETHER_API_KEY: "togetherai",
  FIREWORKS_API_KEY: "fireworks-ai",
}

export const NPM_REGISTRY = "registry.npmjs.org:443"

/** The provider ids implied by *_API_KEY variable names. */
export function providersFromEnv(names: readonly string[]) {
  return names.map(
    (name) =>
      ENV_PROVIDERS[name] ??
      name
        .replace(/_API_KEY$/, "")
        .toLowerCase()
        .replaceAll("_", "-"),
  )
}

/** "host" or "host:port" (a sandbox.allow entry) as "host:port", 443 by default. */
export function entry(value: string) {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "")
  return /:\d+$/.test(trimmed) ? trimmed : `${trimmed}:443`
}

/** A URL's "host:port", with the scheme's default port. */
export function fromURL(url: string) {
  try {
    const parsed = new URL(url)
    const port = parsed.port || (parsed.protocol === "http:" ? "80" : "443")
    return `${parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")}:${port}`
  } catch {
    return undefined
  }
}

type Doc = Record<string, unknown>
const record = (value: unknown): Doc =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Doc) : {}

export type Computed = {
  allow: string[]
  /** Providers left out because the residency policy doesn't allow them. */
  denied: { provider: string; reason: string }[]
}

export function compute(input: {
  /** Effective config: providers, mcp and residency (SandboxConfig.effectiveDoc). */
  doc: Doc
  /** Provider ids you hold credentials for. */
  providers: readonly string[]
  network: SandboxConfig.Network
  /** sandbox.allow. */
  extra: readonly string[]
}): Computed {
  if (input.network !== "policy") return { allow: [], denied: [] }
  const configured = record(input.doc.provider)
  const residency = input.doc.residency as Residency.ConfigBlock | undefined
  const policy = residency && Array.isArray(residency.allow) ? Residency.resolve(residency)?.policy : undefined
  const allow = new Set<string>()
  const denied: Computed["denied"] = []

  for (const provider of new Set([...Object.keys(configured), ...input.providers])) {
    const baseURL = record(record(configured[provider]).options).baseURL
    const url = typeof baseURL === "string" ? baseURL : undefined
    const hosts = url
      ? [fromURL(url)]
      : (DEFAULT_HOSTS[provider] ?? Jurisdiction.lookup(provider).hosts ?? []).map((host) => `${host}:443`)
    if (hosts.length === 0) continue
    if (policy) {
      const decision = Residency.evaluate(provider, policy, url)
      if (!decision.allowed) {
        denied.push({ provider, reason: decision.reason })
        continue
      }
    }
    for (const host of hosts) if (host) allow.add(host)
  }

  for (const server of Object.values(record(input.doc.mcp))) {
    const mcp = record(server)
    if (mcp.type === "remote" && typeof mcp.url === "string" && mcp.enabled !== false) {
      const host = fromURL(mcp.url)
      if (host) allow.add(host)
    }
  }

  allow.add(NPM_REGISTRY)
  for (const value of input.extra) allow.add(entry(value))
  return { allow: [...allow].sort(), denied }
}

export * as SandboxAllow from "./allow"
