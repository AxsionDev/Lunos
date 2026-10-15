// XCOD-244: the lunos login theme against a real Keycloak 26.3 in Docker. Run from deploy/identity/keycloak:
// bun test test/login-theme.test.ts (skipped when Docker isn't running). The form contract checked here is
// what browserLogin (test/keycloak.ts) and the lunoshq Playwright e2e drive the pages by.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { browse, CookieJar, dockerAvailable, firstForm, type Kc, pkce, startKeycloak, TEST_CLIENT, TEST_REDIRECT } from "./keycloak"

setDefaultTimeout(30_000)

const R = "/Lunos"
const PAT = { email: "pat@lunos.test", password: "pat-pass" }

describe.skipIf(!dockerAvailable())("lunos login theme", () => {
  let kc: Kc

  const authUrl = () =>
    `${kc.base}/realms/Lunos/protocol/openid-connect/auth?${new URLSearchParams({
      client_id: TEST_CLIENT,
      response_type: "code",
      scope: "openid",
      redirect_uri: TEST_REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
    })}`

  async function page(url: string, jar: CookieJar) {
    for (let hop = 0; hop < 10; hop++) {
      const res = await fetch(url, { redirect: "manual", headers: { cookie: jar.header(url) } })
      jar.store(res)
      const location = res.headers.get("location")
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString()
        continue
      }
      return await res.text()
    }
    throw new Error(`too many redirects from ${url}`)
  }

  beforeAll(async () => {
    kc = await startKeycloak({ realmFiles: ["realm-lunos.json"] })
    await kc.admin("POST", `${R}/clients`, {
      clientId: TEST_CLIENT,
      enabled: true,
      publicClient: true,
      standardFlowEnabled: true,
      redirectUris: [TEST_REDIRECT],
      attributes: { "pkce.code.challenge.method": "S256" },
    })
    await kc.admin("POST", `${R}/users`, {
      username: PAT.email,
      email: PAT.email,
      emailVerified: true,
      firstName: "Pat",
      lastName: "Lunos",
      enabled: true,
      credentials: [{ type: "password", value: PAT.password, temporary: false }],
    })
  }, 180_000)

  afterAll(async () => {
    await kc?.stop()
  })

  test("the login page is the lunos theme and keeps the form contract", async () => {
    const html = await page(authUrl(), new CookieJar())
    expect(html).toMatch(/\/resources\/[^/]+\/login\/lunos\/css\/lunos\.css/)
    expect(html).toContain('class="login-pf pf-v5-theme-dark')
    expect(html).toContain("lunos-mark.svg")
    expect(html).toContain("<title>Sign in to Lunos</title>")
    const form = firstForm(html)!
    expect(html.match(/<form\b[^>]*>/)![0]).toContain('id="kc-form-login"')
    expect(Object.keys(form.fields)).toEqual(expect.arrayContaining(["username", "password"]))
    expect(html).toContain('id="kc-login"')
    expect(html).toMatch(/id="kc-registration"[\s\S]*New to Lunos\?[\s\S]*Create account/)
    expect(html).toMatch(/id="kc-login"[^>]*value="Continue"|id="kc-login"[\s\S]{0,200}Continue/)
  })

  test("a wrong password shows the error in the card and the same first form", async () => {
    const jar = new CookieJar()
    const html = await page(authUrl(), jar)
    const form = firstForm(html)!
    const res = await fetch(new URL(form.action, kc.base), {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header(form.action) },
      body: new URLSearchParams({ ...form.fields, username: PAT.email, password: "wrong" }),
    })
    const after = await res.text()
    expect(after).toMatch(/kc-feedback-text|pf-m-error/)
    expect(after.match(/<form\b[^>]*>/)![0]).toContain('id="kc-form-login"')
  })

  test("nothing on the login page loads from another origin", async () => {
    const html = await page(authUrl(), new CookieJar())
    const urls = [...html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
    const foreign = urls.filter((u) => new URL(u).origin !== new URL(kc.base).origin)
    expect(foreign).toEqual([])
    const css = await (await fetch(new URL(html.match(/href="([^"]*lunos\.css)"/)![1], kc.base))).text()
    expect(css).not.toMatch(/url\(\s*["']?https?:/)
    expect(css).toContain("@font-face")
  })

  const addIdp = (alias: string, providerId = alias) =>
    kc.admin("POST", `${R}/identity-provider/instances`, {
      alias,
      providerId,
      enabled: true,
      config: { clientId: "x", clientSecret: "y" },
    })
  const removeIdp = (alias: string) => kc.admin("DELETE", `${R}/identity-provider/instances/${alias}`)

  test("with no identity providers there is no OR divider and no social list", async () => {
    const html = await page(authUrl(), new CookieJar())
    expect(html).not.toContain("lunos-or")
    expect(html).not.toContain("kc-social-providers")
  })

  test("social buttons come before the form, one column, then OR, and the form still posts", async () => {
    for (const a of ["google", "github", "microsoft", "gitlab"]) await addIdp(a)
    try {
      const html = await page(authUrl(), new CookieJar())
      const social = html.indexOf('id="social-google"')
      const or = html.indexOf('class="lunos-or"')
      const form = html.indexOf('id="kc-form-login"')
      expect(social).toBeGreaterThan(-1)
      expect(social).toBeLessThan(or)
      expect(or).toBeLessThan(form)
      expect(html).toContain("Continue with GitHub")
      expect(html).not.toContain("pf-v5-l-grid")
      expect(html.match(/<form\b[^>]*>/)![0]).toContain('id="kc-form-login"')
      expect(html).not.toMatch(/<form\b[^>]*broker/)
    } finally {
      for (const a of ["google", "github", "microsoft", "gitlab"]) await removeIdp(a)
    }
  })

  test("every supported locale renders without raw lunos message keys", async () => {
    await addIdp("github")
    try {
      // As a person switches language: through the page's own language select, whose options link here.
      const inLocale = async (locale: string) => {
        const jar = new CookieJar()
        const first = await page(authUrl(), jar)
        const option = first.match(new RegExp(`value="([^"]*kc_locale=${locale})"`))![1].replaceAll("&amp;", "&")
        return page(new URL(option, kc.base).toString(), jar)
      }
      const realm = await kc.admin("GET", R)
      for (const locale of realm.supportedLocales as string[]) {
        const html = await inLocale(locale)
        expect(html).toContain(`lang="${locale}"`)
        expect(html).not.toMatch(/lunos(ContinueWith|Or|HaveAccount)/)
        expect(html.match(/<form\b[^>]*>/)![0]).toContain('id="kc-form-login"')
      }
      expect(await inLocale("bg")).toContain("Продължи с GitHub")
    } finally {
      await removeIdp("github")
    }
  })

  test("registration shows the card with social buttons and a sign-up reaches the client", async () => {
    await addIdp("github")
    // The test realm has no SMTP; skip verify-email here (the lunoshq e2e covers it with mailpit).
    await kc.admin("PUT", R, { verifyEmail: false })
    try {
      const jar = new CookieJar()
      const login = await page(authUrl(), jar)
      const href = login.match(/href="([^"]*login-actions\/registration[^"]*)"/)![1].replaceAll("&amp;", "&")
      const regUrl = new URL(href, kc.base).toString()
      const reg = await page(regUrl, jar)
      expect(reg).toContain("Create your Lunos account")
      expect(reg.indexOf('id="social-github"')).toBeLessThan(reg.indexOf('id="kc-register-form"'))
      expect(reg).toMatch(/Already have an account\?/)
      expect(Object.keys(firstForm(reg)!.fields)).toEqual(
        expect.arrayContaining(["email", "firstName", "lastName", "password", "password-confirm"]),
      )

      const email = `new-${crypto.randomUUID().slice(0, 6)}@lunos.test`
      const { url } = await browse(regUrl, {
        username: email,
        password: "new-pass-123",
        jar,
        stopAt: TEST_REDIRECT,
        fill: { email, firstName: "New", lastName: "User", "password-confirm": "new-pass-123" },
      })
      expect(url.startsWith(TEST_REDIRECT)).toBe(true)
      expect(new URL(url).searchParams.get("code")).toBeTruthy()
    } finally {
      await kc.admin("PUT", R, { verifyEmail: true })
      await removeIdp("github")
    }
  })
})
