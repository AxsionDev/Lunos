// XCOD-185: test harness for the Lunos realm. Starts a throwaway Keycloak 26.3 in Docker with the
// lunos_idp mapper and the realm files, talks to its admin API, and drives the browser sign-in
// (including a brokered one) over plain HTTP with a cookie jar, so the tests need nothing but Docker.
import path from "node:path"

export const PORT = 18180
const BASE = `http://localhost:${PORT}`
const DIR = path.resolve(import.meta.dir, "..")
const IMAGE = "quay.io/keycloak/keycloak:26.3"
export const TEST_CLIENT = "lunos-test"
export const TEST_REDIRECT = `${BASE}/cb`

export type Kc = {
  base: string
  admin(method: string, path: string, body?: unknown): Promise<any>
  stop(): Promise<void>
}

export type Tokens = {
  access_token: string
  id_token: string
  refresh_token: string
  [key: string]: unknown
}

export function dockerAvailable() {
  return Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
}

function sh(cmd: string[], cwd = DIR) {
  const out = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (out.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed:\n${out.stderr.toString()}${out.stdout.toString()}`)
  return out.stdout.toString().trim()
}

/**
 * Starts Keycloak with the given realm files imported (default: the production realm file and the
 * test upstream realm). Paths are relative to deploy/identity/keycloak. The port is the same inside
 * and outside the container, so an identity provider's URLs work from both the test and Keycloak.
 */
export async function startKeycloak(opts?: { realmFiles?: string[] }): Promise<Kc> {
  // Always rebuild: a stale jar from an earlier checkout would test old code.
  sh(["./build.sh"])
  // A run killed before its afterAll leaves its container holding the port.
  const leftovers = sh(["docker", "ps", "-aq", "--filter", "name=^lunos-kc-test-"])
  if (leftovers) sh(["docker", "rm", "-f", ...leftovers.split("\n")])
  const realmFiles = opts?.realmFiles ?? ["realm-lunos.json", "test/upstream-realm.json"]
  const name = `lunos-kc-test-${crypto.randomUUID().slice(0, 8)}`
  const stop = async () => {
    Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" })
  }
  // prettier-ignore
  const args = [
    "docker", "run", "-d", "--name", name, "-p", `${PORT}:${PORT}`,
    "-e", "KC_BOOTSTRAP_ADMIN_USERNAME=admin", "-e", "KC_BOOTSTRAP_ADMIN_PASSWORD=admin",
    // The realm file's ${SMTP_*} placeholders must resolve or the import fails.
    "-e", "SMTP_HOST=", "-e", "SMTP_PORT=587", "-e", "SMTP_FROM=no-reply@lunos.test", "-e", "SMTP_USER=", "-e", "SMTP_PASSWORD=",
    "-v", `${path.join(DIR, "providers")}:/opt/keycloak/providers:ro`,
    ...realmFiles.flatMap((file) => ["-v", `${path.resolve(DIR, file)}:/opt/keycloak/data/import/${path.basename(file)}:ro`]),
    IMAGE, "start-dev", `--http-port=${PORT}`, "--import-realm",
  ]
  try {
    sh(args)
    await waitReady(name)
  } catch (err) {
    await stop()
    throw err
  }

  let token: { value: string; expires: number } | undefined
  const adminToken = async () => {
    // The master realm's access tokens live 60 s, shorter than a test run.
    if (token && token.expires > Date.now()) return token.value
    const res = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password: "admin" }),
    })
    if (!res.ok) throw new Error(`admin token: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { access_token: string; expires_in: number }
    token = { value: body.access_token, expires: Date.now() + (body.expires_in - 10) * 1000 }
    return token.value
  }

  return {
    base: BASE,
    stop,
    async admin(method, p, body) {
      const res = await fetch(`${BASE}/admin/realms${p}`, {
        method,
        headers: {
          authorization: `Bearer ${await adminToken()}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text}`)
      return text ? JSON.parse(text) : null
    },
  }
}

async function waitReady(name: string) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/realms/Lunos/.well-known/openid-configuration`).catch(() => undefined)
    if (res?.status === 200) return
    const state = Bun.spawnSync(["docker", "inspect", "-f", "{{.State.Running}}", name]).stdout.toString().trim()
    if (state !== "true") break
    await Bun.sleep(1000)
  }
  const logs = Bun.spawnSync(["docker", "logs", "--tail", "60", name], { stderr: "pipe" })
  throw new Error(`Keycloak didn't become ready:\n${logs.stdout.toString()}${logs.stderr.toString()}`)
}

/** A browser's cookies for one host, keyed by (name, path); a cookie is sent when its path prefixes the request's. */
export class CookieJar {
  private cookies = new Map<string, { name: string; value: string; path: string }>()

  store(res: Response) {
    for (const header of res.headers.getSetCookie()) {
      const [pair, ...attrs] = header.split(";").map((part) => part.trim())
      const eq = pair.indexOf("=")
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      const attr = (key: string) =>
        attrs.find((a) => a.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1)
      const cookiePath = attr("path") ?? "/"
      const maxAge = attr("max-age")
      const expires = attr("expires")
      const expired = (maxAge !== undefined && Number(maxAge) <= 0) || (expires !== undefined && Date.parse(expires) < Date.now())
      const key = `${name}\0${cookiePath}`
      if (expired) this.cookies.delete(key)
      else this.cookies.set(key, { name, value, path: cookiePath })
    }
  }

  header(url: string) {
    const p = new URL(url).pathname
    return [...this.cookies.values()]
      .filter((c) => p === c.path || p.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ")
  }
}

export function pkce() {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
  const challenge = new Bun.CryptoHasher("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")

const attrsOf = (tag: string) =>
  Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1].toLowerCase(), decode(m[2])]))

/**
 * The page's first form: its action and the values it would submit as it stands. Of its submit
 * buttons only the first counts, as if clicked: a consent page's second button is "No".
 */
function firstForm(html: string) {
  const m = html.match(/<form\b[^>]*\baction="[^"]*"[^>]*>([\s\S]*?)<\/form>/i)
  if (!m) return undefined
  const action = attrsOf(m[0].slice(0, m[0].indexOf(">") + 1)).action
  const fields: Record<string, string> = {}
  let clicked = false
  for (const tag of m[1].matchAll(/<(input|button)\b[^>]*>/gi)) {
    const a = attrsOf(tag[0])
    if (!a.name) continue
    const submit = tag[1].toLowerCase() === "button" ? (a.type ?? "submit") === "submit" : a.type === "submit"
    if (submit) {
      if (clicked) continue
      clicked = true
    } else if (tag[1].toLowerCase() === "button") continue
    if ((a.type === "checkbox" || a.type === "radio") && !/\bchecked\b/i.test(tag[0])) continue
    fields[a.name] = a.value ?? ""
  }
  return { action, fields }
}

type BrowseOptions = {
  username: string
  password: string
  jar: CookieJar
  /** On a login page, follow the link to this identity provider instead of posting the form. */
  idpLink?: string
  /** A redirect to a URL starting with this ends the walk. */
  stopAt?: string
}

/**
 * Walks Keycloak's pages the way a browser would: follows redirects, and on each HTML page posts its
 * first form with the inputs' current values (so Keycloak's prefilled profile pages pass through) plus
 * username and password wherever the form asks for them. Ends at a redirect to `stopAt`, or at a page
 * with nothing to submit.
 */
async function browse(start: string, opts: BrowseOptions) {
  let url = start
  let init: RequestInit = {}
  let html = ""
  let followedIdp = false
  // Each form posted, as "<action path> <field names>", so a test can tell which pages the sign-in went through.
  const posted: string[] = []
  for (let hop = 0; hop <= 15; hop++) {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers as Record<string, string>), cookie: opts.jar.header(url) },
    })
    opts.jar.store(res)
    const location = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString()
      init = {}
      if (opts.stopAt && url.startsWith(opts.stopAt)) return { url, html, posted }
      continue
    }
    html = await res.text()
    const link = opts.idpLink && !followedIdp && html.match(new RegExp(`href="([^"]*/broker/${opts.idpLink}/login[^"]*)"`))
    if (link) {
      followedIdp = true
      url = new URL(decode(link[1]), url).toString()
      init = {}
      continue
    }
    const form = firstForm(html)
    if (!form?.action) return { url, html, posted }
    const fields = { ...form.fields }
    if ("username" in fields) fields.username = opts.username
    if ("password" in fields) fields.password = opts.password
    url = new URL(form.action, url).toString()
    posted.push(`${new URL(url).pathname} ${Object.keys(fields).join(",")}`)
    init = {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    }
  }
  throw new Error(`browser walk exceeded 15 hops; last page at ${url}:\n${html.slice(0, 2048)}`)
}

export type LoginParams = {
  username: string
  password: string
  /** kc_idp_hint: go straight to this identity provider. */
  idpHint?: string
  /** Reuse a browser (same Keycloak cookies) across sign-ins. */
  jar?: CookieJar
  /** Extra authorization request parameters, e.g. { prompt: "login" }. */
  extra?: Record<string, string>
  /** Default "openid". */
  scope?: string
  clientId?: string
  redirectUri?: string
}

/** Signs in through the browser flow (authorization code + PKCE) and returns the code. */
export async function browserLogin(kc: Kc, params: LoginParams) {
  const jar = params.jar ?? new CookieJar()
  const { verifier, challenge } = pkce()
  const redirectUri = params.redirectUri ?? TEST_REDIRECT
  const query = new URLSearchParams({
    client_id: params.clientId ?? TEST_CLIENT,
    response_type: "code",
    scope: params.scope ?? "openid",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(params.idpHint ? { kc_idp_hint: params.idpHint } : {}),
    ...params.extra,
  })
  const start = `${kc.base}/realms/Lunos/protocol/openid-connect/auth?${query}`
  const { url, html, posted } = await browse(start, { ...params, jar, stopAt: redirectUri })
  if (!url.startsWith(redirectUri)) {
    throw new Error(`browser sign-in didn't reach ${redirectUri}; last page at ${url}:\n${html.slice(0, 2048)}`)
  }
  const code = new URL(url).searchParams.get("code")
  if (!code) throw new Error(`sign-in ended without a code: ${url}`)
  return { code, verifier, jar, posted }
}

/**
 * The CLI's sign-in (OAuth 2.0 device authorization grant): starts it as `lunos-cli`, approves it in
 * the browser at verification_uri_complete, then fetches the tokens as the CLI's poll would.
 */
export async function deviceLogin(
  kc: Kc,
  params: { username: string; password: string; jar?: CookieJar; idpLink?: string; scope?: string },
) {
  const jar = params.jar ?? new CookieJar()
  const res = await fetch(`${kc.base}/realms/Lunos/protocol/openid-connect/auth/device`, {
    method: "POST",
    body: new URLSearchParams({ client_id: "lunos-cli", scope: params.scope ?? "openid" }),
  })
  const device = (await res.json()) as { device_code: string; verification_uri_complete: string }
  if (!res.ok) throw new Error(`device authorization: ${res.status} ${JSON.stringify(device)}`)
  const { posted, html } = await browse(device.verification_uri_complete, { ...params, jar })
  const tokens = await tokenRequest(kc, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: "lunos-cli",
    device_code: device.device_code,
  }).catch((err) => {
    throw new Error(`${err.message}\nlast browser page:\n${html.slice(0, 2048)}`)
  })
  return { tokens, jar, posted }
}

async function tokenRequest(kc: Kc, form: Record<string, string>, realm = "Lunos"): Promise<Tokens> {
  const res = await fetch(`${kc.base}/realms/${realm}/protocol/openid-connect/token`, {
    method: "POST",
    body: new URLSearchParams(form),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`token (${form.grant_type}): ${res.status} ${JSON.stringify(body)}`)
  return body as Tokens
}

export function exchange(kc: Kc, clientId: string, code: string, verifier: string) {
  return tokenRequest(kc, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: TEST_REDIRECT,
  })
}

export function passwordGrant(kc: Kc, clientId: string, username: string, password: string, realm = "Lunos") {
  return tokenRequest(kc, { grant_type: "password", client_id: clientId, username, password, scope: "openid" }, realm)
}

export function refresh(kc: Kc, clientId: string, refreshToken: string) {
  return tokenRequest(kc, { grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken })
}

/** A JWT's payload, unverified: the tests read what Keycloak issued, they don't check signatures. */
export function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString())
}
