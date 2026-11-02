export * as ResourceSecrets from "./secrets"

import path from "node:path"
import { Audit } from "@opencode-ai/core/audit"
import { CloudSyncRedact } from "@/cloud/sync-redact"

/**
 * What never enters a resource's index or the agent's context (XCOD-300), in two layers, as for
 * session sync (cloud/sync-redact.ts):
 *
 * 1. Path rule: session sync's never-upload files (`.env*`, `auth.json`, `*.pem`, `*.key`,
 *    `id_rsa*`), plus the other usual key and credential files below, and folders that hold them.
 *    A matching file is skipped, unread.
 * 2. Scanner: whatever is read passes the audit writer's credential patterns (`Audit.redact`), so a
 *    key pasted into a document is masked before it is indexed or sent.
 */

export const NEVER = [
  ...CloudSyncRedact.NEVER,
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "*.p12",
  "*.pfx",
  "*.jks",
  "*.keystore",
  "*.kdbx",
  "*.gpg",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "*.tfstate",
] as const

/** Folders never walked into: credentials, VCS internals and dependencies. */
export const SKIP_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker", "node_modules"])

const globs = NEVER.map((glob) => new Bun.Glob(glob.toLowerCase()))

/** Whether a file must be skipped by name. Case-insensitive, like session sync. */
export function secretPath(file: string) {
  const parts = file.replaceAll("\\", "/").split("/")
  if (parts.slice(0, -1).some((part) => SKIP_DIRS.has(part))) return true
  const name = path.posix.basename(parts.join("/")).toLowerCase()
  return globs.some((glob) => glob.match(name))
}

/** The text with anything key-shaped masked, and whether something was. */
export function redact(text: string) {
  const out = Audit.redact(text)
  return { text: out, redacted: out !== text }
}
