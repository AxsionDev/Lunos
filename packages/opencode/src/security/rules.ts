export * as SecurityRules from "./rules"

import path from "path"
import { Audit } from "@opencode-ai/core/audit"

export const SEVERITIES = ["critical", "high", "medium", "low"] as const
export type Severity = (typeof SEVERITIES)[number]

export type Category =
  | "secrets"
  | "injection"
  | "auth"
  | "deserialization"
  | "ssrf"
  | "xss"
  | "csrf"
  | "crypto"
  | "config"
  | "dependency"

export type Rule = {
  id: string
  title: string
  category: Category
  severity: Severity
  cwe: string
  why: string
  fix: string
}

export type Finding = Rule & {
  file: string
  line: number
  /** The offending line, trimmed and shortened; secrets are masked. */
  snippet: string
  /** Extra detail for this occurrence (a dependency's advisory ids and versions). */
  detail?: string
}

type LineRule = Rule & {
  pattern: RegExp
  /** Only files with these extensions; every scanned file when absent. */
  only?: readonly string[]
  /** A second pattern the same line must also match. */
  and?: RegExp
}

const JS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"]
const PY = [".py"]
const CS = [".cs", ".cshtml", ".razor"]
const CODE = [...JS, ...PY, ...CS, ".java", ".kt", ".go", ".rb", ".php", ".rs", ".scala", ".swift"]
const TEMPLATES = [".html", ".htm", ".jinja", ".j2", ".hbs", ".ejs", ".njk", ".cshtml", ".razor", ".vue"]
const CONFIG = [".json", ".yaml", ".yml", ".toml", ".ini", ".env", ".properties", ".conf", ".config", ".xml"]

/** Files with no source code worth pattern-matching (lockfiles are checked by the dependency step). */
const SKIP = [
  // Lockfiles: their integrity hashes look like secrets. Their versions are checked by deps.ts.
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|packages\.lock\.json|gradle\.lockfile)$/,
  /\.min\.js$/,
  /\.sarif(\.json)?$/,
  /\.(png|jpe?g|gif|svg|ico|pdf|woff2?|ttf|zip|gz)$/i,
]

const USER_INPUT =
  /\b(req|request)\s*\.\s*(params|query|body|args|form|values|GET|POST|files|headers)\b|\bRequest\s*\.\s*(Query|Form)\b|\$_(GET|POST|REQUEST)\b/

const SQL = String.raw`\b(select\s[\s\S]*?\sfrom|insert\s+into|update\s+\w+\s+set|delete\s+from)\b`

export const LINE_RULES: readonly LineRule[] = [
  // Secrets: shapes the audit writer already masks, plus private keys and AWS secret keys.
  {
    id: "secrets/aws-access-key",
    title: "AWS access key id",
    category: "secrets",
    severity: "critical",
    cwe: "CWE-798",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    why: "An AWS access key in source is readable by everyone with the repository, its forks and its history, and grants whatever its IAM user can do.",
    fix: "Remove it, rotate the key in IAM now (it stays in git history), and load credentials from the environment, an instance role or a secret manager.",
  },
  {
    id: "secrets/aws-secret-key",
    title: "AWS secret access key",
    category: "secrets",
    severity: "critical",
    cwe: "CWE-798",
    pattern: /aws.{0,24}(secret|private).{0,24}["'=:\s]["']?[A-Za-z0-9/+]{40}\b/i,
    why: "With the matching key id this signs any AWS request as that user.",
    fix: "Remove it, rotate the key pair, and read it from the environment or a secret manager.",
  },
  {
    id: "secrets/private-key",
    title: "Private key",
    category: "secrets",
    severity: "critical",
    cwe: "CWE-321",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY( BLOCK)?-----/,
    why: "A committed private key lets anyone impersonate the server, user or signer it belongs to.",
    fix: "Remove the key, revoke and reissue it, and mount it at runtime from a secret store.",
  },
  {
    id: "secrets/token",
    title: "API token",
    category: "secrets",
    severity: "high",
    cwe: "CWE-798",
    pattern: new RegExp(Audit.TOKEN_SHAPED.source),
    why: "A provider token (OpenAI, GitHub, Slack, AWS) in source works for anyone who reads it.",
    fix: "Remove it, revoke it with the provider, and read it from the environment or a secret manager.",
  },
  // Injection.
  {
    id: "injection/sql",
    title: "SQL built from interpolated or concatenated values",
    category: "injection",
    severity: "high",
    cwe: "CWE-89",
    pattern: new RegExp(
      [
        String.raw`\x60[^\x60]*${SQL}[^\x60]*\$\{`,
        String.raw`"[^"]*${SQL}[^"]*"\s*\+`,
        String.raw`'[^']*${SQL}[^']*'\s*\+`,
        String.raw`\bf["'][^"']*${SQL}[^"']*\{`,
        String.raw`"[^"]*${SQL}[^"]*"\s*(%\s*[\w(]|\.format\()`,
        String.raw`'[^']*${SQL}[^']*'\s*(%\s*[\w(]|\.format\()`,
        String.raw`\$@?"[^"]*${SQL}[^"]*\{`,
      ].join("|"),
      "i",
    ),
    why: "Values pasted into SQL text let a caller change the query: read other rows, bypass a login or drop tables.",
    fix: "Use parameters or placeholders (`?`, `$1`, `@name`) or the ORM's query builder, and pass the values separately.",
  },
  {
    id: "injection/command",
    title: "Shell command built from variables",
    category: "injection",
    severity: "high",
    cwe: "CWE-78",
    pattern:
      /\b(?:exec|execSync|spawnSync|spawn)\s*\(\s*(?:`[^`]*\$\{|[^,)]*\+\s*\w)|\bos\.(?:system|popen)\s*\(\s*(?!["'][^"']*["']\s*\))|\bsubprocess\.\w+\([^)]*shell\s*=\s*True|Runtime\.getRuntime\(\)\.exec\([^)]*\+|Process\.Start\([^)]*\+/,
    only: CODE,
    why: "A shell runs whatever the variable holds: `; rm -rf ~` or `$(curl …)` in it runs too.",
    fix: "Call the program directly with an argument array (`execFile`, `spawn(cmd, args)`, `subprocess.run([...])`) and validate the values.",
  },
  {
    id: "injection/code",
    title: "eval of a non-literal",
    category: "injection",
    severity: "high",
    cwe: "CWE-95",
    pattern: /\beval\s*\(\s*(?!["'`][^"'`]*["'`]\s*\))[^)]|\bnew\s+Function\s*\(/,
    only: [...JS, ...PY, ".php", ".rb"],
    why: "Evaluating text as code runs whatever an attacker can get into it.",
    fix: "Parse the data instead (`JSON.parse`, `ast.literal_eval`) or map inputs to known functions.",
  },
  {
    id: "injection/path-traversal",
    title: "File path from request input",
    category: "injection",
    severity: "high",
    cwe: "CWE-22",
    pattern:
      /\b(?:readFile\w*|writeFile\w*|createReadStream|createWriteStream|sendFile|download|unlink\w*|path\.(?:join|resolve)|open|File\.(?:ReadAll\w*|Open\w*|Delete)|Path\.Combine)\s*\(/,
    and: USER_INPUT,
    only: CODE,
    why: "`../` in the value walks out of the intended directory to any file the process can read or write.",
    fix: "Resolve the path, then check it is still inside the allowed directory (or map the input to an id), and reject anything else.",
  },
  {
    id: "injection/template",
    title: "Template rendered from a non-literal string",
    category: "injection",
    severity: "high",
    cwe: "CWE-1336",
    pattern:
      /\brender_template_string\s*\(\s*(?!["'])|\bjinja2\.Template\s*\(\s*(?!["'])|\bEnvironment\([^)]*\)\.from_string\s*\(\s*(?!["'])|\b(?:Handlebars|ejs|pug|nunjucks)\.(?:compile|render)\s*\(\s*(?!["'`])/,
    only: CODE,
    why: "Template syntax in the input runs on the server (server-side template injection), often up to code execution.",
    fix: "Render a fixed template and pass the input as a variable to it.",
  },
  // Authentication and authorisation.
  {
    id: "auth/jwt-unverified",
    title: "JWT accepted without verifying the signature",
    category: "auth",
    severity: "high",
    cwe: "CWE-347",
    pattern:
      /algorithms?\s*[:=]\s*\[?\s*["']none["']|verify_signature["']?\s*:\s*False|jwt\.decode\([^)]*verify\s*=\s*False|ValidateIssuerSigningKey\s*=\s*false|RequireSignedTokens\s*=\s*false/i,
    why: "A token whose signature isn't checked can be forged by anyone, so every claim in it (user, role) is attacker-chosen.",
    fix: 'Verify with the expected key and an explicit algorithm list (`algorithms: ["RS256"]`); never allow `none`.',
  },
  {
    id: "auth/tls-unverified",
    title: "TLS certificate checks turned off",
    category: "auth",
    severity: "high",
    cwe: "CWE-295",
    pattern:
      /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true|ServerCertificateCustomValidationCallback\s*=.*=>\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)/,
    why: "Without certificate checks anyone on the network path can impersonate the server and read or change the traffic.",
    fix: "Leave verification on; trust a private CA by adding it to the trust store (`ca:`, `REQUESTS_CA_BUNDLE`) instead.",
  },
  {
    id: "auth/anonymous",
    title: "Endpoint opened to anonymous users",
    category: "auth",
    severity: "medium",
    cwe: "CWE-306",
    pattern: /\[AllowAnonymous\]|\.permitAll\(\)|@PermitAll\b|AllowAny\b/,
    why: "Anonymous access bypasses the application's authentication for this endpoint; that is right only for genuinely public endpoints.",
    fix: "Confirm the endpoint must be public; otherwise remove the attribute and require an authenticated, authorised caller.",
  },
  {
    id: "auth/hardcoded-credential",
    title: "Hard-coded password or secret",
    category: "secrets",
    severity: "high",
    cwe: "CWE-798",
    // Checked by entropy() below rather than by this pattern alone.
    pattern:
      /\b[\w.-]*(?:passw(?:or)?d|pwd|secret|api[_-]?key|access[_-]?key|token|client[_-]?secret)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i,
    why: "A credential in source is shared with everyone who can read the repository and can't be rotated without a release.",
    fix: "Read it from the environment or a secret manager, and rotate the value that was committed.",
  },
  // Insecure deserialisation.
  {
    id: "deserialization/unsafe",
    title: "Deserialising untrusted data with a code-executing format",
    category: "deserialization",
    severity: "high",
    cwe: "CWE-502",
    pattern:
      /\bpickle\.loads?\s*\(|\bcPickle\.loads?\s*\(|\byaml\.load\s*\((?![^)]*Loader\s*=\s*(?:yaml\.)?(?:Safe|CSafe)Loader)|\bmarshal\.loads\s*\(|\bBinaryFormatter\b|\bNetDataContractSerializer\b|TypeNameHandling\s*=\s*TypeNameHandling\.(?:All|Auto|Objects)|\bObjectInputStream\s*\(|\bunserialize\s*\(|\bMarshal\.load\s*\(|node-serialize|\bserialize\.unserialize\s*\(/,
    only: CODE,
    why: "These formats can construct arbitrary objects while loading, so a crafted payload runs code in the process.",
    fix: "Use a data-only format (JSON, `yaml.safe_load`, `System.Text.Json`) and validate it against a schema.",
  },
  // SSRF.
  {
    id: "ssrf/request-url",
    title: "Outbound request to a URL from request input",
    category: "ssrf",
    severity: "high",
    cwe: "CWE-918",
    pattern:
      /\b(?:fetch|axios(?:\.\w+)?|got(?:\.\w+)?|needle|superagent\.\w+|https?\.(?:get|request)|requests\.(?:get|post|put|delete|request)|urllib\.request\.urlopen|urlopen|GetAsync|GetStringAsync|PostAsync|SendAsync|WebClient\.\w+|http\.Get|RestTemplate\.\w+)\s*\(/,
    and: USER_INPUT,
    only: CODE,
    why: "The server fetches whatever URL the caller names, including internal services and cloud metadata (169.254.169.254).",
    fix: "Allow-list the hosts (or map the input to known endpoints), resolve and reject private addresses, and don't follow redirects blindly.",
  },
  // XSS and CSRF.
  {
    id: "xss/raw-html",
    title: "Unescaped HTML from a variable",
    category: "xss",
    severity: "medium",
    cwe: "CWE-79",
    pattern:
      /\.(?:innerHTML|outerHTML)\s*\+?=\s*(?!["'`][^"'`$]*["'`]\s*;?\s*$)|dangerouslySetInnerHTML|document\.write\s*\(|\bv-html\s*=|\|\s*safe\b|\bmark_safe\s*\(|@?Html\.Raw\s*\(|\{\{\{[^}]+\}\}\}|bypassSecurityTrust\w*\s*\(/,
    only: [...CODE, ...TEMPLATES],
    why: "Markup in the value runs as script in other users' browsers (stored or reflected XSS).",
    fix: "Render as text (`textContent`, the framework's normal binding) or sanitise with an allow-list sanitiser such as DOMPurify.",
  },
  {
    id: "csrf/disabled",
    title: "CSRF protection turned off",
    category: "csrf",
    severity: "high",
    cwe: "CWE-352",
    pattern:
      /@csrf_exempt|csrf\(\)\s*\.\s*disable\(\)|\.csrf\(\s*\w+\s*->\s*\w+\.disable\(\)\)|WTF_CSRF_ENABLED\s*=\s*False|\[IgnoreAntiforgeryToken\]|csrf\s*:\s*false/,
    why: "Without an anti-forgery token, another site can make a signed-in user's browser submit this request.",
    fix: "Keep CSRF protection on and send the token with state-changing requests; exempt only endpoints that don't use cookie authentication.",
  },
  // Weak and hard-coded crypto.
  {
    id: "crypto/weak-cipher",
    title: "Broken cipher or mode",
    category: "crypto",
    severity: "high",
    cwe: "CWE-327",
    pattern:
      /["'](?:des|des-ede3?(?:-cbc)?|rc4|rc2|bf|blowfish|aes-\d+-ecb)["']|\b(?:DES|TripleDES|RC2)\.Create\(|\bDESCryptoServiceProvider\b|CipherMode\.ECB|\bMODE_ECB\b|AES\/ECB|\bARC4\.new\(|\bDES\.new\(/i,
    why: "DES, 3DES, RC4 and ECB mode no longer protect confidentiality: the data can be recovered or patterns in it seen.",
    fix: "Use AES-GCM or ChaCha20-Poly1305 with a random nonce, via a vetted library.",
  },
  {
    id: "crypto/weak-hash",
    title: "MD5 or SHA-1 used",
    category: "crypto",
    severity: "medium",
    cwe: "CWE-328",
    pattern:
      /createHash\(\s*["'](?:md5|sha1)["']|\bhashlib\.(?:md5|sha1)\s*\(|\b(?:MD5|SHA1)\.Create\(|\b(?:MD5|SHA1)CryptoServiceProvider\b|MessageDigest\.getInstance\(\s*["'](?:MD5|SHA-?1)["']|\bmd5\s*\(/,
    only: CODE,
    why: "MD5 and SHA-1 collide in practice and are too fast for passwords: unsafe for signatures, integrity or password storage.",
    fix: "Use SHA-256 or better for integrity, and bcrypt, scrypt or Argon2 for passwords. Ignore with a reason if it is a non-security checksum.",
  },
  {
    id: "crypto/insecure-random",
    title: "Non-cryptographic random number for a security value",
    category: "crypto",
    severity: "medium",
    cwe: "CWE-330",
    pattern: /Math\.random\(\)|\brandom\.(?:random|randint|choice)\(|\bnew Random\(/,
    and: /token|secret|passw|nonce|salt|otp|session|key|reset|csrf/i,
    only: CODE,
    why: "These generators are predictable, so a token or password made from them can be guessed.",
    fix: "Use the platform's CSPRNG: `crypto.randomBytes`/`crypto.getRandomValues`, `secrets`, `RandomNumberGenerator`.",
  },
  {
    id: "crypto/hardcoded-key",
    title: "Hard-coded encryption or signing key",
    category: "crypto",
    severity: "high",
    cwe: "CWE-321",
    pattern:
      /\b(?:createCipheriv|createDecipheriv|createHmac|AES\.new|HMAC\.new|jwt\.sign|jwt\.encode|SymmetricSecurityKey)\s*\([^)]*["'][^"']{8,}["']|Key\s*=\s*Encoding\.\w+\.GetBytes\(\s*"[^"]{8,}"\)/,
    only: CODE,
    why: "A key in source is known to anyone who can read it, so they can decrypt the data or forge signatures.",
    fix: "Load keys from a key management service or secret store, and rotate the committed one.",
  },
  // Unsafe configuration.
  {
    id: "config/cors-any",
    title: "CORS allows any origin",
    category: "config",
    severity: "medium",
    cwe: "CWE-942",
    pattern:
      /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*["']|\borigin\s*:\s*(?:["']\*["']|true)\b|\.AllowAnyOrigin\(\)|CORS_(?:ORIGIN_)?ALLOW_ALL(?:_ORIGINS)?\s*=\s*True|allow_origins\s*=\s*\[\s*["']\*["']\s*\]|\bcors\(\s*\)/,
    why: "Any website can call the API from a visitor's browser and read the responses; with credentials it acts as the user.",
    fix: "List the origins that need access; never combine a wildcard or reflected origin with credentials.",
  },
  {
    id: "config/debug",
    title: "Debug mode enabled",
    category: "config",
    severity: "medium",
    cwe: "CWE-489",
    pattern:
      /^\s*DEBUG\s*=\s*True\b|\.run\([^)]*debug\s*=\s*True|app\.debug\s*=\s*True|UseDeveloperExceptionPage\(\)|["']?debug["']?\s*:\s*true\b|^\s*ASPNETCORE_ENVIRONMENT\s*=\s*Development/,
    only: [...CODE, ...CONFIG],
    why: "Debug mode shows stack traces, settings and sometimes an interactive console (Flask's debugger runs code) to whoever triggers an error.",
    fix: "Turn it on only from a development-only environment variable, never in committed production config.",
  },
]

export function skipped(file: string) {
  return SKIP.some((pattern) => pattern.test(file))
}

/** Every line rule that applies to a file's added lines. */
export function scanLines(file: string, lines: readonly { line: number; text: string }[]): Finding[] {
  if (skipped(file)) return []
  const ext = path.basename(file).toLowerCase().startsWith(".env") ? ".env" : path.extname(file).toLowerCase()
  const rules = LINE_RULES.filter((rule) => !rule.only || rule.only.includes(ext))
  return lines.flatMap((entry) => {
    if (entry.text.length > 2000) return []
    const hits = rules.filter((rule) => {
      if (!rule.pattern.test(entry.text)) return false
      if (rule.and && !rule.and.test(entry.text)) return false
      if (rule.id === "auth/hardcoded-credential") return hardcoded(entry.text)
      return true
    })
    // One secret on a line is one finding: the most specific rule wins.
    const secret = hits.find((rule) => rule.category === "secrets")
    const kept = secret ? [secret, ...hits.filter((rule) => rule.category !== "secrets")] : hits
    const entropic = !secret ? highEntropy(entry.text) : undefined
    return [
      ...kept.map((rule) => finding(rule, file, entry)),
      ...(entropic ? [finding(ENTROPY_RULE, file, entry)] : []),
    ]
  })
}

/**
 * Missing anti-forgery validation on an ASP.NET MVC state-changing action (CWE-352). The attribute
 * usually sits on another line from `[HttpPost]` (or on the class, or globally), so this looks at the
 * whole file: each added `[HttpPost|Put|Patch|Delete]` is checked against the attribute block it
 * belongs to and the controller's own attributes.
 */
export function scanFile(file: string, added: readonly { line: number }[], content: string | undefined): Finding[] {
  if (!content || path.extname(file).toLowerCase() !== ".cs") return []
  // API controllers authenticate with tokens, not cookies; a global or class-level attribute covers every action.
  if (/\[ApiController\]|AutoValidateAntiforgeryToken/.test(content)) return []
  if (/\[ValidateAntiForgeryToken\][^{]*\bclass\b/.test(content)) return []
  const lines = content.split("\n")
  const touched = new Set(added.map((entry) => entry.line))
  return lines.flatMap((text, index) => {
    if (!/\[Http(?:Post|Put|Patch|Delete)\b/.test(text)) return []
    // The attribute block: the contiguous `[...]` lines around this one, up to the method.
    let start = index
    while (start > 0 && /^\s*\[.*\]\s*(\/\/.*)?$/.test(lines[start - 1]!)) start--
    let end = index
    while (end + 1 < lines.length && /^\s*\[.*\]\s*(\/\/.*)?$/.test(lines[end + 1]!)) end++
    const block = lines.slice(start, end + 2)
    const method = end + 2
    const changed = [...Array(method - start).keys()].some((offset) => touched.has(start + offset + 1))
    if (!changed) return []
    if (block.some((line) => /ValidateAntiForgeryToken|IgnoreAntiforgeryToken/.test(line))) return []
    return [finding(CSRF_TOKEN_RULE, file, { line: index + 1, text })]
  })
}

export const CSRF_TOKEN_RULE: Rule = {
  id: "csrf/missing-antiforgery",
  title: "State-changing action without anti-forgery validation",
  category: "csrf",
  severity: "high",
  cwe: "CWE-352",
  why: "A POST/PUT/PATCH/DELETE action using cookie authentication can be triggered from another site by a signed-in user's browser.",
  fix: "Add `[ValidateAntiForgeryToken]` to the action (or `AutoValidateAntiforgeryTokenAttribute` globally) and render `@Html.AntiForgeryToken()` in the form.",
}

export const ENTROPY_RULE: Rule = {
  id: "secrets/high-entropy",
  title: "High-entropy string that looks like a secret",
  category: "secrets",
  severity: "medium",
  cwe: "CWE-798",
  why: "A long random-looking literal is usually a key or token; in source it is readable by everyone with the repository.",
  fix: "If it is a credential, move it to the environment or a secret manager and rotate it; otherwise suppress with a reason.",
}

export function finding(rule: Rule, file: string, entry: { line: number; text: string }, detail?: string): Finding {
  const snippet = Audit.redact(entry.text.trim()).replace(/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, "$1[redacted]")
  return {
    id: rule.id,
    title: rule.title,
    category: rule.category,
    severity: rule.severity,
    cwe: rule.cwe,
    why: rule.why,
    fix: rule.fix,
    file,
    line: entry.line,
    snippet: snippet.length > 160 ? snippet.slice(0, 157) + "..." : snippet,
    ...(detail ? { detail } : {}),
  }
}

/** Shannon entropy in bits per character. */
export function entropy(value: string) {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  return [...counts.values()].reduce((sum, count) => {
    const p = count / value.length
    return sum - p * Math.log2(p)
  }, 0)
}

const PLACEHOLDER =
  /^(?:x+|\*+|changeme|change_me|password|secret|example|dummy|test|your[_-].*|<.*>|\$\{.*\}|\{\{.*\}\}|process\.env.*|%.*%)$/i

/** A credential-named assignment to a literal that isn't a placeholder or an env lookup. */
function hardcoded(text: string) {
  const value = /["']([^"'\s]{12,})["']\s*[,;)]?\s*(?:\/\/.*|#.*)?$/.exec(text)?.[1]
  if (!value || PLACEHOLDER.test(value)) return false
  return entropy(value) >= 3.5
}

/** A long base64-ish literal: 32+ characters at 4.5+ bits each (hex digests top out at 4). */
function highEntropy(text: string) {
  return [...text.matchAll(/["'`]([A-Za-z0-9+/=_-]{32,})["'`]/g)].some(
    (match) => !/^[a-f0-9]+$/i.test(match[1]!) && entropy(match[1]!) >= 4.5,
  )
}

export function rank(severity: Severity) {
  return SEVERITIES.indexOf(severity)
}

export function atLeast(severity: Severity, threshold: Severity) {
  return rank(severity) <= rank(threshold)
}
