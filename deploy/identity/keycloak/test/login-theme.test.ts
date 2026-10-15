// XCOD-244: the lunos login theme against a real Keycloak 26.3 in Docker. Run from deploy/identity/keycloak:
// bun test test/login-theme.test.ts (skipped when Docker isn't running). The form contract checked here is
// what browserLogin (test/keycloak.ts) and the lunoshq Playwright e2e drive the pages by.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { CookieJar, dockerAvailable, firstForm, type Kc, pkce, startKeycloak, TEST_CLIENT, TEST_REDIRECT } from "./keycloak"

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
})
