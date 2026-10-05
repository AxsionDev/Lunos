export * as AgentBundle from "./bundle"

import crypto from "node:crypto"
import path from "node:path"
import { BlobWriter, Uint8ArrayReader, Writer, ZipReader, ZipWriter, configure } from "@zip.js/zip.js"
import { Exit, Schema } from "effect"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { MarketplaceRefusal, requireHttpUrl } from "../marketplace/guard"

/**
 * The agent bundle (XCOD-209, slice (a) of XCOD-203): one agent, packaged to share or move to
 * another machine. A zip with:
 *
 * - `manifest.json`: format, name, the MCP servers the agent uses, the skills it ships, and a
 *   SHA-256 for every other file. The checksums catch corruption only. Whoever made the bundle
 *   wrote them too, so they say nothing about who that was.
 * - `agent.json`: the agent's definition, as validated config (never markdown, so importing one
 *   never runs a front-matter parser over someone else's file).
 * - `skills/<name>/…`: the skills the agent names, with all their files.
 *
 * MCP servers use the marketplace's entry format, which holds environment and header NAMES and
 * never values, so a bundle can't carry a credential in those places. Export refuses the ones it
 * can't convert (a secret in a URL, in OAuth config, or repeated elsewhere). Hooks are never
 * bundled, and a bundle that declares any is refused.
 */

export const FORMAT = "lunos-agent/1"
export const EXTENSION = ".lunos-agent"

/** Caps on what import will read, before anything is unpacked. */
export const LIMITS = { files: 500, bytes: 20 * 1024 * 1024, file: 2 * 1024 * 1024 }

/** Agent fields a bundle carries. `tools` is deprecated and already folded into `permission`. */
const AGENT_FIELDS = [
  "description",
  "mode",
  "model",
  "variant",
  "temperature",
  "top_p",
  "prompt",
  "color",
  "steps",
  "hidden",
  "permission",
  "options",
] as const

// An agent's `options` go to its model call. Keys that redirect it or carry a credential don't
// belong in a bundle: they would leak on export and could route traffic around residency on import.
const ENDPOINT_OPTION = /^(base_?url|url|endpoint|headers?|fetch|api_?base)$/i
const SECRET_NAME = /(key|token|secret|password|passwd|authorization|credential|cookie)/i

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export class Refusal extends MarketplaceRefusal {
  override name = "AgentBundleRefusal"
}

export type Agent = Partial<Record<(typeof AGENT_FIELDS)[number], unknown>>

export interface Manifest {
  format: typeof FORMAT
  name: string
  lunos?: string
  exported_at?: string
  mcp: Marketplace.McpEntry[]
  skills: string[]
  files: Record<string, string>
}

export interface Bundle {
  manifest: Manifest
  agent: Agent
  /** Skill files by skill name, with paths relative to the skill's directory. */
  skills: Record<string, Record<string, Uint8Array>>
}

const sha256 = (bytes: Uint8Array) => crypto.createHash("sha256").update(bytes).digest("hex")
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n")

export function checkName(name: string, what = "agent") {
  if (!NAME.test(name)) throw new Refusal(`"${name}" isn't a usable ${what} name (letters, digits, ".", "_", "-")`)
  return name
}

// ---------------------------------------------------------------------------------------------
// Export

/** The agent as a bundle carries it, from its decoded config. Refuses options that don't travel. */
export function agentDoc(agent: ConfigAgentV1.Info): Agent {
  const doc: Agent = {}
  for (const field of AGENT_FIELDS) {
    const value = (agent as Record<string, unknown>)[field]
    if (value === undefined) continue
    if (field === "options" && typeof value === "object" && value && Object.keys(value).length === 0) continue
    doc[field] = value
  }
  checkOptions(
    doc.options,
    "can't be exported: it sets a model endpoint or holds a credential. Remove it from the agent first",
  )
  return doc
}

/** Refuses endpoint and credential keys anywhere in an agent's options, at any depth. */
function checkOptions(options: unknown, reason: string, at = "options") {
  if (!options || typeof options !== "object") return
  for (const [key, value] of Object.entries(options)) {
    if (ENDPOINT_OPTION.test(key) || SECRET_NAME.test(key)) throw new Refusal(`The agent's ${at}.${key} ${reason}`)
    checkOptions(value, reason, `${at}.${key}`)
  }
}

/** Refuses a config substitution token ({env:…}, {file:…}) anywhere in the texts given. */
function checkTokens(texts: [string, string][], what: string) {
  for (const [where, text] of texts)
    if (/\{(env|file):/.test(text))
      throw new Refusal(`${what} contains a config substitution token ({env:…} or {file:…}) in ${where}`)
}

const isReference = (value: string) => /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)

/**
 * One MCP server as a marketplace entry: environment and header names only. Returns the literal
 * values it dropped, so export can check none of them turns up anywhere else in the bundle.
 */
export function mcpEntry(name: string, config: ConfigMCPV1.Info): { entry: Marketplace.McpEntry; secrets: string[] } {
  checkName(name, "MCP server")
  if (config.type === "local") {
    const environment = Object.keys(config.environment ?? {})
    return {
      entry: Schema.decodeUnknownSync(Marketplace.McpEntry)({
        name,
        type: "local",
        command: [...config.command],
        ...(config.cwd ? { cwd: config.cwd } : {}),
        ...(environment.length ? { environment } : {}),
      }),
      secrets: Object.values(config.environment ?? {}).filter((value) => !isReference(value)),
    }
  }
  const url = new URL(config.url)
  if (url.username || url.password)
    throw new Refusal(`MCP server "${name}" has credentials in its URL. Move them to a header, then export.`)
  for (const key of url.searchParams.keys())
    if (SECRET_NAME.test(key))
      throw new Refusal(`MCP server "${name}" has "${key}" in its URL query. Move it to a header, then export.`)
  if (config.oauth && config.oauth.clientSecret)
    throw new Refusal(`MCP server "${name}" has an OAuth client secret in its config, which can't be exported.`)
  const headers = Object.keys(config.headers ?? {})
  return {
    entry: Schema.decodeUnknownSync(Marketplace.McpEntry)({
      name,
      type: "remote",
      url: config.url,
      ...(headers.length ? { headers } : {}),
    }),
    secrets: Object.values(config.headers ?? {}).filter((value) => !isReference(value)),
  }
}

/** Every string inside a value, with a path to report where it was found. */
function* strings(value: unknown, at: string): Generator<[string, string]> {
  if (typeof value === "string") yield [at, value]
  else if (Array.isArray(value)) for (const [index, item] of value.entries()) yield* strings(item, `${at}[${index}]`)
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      yield [`${at}.${key} (key)`, key]
      yield* strings(item, `${at}.${key}`)
    }
}

export async function write(input: {
  name: string
  agent: ConfigAgentV1.Info
  mcp: Record<string, ConfigMCPV1.Info>
  skills: Record<string, Record<string, Uint8Array>>
  lunos?: string
  now?: Date
}): Promise<Uint8Array> {
  const name = checkName(input.name)
  const agent = agentDoc(input.agent)
  const secrets: string[] = []
  const mcp = Object.entries(input.mcp).map(([server, config]) => {
    const { entry, secrets: dropped } = mcpEntry(server, config)
    secrets.push(...dropped)
    return entry
  })

  // A secret dropped from env or headers must not survive somewhere else (a command argument,
  // a URL, the prompt, a skill file).
  const texts: [string, string][] = [...strings(agent, "agent"), ...strings(mcp, "mcp")]
  for (const [skill, files] of Object.entries(input.skills)) {
    checkName(skill, "skill")
    for (const [file, bytes] of Object.entries(files))
      texts.push([`skills/${skill}/${file}`, new TextDecoder().decode(bytes)])
  }
  for (const secret of secrets.filter((value) => value.length >= 6))
    for (const [where, text] of texts)
      if (text.includes(secret))
        throw new Refusal(
          `A secret from an MCP server's environment or headers also appears in ${where}. Remove it, then export.`,
        )

  // Import refuses these, so export does too, naming the field, instead of making a bundle that
  // only fails on the other machine.
  checkTokens(texts, "The agent can't be exported: it")

  const files: Record<string, Uint8Array> = { "agent.json": encode(agent) }
  for (const [skill, entries] of Object.entries(input.skills))
    for (const [file, bytes] of Object.entries(entries)) files[`skills/${skill}/${safePath(file)}`] = bytes

  const manifest: Manifest = {
    format: FORMAT,
    name,
    ...(input.lunos ? { lunos: input.lunos } : {}),
    exported_at: (input.now ?? new Date()).toISOString(),
    mcp,
    skills: Object.keys(input.skills).sort(),
    files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, sha256(bytes)])),
  }

  const zip = new ZipWriter(new BlobWriter("application/zip"))
  await zip.add("manifest.json", new Uint8ArrayReader(encode(manifest)))
  for (const [file, bytes] of Object.entries(files)) await zip.add(file, new Uint8ArrayReader(bytes))
  return new Uint8Array(await (await zip.close()).arrayBuffer())
}

// ---------------------------------------------------------------------------------------------
// Import

/** A path inside the bundle that stays inside it: relative, forward slashes, no `..`, no drive. */
export function safePath(file: string) {
  const parts = file.split("/")
  if (
    file === "" ||
    file.includes("\\") ||
    file.includes("\0") ||
    file.startsWith("/") ||
    /^[A-Za-z]:/.test(file) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    throw new Refusal(`The bundle contains an unsafe path: "${file}"`)
  return file
}

// zip.js offloads (de)compression to web workers when it thinks it can. A CLI gains nothing from
// that, and under a DOM-like global (the test preload) the workers can leave a read hanging.
configure({ useWebWorkers: false })

/**
 * Collects an entry's bytes and stops past `cap`. The sizes a zip declares are its author's word
 * (zip.js inflates past them), so the limits are enforced on what actually comes out.
 */
class Capped extends Writer<Uint8Array> {
  private chunks: Uint8Array[] = []
  private size = 0
  constructor(
    private readonly file: string,
    private readonly cap: number,
    private readonly spend: (bytes: number) => void,
  ) {
    super()
  }
  /** Why it stopped. zip.js reports a writer's error as a closed stream, so read() rethrows this. */
  refusal: Refusal | undefined
  override async writeUint8Array(array: Uint8Array) {
    try {
      this.size += array.byteLength
      this.spend(array.byteLength)
      if (this.size > this.cap) throw new Refusal(`"${this.file}" in the bundle is too large`)
    } catch (error) {
      if (error instanceof Refusal) this.refusal = error
      throw error
    }
    this.chunks.push(array)
  }
  override async getData() {
    const out = new Uint8Array(this.size)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }
}

const S_IFMT = 0o170000
const S_IFLNK = 0o120000

export async function read(bytes: Uint8Array): Promise<Bundle> {
  if (bytes.byteLength > LIMITS.bytes) throw new Refusal(`The bundle is larger than ${LIMITS.bytes} bytes`)
  const reader = new ZipReader(new Uint8ArrayReader(bytes))
  const entries = await reader.getEntries().catch(() => {
    throw new Refusal("This isn't an agent bundle (not a zip file)")
  })
  try {
    const files = entries.filter((entry) => !entry.directory)
    if (files.length > LIMITS.files) throw new Refusal(`The bundle has more than ${LIMITS.files} files`)
    let total = 0
    const content: Record<string, Uint8Array> = {}
    for (const entry of files) {
      const file = safePath(entry.filename)
      if (((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK)
        throw new Refusal(`The bundle contains a symbolic link: "${file}"`)
      if (entry.uncompressedSize > LIMITS.file) throw new Refusal(`"${file}" in the bundle is too large`)
      if (content[file]) throw new Refusal(`The bundle contains "${file}" twice`)
      const writer = new Capped(file, LIMITS.file, (bytes) => {
        total += bytes
        if (total > LIMITS.bytes) throw new Refusal(`The bundle unpacks to more than ${LIMITS.bytes} bytes`)
      })
      content[file] = await entry.getData!(writer).catch((error) => {
        throw writer.refusal ?? error
      })
    }

    const manifest = parseManifest(content["manifest.json"])
    const listed = new Set(Object.keys(manifest.files))
    for (const file of Object.keys(content)) {
      if (file === "manifest.json") continue
      if (!listed.has(file)) throw new Refusal(`The bundle contains "${file}", which its manifest doesn't list`)
      if (sha256(content[file]) !== manifest.files[file])
        throw new Refusal(`"${file}" doesn't match its checksum: the bundle is damaged`)
    }
    for (const file of listed) if (!content[file]) throw new Refusal(`The bundle is missing "${file}"`)

    const agent = parseAgent(content["agent.json"])
    const skills: Bundle["skills"] = {}
    for (const skill of manifest.skills) skills[checkName(skill, "skill")] = {}
    for (const [file, data] of Object.entries(content)) {
      if (file === "manifest.json" || file === "agent.json") continue
      const match = file.match(/^skills\/([^/]+)\/(.+)$/)
      if (!match || !skills[match[1]]) throw new Refusal(`The bundle contains "${file}" outside an agent or skill`)
      skills[match[1]][match[2]] = data
    }
    for (const [skill, entries] of Object.entries(skills))
      if (!entries["SKILL.md"]) throw new Refusal(`Skill "${skill}" in the bundle has no SKILL.md`)

    // Config text goes through {env:…}/{file:…} substitution when it loads, and so does a skill's
    // text when it is shown to the model: nothing in a bundle may carry a token.
    const texts = [...strings(agent, "agent"), ...strings(manifest.mcp, "mcp")]
    for (const [skill, entries] of Object.entries(skills))
      for (const [file, data] of Object.entries(entries))
        texts.push([`skills/${skill}/${file}`, new TextDecoder().decode(data)])
    checkTokens(texts, "The bundle")
    for (const entry of manifest.mcp) if (entry.type === "remote") requireHttpUrl(entry.name, entry.url)
    return { manifest, agent, skills }
  } finally {
    await reader.close()
  }
}

function json(data: Uint8Array | undefined, file: string): unknown {
  if (!data) throw new Refusal(`This isn't an agent bundle (no ${file})`)
  try {
    return JSON.parse(new TextDecoder().decode(data))
  } catch {
    throw new Refusal(`${file} in the bundle isn't valid JSON`)
  }
}

function parseManifest(data: Uint8Array | undefined): Manifest {
  const raw = json(data, "manifest.json") as Record<string, unknown>
  if (!raw || typeof raw !== "object") throw new Refusal("manifest.json in the bundle isn't an object")
  if (raw.format !== FORMAT)
    throw new Refusal(`This bundle's format is "${String(raw.format)}"; this version of Lunos reads "${FORMAT}"`)
  if ("hooks" in raw) throw new Refusal("The bundle declares hooks; importing hooks isn't supported")
  const allowed = new Set(["format", "name", "lunos", "exported_at", "mcp", "skills", "files"])
  for (const key of Object.keys(raw))
    if (!allowed.has(key)) throw new Refusal(`manifest.json has a field this version of Lunos doesn't know: "${key}"`)
  if (typeof raw.name !== "string") throw new Refusal("manifest.json has no agent name")
  checkName(raw.name)
  const mcp = Array.isArray(raw.mcp) ? raw.mcp : []
  const decoded = mcp.map((entry) => {
    const result = Schema.decodeUnknownExit(Marketplace.McpEntry)(entry)
    if (Exit.isFailure(result)) throw new Refusal("manifest.json has an MCP server entry Lunos can't read")
    checkName(result.value.name, "MCP server")
    return result.value
  })
  const skills = Array.isArray(raw.skills) ? raw.skills : []
  if (!skills.every((skill): skill is string => typeof skill === "string"))
    throw new Refusal("manifest.json lists a skill that isn't a name")
  const files = raw.files
  if (
    !files ||
    typeof files !== "object" ||
    !Object.values(files).every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
  )
    throw new Refusal("manifest.json has no valid file checksums")
  for (const file of Object.keys(files)) safePath(file)
  return {
    format: FORMAT,
    name: raw.name,
    ...(typeof raw.lunos === "string" ? { lunos: raw.lunos } : {}),
    ...(typeof raw.exported_at === "string" ? { exported_at: raw.exported_at } : {}),
    mcp: decoded,
    skills,
    files: files as Record<string, string>,
  }
}

/** The bundle's agent, validated as agent config. Fields a bundle doesn't carry are refused. */
export function parseAgent(data: Uint8Array | undefined): Agent {
  const raw = json(data, "agent.json")
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Refusal("agent.json in the bundle isn't an object")
  for (const key of Object.keys(raw))
    if (!(AGENT_FIELDS as readonly string[]).includes(key))
      throw new Refusal(`agent.json has a field a bundle can't carry: "${key}"`)
  const decoded = Schema.decodeUnknownExit(ConfigAgentV1.Info)(raw)
  if (Exit.isFailure(decoded)) throw new Refusal("agent.json in the bundle isn't a valid agent")
  checkOptions((raw as Agent).options, "sets a model endpoint or a credential, which an imported agent can't")
  return raw as Agent
}

// ---------------------------------------------------------------------------------------------
// Trust

/** Permissions an imported agent doesn't get to `allow` until the user says so (`--trust`). */
export const UNTRUSTED = ["bash", "edit", "task"] as const

/**
 * The agent's permissions, made safe to import: nothing the bundle allows for bash, edit or task
 * survives as `allow`. Rules match last-wins and both the permission and the pattern can be
 * wildcards, so rewriting the visible keys isn't enough (`"b*": "allow"`, or a `"*"` after a
 * narrower rule). Instead, each of the three that any rule allows gets a final rule of its own:
 * `ask` for everything, except the patterns the bundle denies, which stay denied.
 */
export function untrusted(permission: unknown): { permission: PermissionRecord; changed: string[] } {
  const source: PermissionRecord =
    typeof permission === "string"
      ? { "*": permission }
      : permission && typeof permission === "object"
        ? { ...(permission as PermissionRecord) }
        : {}
  const next: PermissionRecord = { ...source }
  const changed: string[] = []
  for (const tool of UNTRUSTED) {
    const rules = Object.entries(source).filter(([key]) => Wildcard.match(tool, key))
    const actions = (value: unknown) =>
      typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value) : []
    if (!rules.some(([, value]) => actions(value).includes("allow"))) continue
    const denied = rules.flatMap(([, value]) =>
      value === "deny"
        ? ["*"]
        : value && typeof value === "object"
          ? Object.entries(value as Record<string, unknown>)
              .filter(([, action]) => action === "deny")
              .map(([pattern]) => pattern)
          : [],
    )
    delete next[tool]
    next[tool] = denied.includes("*")
      ? "deny"
      : { "*": "ask", ...Object.fromEntries(denied.map((pattern) => [pattern, "deny"])) }
    changed.push(tool)
  }
  return { permission: next, changed }
}

type PermissionRecord = Record<string, unknown>

/** Paths a bundle's skill files land at, under `dir/<skill>/`. */
export function skillTargets(dir: string, skill: string, files: Record<string, Uint8Array>) {
  const base = path.join(dir, checkName(skill, "skill"))
  return Object.keys(files).map((file) => {
    const target = path.join(base, ...safePath(file).split("/"))
    if (!target.startsWith(base + path.sep)) throw new Refusal(`Skill file "${file}" would land outside its folder`)
    return target
  })
}
