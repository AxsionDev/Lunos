// XCOD-185: brings a running realm (the live Lunos at auth.lunos.tech) to realm-lunos.json's shape through
// the admin REST API: the lunos client scope and its mappers, lunos as a realm default scope, the lunos-idp
// event listener, the app and console clients, and lunos on lunos-cli. A realm file is imported only into
// an empty Keycloak, so an existing realm needs this instead.
//
//   KC_URL=https://auth.lunos.tech KC_ADMIN_USER=admin KC_ADMIN_PASSWORD=... bun configure-realm.ts
//
// Optional: KC_REALM (default Lunos), APP_SECRET / CONSOLE_SECRET / CONSOLE_ADMIN_SECRET (otherwise
// Keycloak generates them), DRY_RUN=1 (print the plan, change nothing). Each step reads first and writes
// only what differs, so a second run changes nothing. It never deletes, never touches a client it doesn't
// own (beyond adding lunos to lunos-cli's default scopes) and never prints a secret.
import path from "node:path"

type Env = Record<string, string | undefined>
type Json = any

const BUNDLE = path.join(import.meta.dir, "realm-lunos.json")
const SCOPE = "lunos"
const SECRET_ENV = {
  "lunos-app": "APP_SECRET",
  "lunos-console": "CONSOLE_SECRET",
  "lunos-console-admin": "CONSOLE_ADMIN_SECRET",
} as const
type Owned = keyof typeof SECRET_ENV
// The fields set on an owned client that already exists. Its name, description and enabled flag stay the
// operator's: re-enabling a client someone switched off on purpose is not this script's call.
const CLIENT_FIELDS = [
  "publicClient",
  "clientAuthenticatorType",
  "standardFlowEnabled",
  "implicitFlowEnabled",
  "directAccessGrantsEnabled",
  "serviceAccountsEnabled",
  "frontchannelLogout",
  "redirectUris",
  "webOrigins",
]
const IDP_ROLE = "manage-identity-providers"

// Keycloak returns lists in no promised order, so URI lists compare as sets.
function same(a: unknown, b: unknown) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && b.every((x) => a.includes(x))
  return a === b
}

function adminApi(env: Env, fetchImpl: typeof fetch) {
  const base = env.KC_URL!.replace(/\/+$/, "")
  let token: { value: string; expires: number } | undefined
  const adminToken = async () => {
    // The master realm's access tokens are short-lived; a slow run outlives one.
    if (token && token.expires > Date.now()) return token.value
    const res = await fetchImpl(`${base}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: env.KC_ADMIN_USER!,
        password: env.KC_ADMIN_PASSWORD!,
      }),
    })
    if (!res.ok) throw new Error(`admin sign-in to the master realm as ${env.KC_ADMIN_USER}: ${res.status} ${await res.text()}`)
    const body = (await res.json()) as { access_token: string; expires_in: number }
    token = { value: body.access_token, expires: Date.now() + (body.expires_in - 10) * 1000 }
    return token.value
  }
  const send = async (method: string, p: string, body?: unknown) => {
    const res = await fetchImpl(`${base}/admin${p}`, {
      method,
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    // The request body is left out of the message: a client's may carry its secret.
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`)
    return res
  }
  return {
    base,
    async call(method: string, p: string, body?: unknown): Promise<Json> {
      const text = await (await send(method, p, body)).text()
      return text ? JSON.parse(text) : null
    },
    /** POSTs a new object and returns its id, which Keycloak gives only in the Location header. */
    async create(p: string, body: unknown): Promise<string> {
      const location = (await send("POST", p, body)).headers.get("location")
      if (!location) throw new Error(`POST ${p}: no Location header`)
      return location.slice(location.lastIndexOf("/") + 1)
    },
  }
}

/** Brings the realm to realm-lunos.json's shape and returns the changes made (with DRY_RUN, the changes it would make). */
export async function configure(env: Env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  for (const name of ["KC_URL", "KC_ADMIN_USER", "KC_ADMIN_PASSWORD"]) {
    if (!env[name]) throw new Error(`${name} is not set`)
  }
  const realm = env.KC_REALM || "Lunos"
  // Anything but empty or 0 means dry: a DRY_RUN=true that ran for real would be the worse surprise.
  const dry = !!env.DRY_RUN && env.DRY_RUN !== "0"
  const api = adminApi(env, fetchImpl)
  const r = `/realms/${encodeURIComponent(realm)}`

  const bundle: Json = await Bun.file(BUNDLE).json()
  const wantScope: Json = bundle.clientScopes.find((s: Json) => s.name === SCOPE)
  const wantClient = (clientId: string): Json => bundle.clients.find((c: Json) => c.clientId === clientId)

  const changes: string[] = []
  const change = async <T>(what: string, write: () => Promise<T>): Promise<T | undefined> => {
    changes.push(what)
    return dry ? undefined : write()
  }
  const clientByClientId = async (clientId: string): Promise<Json | undefined> =>
    (await api.call("GET", `${r}/clients?clientId=${encodeURIComponent(clientId)}`))[0]

  // Every check that can refuse runs before the first write, so a refusal leaves the realm untouched.
  const info = await api.call("GET", "/serverinfo")
  const missing = [
    ...(info.protocolMapperTypes?.["openid-connect"]?.some((m: Json) => m.id === "lunos-idp-mapper")
      ? []
      : ["the protocol mapper lunos-idp-mapper"]),
    ...(info.providers?.eventsListener?.providers?.["lunos-idp"] ? [] : ["the event listener lunos-idp"]),
  ]
  if (missing.length) {
    throw new Error(
      `Keycloak at ${api.base} doesn't offer ${missing.join(" or ")}: the lunos-idp jar isn't deployed. ` +
        "Run ./build.sh, mount providers/ at /opt/keycloak/providers (compose.yaml does) and restart Keycloak.",
    )
  }
  await api.call("GET", r)
  const cli = await clientByClientId("lunos-cli")
  if (!cli) throw new Error(`realm ${realm} has no lunos-cli client; this script doesn't create it (import realm-lunos.json into a new realm instead)`)

  // The lunos client scope and both its mappers.
  const scopes: Json[] = await api.call("GET", `${r}/client-scopes`)
  let scopeId: string | undefined = scopes.find((s) => s.name === SCOPE)?.id
  if (!scopeId) {
    const mappers = wantScope.protocolMappers.map((m: Json) => m.name).join(", ")
    scopeId = await change(`create client scope ${SCOPE} (mappers ${mappers})`, () => api.create(`${r}/client-scopes`, wantScope))
  } else {
    const mappersPath = `${r}/client-scopes/${scopeId}/protocol-mappers/models`
    const have: Json[] = await api.call("GET", mappersPath)
    for (const want of wantScope.protocolMappers) {
      const mapper = have.find((m) => m.name === want.name)
      if (!mapper) {
        await change(`add mapper ${want.name} to client scope ${SCOPE}`, () => api.call("POST", mappersPath, want))
        continue
      }
      // Changing a mapper's type would mean replacing it, and this script never deletes.
      if (mapper.protocolMapper !== want.protocolMapper) {
        throw new Error(`client scope ${SCOPE}'s mapper ${want.name} is a ${mapper.protocolMapper}, not a ${want.protocolMapper}; fix it by hand`)
      }
      const keys = Object.keys(want.config).filter((k) => mapper.config?.[k] !== want.config[k])
      if (keys.length) {
        await change(`set ${keys.join(", ")} on client scope ${SCOPE}'s mapper ${want.name}`, () =>
          api.call("PUT", `${mappersPath}/${mapper.id}`, { ...mapper, config: { ...mapper.config, ...want.config } }),
        )
      }
    }
  }

  // New clients get lunos without naming it.
  const realmDefaults: Json[] = await api.call("GET", `${r}/default-default-client-scopes`)
  if (!realmDefaults.some((s) => s.name === SCOPE)) {
    await change(`add ${SCOPE} to the realm's default client scopes`, () =>
      api.call("PUT", `${r}/default-default-client-scopes/${scopeId}`),
    )
  }

  // Without the listener the mapper can't tell a brokered sign-in and says lunos for every one.
  const events: Json = await api.call("GET", `${r}/events/config`)
  const listeners: string[] = events.eventsListeners ?? []
  if (!listeners.includes("lunos-idp")) {
    await change(`add the lunos-idp event listener (keeping ${listeners.join(", ") || "none"})`, () =>
      api.call("PUT", `${r}/events/config`, { ...events, eventsListeners: [...listeners, "lunos-idp"] }),
    )
  }

  const ids = new Map<string, string | undefined>([["lunos-cli", cli.id]])
  const created = new Set<string>()
  let hadServiceAccount = false
  for (const clientId of Object.keys(SECRET_ENV) as Owned[]) {
    const want = wantClient(clientId)
    const secretEnv = SECRET_ENV[clientId]
    const secret = env[secretEnv]
    const have = await clientByClientId(clientId)
    if (!have) {
      // The bundle's entry names its default scopes, lunos among them where it belongs.
      const from = secret ? `, secret from ${secretEnv}` : ""
      created.add(clientId)
      ids.set(clientId, await change(`create client ${clientId}${from}`, () => api.create(`${r}/clients`, secret ? { ...want, secret } : want)))
      continue
    }
    ids.set(clientId, have.id)
    if (clientId === "lunos-console-admin") hadServiceAccount = have.serviceAccountsEnabled === true

    const fields = CLIENT_FIELDS.filter((k) => k in want && !same(have[k], want[k]))
    const attributes = Object.keys(want.attributes ?? {}).filter((k) => have.attributes?.[k] !== want.attributes[k])
    // A public client has no secret to compare yet; the update below makes it confidential.
    const newSecret =
      !!secret && (have.publicClient || (await api.call("GET", `${r}/clients/${have.id}/client-secret`))?.value !== secret)
    const what = [...fields, ...attributes, ...(newSecret ? [`secret from ${secretEnv}`] : [])]
    if (what.length) {
      const update = Object.fromEntries(fields.map((k) => [k, want[k]]))
      await change(`set ${what.join(", ")} on client ${clientId}`, () =>
        api.call("PUT", `${r}/clients/${have.id}`, {
          ...have,
          ...update,
          attributes: { ...have.attributes, ...want.attributes },
          ...(newSecret ? { secret } : {}),
        }),
      )
    }
  }

  // lunos on each existing client whose bundle entry lists it; a client created above already has it.
  for (const clientId of ["lunos-cli", ...Object.keys(SECRET_ENV)]) {
    const id = ids.get(clientId)
    if (!id || created.has(clientId) || !wantClient(clientId).defaultClientScopes?.includes(SCOPE)) continue
    const defaults: Json[] = await api.call("GET", `${r}/clients/${id}/default-client-scopes`)
    if (!defaults.some((s) => s.name === SCOPE)) {
      await change(`add ${SCOPE} to client ${clientId}'s default scopes`, () =>
        api.call("PUT", `${r}/clients/${id}/default-client-scopes/${scopeId}`),
      )
    }
  }

  // The console creates organisations' identity providers through this account and needs nothing else.
  const consoleAdmin = ids.get("lunos-console-admin")
  // In a dry run, a service account this run would create doesn't exist yet: its role is planned unread.
  const account: Json = consoleAdmin && (!dry || hadServiceAccount)
    ? await api.call("GET", `${r}/clients/${consoleAdmin}/service-account-user`)
    : undefined
  const realmManagement = await clientByClientId("realm-management")
  const granted: Json[] = account
    ? await api.call("GET", `${r}/users/${account.id}/role-mappings/clients/${realmManagement.id}`)
    : []
  if (!granted.some((role) => role.name === IDP_ROLE)) {
    await change(`give lunos-console-admin's service account realm-management's ${IDP_ROLE}`, async () => {
      const role = await api.call("GET", `${r}/clients/${realmManagement.id}/roles/${IDP_ROLE}`)
      await api.call("POST", `${r}/users/${account.id}/role-mappings/clients/${realmManagement.id}`, [role])
    })
  }

  return changes
}

if (import.meta.main) {
  try {
    const env = process.env
    const realm = env.KC_REALM || "Lunos"
    const dry = !!env.DRY_RUN && env.DRY_RUN !== "0"
    const changes = await configure(env)
    if (!changes.length) console.log(`Realm ${realm} already matches realm-lunos.json; nothing changed.`)
    else console.log(`${dry ? "DRY_RUN, nothing changed. Would" : "Done"}:\n${changes.map((c) => `  - ${c}`).join("\n")}`)
    // The secrets stay in Keycloak; say where to read them, not what they are.
    const consoleUrl = `${env.KC_URL!.replace(/\/+$/, "")}/admin/master/console/#/${encodeURIComponent(realm)}/clients`
    console.log(`\nClient secrets: ${consoleUrl}, then each client's Credentials tab:`)
    for (const [clientId, secretEnv] of Object.entries(SECRET_ENV)) {
      console.log(`  - ${clientId}${env[secretEnv] ? ` (set from ${secretEnv})` : ""}`)
    }
  } catch (err) {
    console.error(`configure-realm: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
