# Lunos Cloud identity provider (Keycloak)

The sign-in service behind `lunos login` (XCOD-185). It's Keycloak 26 with Postgres, in Docker on our own server, at `https://auth.lunos.tech`, realm `Lunos` (issuer `https://auth.lunos.tech/realms/Lunos`). It is the identity provider for every Lunos product (PO, 2026-10-13). The realm is imported automatically on first start.

**Why Keycloak:** PO decision (2026-10-09), "the easiest to install on a local server".

- It's one container plus Postgres, and the realm (client, organisations, e-mail verification) comes from one file.
- Organisations (AC2) are built in.
- `lunos login` was already tested against it.
- Zitadel needs more setup before the first sign-in: a master key, an init step and its own console.

## What the realm sets up

| Setting                                                | Covers                                                                                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lunos-cli`: public client, device flow only           | `lunos login` / `whoami` / `logout` (AC3), and revocation on logout (AC4)                                                                                                        |
| Self-registration, e-mail as username, verified e-mail | Sign-up with a verified e-mail (AC1). Needs SMTP.                                                                                                                                |
| `organizationsEnabled`, `organization` scope           | Organisations and invites by e-mail (AC2). `lunos whoami` shows the user's organisations.                                                                                        |
| `lunos` client scope (default on every client) | The `lunos_idp` claim and the `lunos-api` audience in access tokens. The realm's default client scopes include it, so a client created later in the admin console gets both too. See below. |
| `lunos-app`: confidential, authorization code + PKCE | The private space at `app.lunos.tech`. Back-channel logout. |
| `lunos-console`: confidential, authorization code + PKCE | The admin console mounted in the control plane (`cloud.lunos.tech/console`). |
| `lunos-console-admin`: service account | The console's way to create organisations' identity providers. Its only role is `manage-identity-providers`. |
| Realm roles `org-owner`, `org-admin`, `org-member`     | Unused. Organisations and roles live in the Lunos control plane (XCOD-190). |
| Brute-force protection, `sslRequired: external`        | Basic hardening                                                                                                                                                                  |

**Not in the file, configured in the admin console once secrets exist:**

- **GitHub sign-in (AC1):** _Identity providers → GitHub_, using an OAuth app from GitHub's settings.
- **SMTP credentials:** set in `.env`.
- **Client secrets:** `lunos-app`, `lunos-console` and `lunos-console-admin` have none in the file. Keycloak generates them; read each under _Clients → client → Credentials_.

## The `lunos_idp` claim

Access tokens and userinfo carry `lunos_idp`, which says which provider the session's latest sign-in used. The control plane's enforce-SSO rule compares it with an organisation's required connection (`docs/enforce-sso.md` in the lunoshq repo).

| Value                      | When                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `lunos`                    | The user signed in with Lunos's own credentials (password, passkey).                                                              |
| `org:<org id>:<connection>` | The brokered identity provider's `lunosIdp` config attribute, when it has that shape.                                            |
| the provider's alias       | A brokered provider without a valid `lunosIdp`; any `:` in the alias becomes `-`, so an alias can't imitate the organisation form. |

The value never comes from user attributes or request parameters. Never name an identity provider `lunos`: it would read as own credentials.

**How it works.** The jar built from `lunos-idp-mapper/` provides two things: the protocol mapper `lunos-idp-mapper` (in the `lunos` scope) and the event listener `lunos-idp`. The listener records the provider of the session's latest authentication in the session note `lunos.idp.alias`; the mapper reads it. A cookie (SSO) sign-in to another client keeps the value, a brokered sign-in records the alias, and a sign-in with Lunos's own credentials records an empty one. That covers the device flow (including its consent step) and offline sessions. A step-up second factor on top of the session cookie (OTP, say) counts as a fresh non-brokered sign-in and clears the organisation value; that errs on the side of refusing. The same holds for the CLI: `lunos login` approves its device sign-in in the browser, so it shares that browser's user session. A password re-authentication or a step-up there also changes the value for CLI tokens approved from that session, offline tokens included, until the next sign-in through the organisation's provider.

**If the listener isn't enabled in the realm (not in `eventsListeners`), every token says `lunos`.** This is a different failure from a missing jar (see Install). That fails closed: organisation members are refused by enforce-SSO, never let through. `configure-realm.ts` enables it; the realm file lists it in `eventsListeners`.

**Setting `lunosIdp` on an organisation's provider.** The admin console has no field for custom config keys, so use the admin REST API. Only realm admins and the console's service account (`lunos-console-admin`) can write it.

```sh
KC=https://auth.lunos.tech
TOKEN=$(curl -fsS "$KC/realms/Lunos/protocol/openid-connect/token" \
  -d grant_type=client_credentials -d client_id=lunos-console-admin \
  -d client_secret="$CONSOLE_ADMIN_SECRET" | jq -r .access_token)
ALIAS=acme-oidc
# Replace <org id> and <connection> below with the organisation's console id and connection name.
# PUT replaces the whole provider: fetch it, add the attribute, send it back.
curl -fsS -H "Authorization: Bearer $TOKEN" "$KC/admin/realms/Lunos/identity-provider/instances/$ALIAS" \
  | jq '.config.lunosIdp = "org:<org id>:<connection>"' \
  | curl -fsS -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      -d @- "$KC/admin/realms/Lunos/identity-provider/instances/$ALIAS"
```

## Install

On the server, in this directory:

```sh
./build.sh
cp .env.example .env        # fill in hostname, passwords and SMTP; never commit .env
docker compose --env-file .env up -d
./verify.sh http://localhost:8080
```

`./build.sh` first (it needs only Docker): it builds `providers/lunos-idp-mapper.jar`, which `compose.yaml` mounts read-only into Keycloak. So on a fresh server the sequence is `./build.sh`, then `docker compose --env-file .env up -d`, then `./verify.sh http://localhost:8080`.

**Without the jar, the import still succeeds, silently.** The realm keeps its `lunos-idp` listener and the `lunos-idp-mapper` mapper, but Keycloak has no provider behind them. It logs `KC-SERVICES0083: Event listener 'lunos-idp' registered, but provider not found` on events, and tokens carry no `lunos_idp` claim. An organisation's enforce-SSO rule (`lunos_idp=org:...`) then can't match and its members are refused: it fails closed, but it is broken. `./verify.sh` does not detect this. `configure-realm.ts` does (it refuses when the server lacks the mapper or listener), and so does that log line. Fix it by adding the jar and restarting Keycloak; no re-import is needed.

Put a reverse proxy with TLS in front of `127.0.0.1:8080` for the public name in `KC_HOSTNAME` (for example `https://auth.lunos.tech`). Then check it from outside:

```sh
./verify.sh https://auth.lunos.tech
```

**Then make it the default:** set `cloud.issuer` to `https://auth.lunos.tech/realms/Lunos` in Lunos (the XCOD-185 follow-up), so `lunos login` works without `--issuer`.

## Upgrade the running realm

`auth.lunos.tech` was imported before the `lunos` scope and the new clients existed, and a realm file is imported only into an empty Keycloak. Bring the running realm up with these steps (they need the server and the realm's admin credentials):

1. Build the jar (`./build.sh`) and copy `providers/lunos-idp-mapper.jar` to the server's `providers/` directory. Add the volume line to the server's `compose.yaml`: `- ./providers:/opt/keycloak/providers:ro`. Restart Keycloak (`docker compose up -d`).
2. Preview the changes:

   ```sh
   DRY_RUN=1 KC_URL=https://auth.lunos.tech KC_ADMIN_USER=... KC_ADMIN_PASSWORD=... bun configure-realm.ts
   ```

3. Run it for real (the same command without `DRY_RUN`).
4. Read the client secrets in the admin console (_Clients → `lunos-app` / `lunos-console` / `lunos-console-admin` → Credentials_). To choose them yourself, set `APP_SECRET`, `CONSOLE_SECRET` and `CONSOLE_ADMIN_SECRET` before step 3.
5. On the control plane, set `LUNOSHQ_OIDC_ISSUER=https://auth.lunos.tech/realms/Lunos`, `LUNOSHQ_OIDC_AUDIENCE=lunos-api`, `LUNOSHQ_CONSOLE_CLIENT_ID=lunos-console` and `LUNOSHQ_CONSOLE_CLIENT_SECRET`.
6. Check: `./verify.sh https://auth.lunos.tech`.

`configure-realm.ts` refuses to run unless the server offers both the mapper and the listener (step 1 missing or Keycloak not restarted). It only adds and merges, never removes: URI lists are unioned with what the client already has, an existing client keeps its name and enabled flag, and a confidential client always ends up with a secret. It never prints a secret, only where to read it. Each step reads first and writes only what differs, so running it twice changes nothing.

## Operating it

- **Admin console:** `https://<host>/admin/`, signing in with `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`. After the first sign-in, create a named admin and delete the bootstrap one.
- **Backups:** the `db` volume holds everything (users, organisations, sessions). Back it up with `docker compose exec db pg_dump -U keycloak keycloak`.
- **Changing the realm:** `--import-realm` skips a realm that already exists. Edits to `realm-lunos.json` therefore apply only to a fresh database. On a running server, change the realm in the console, or run `configure-realm.ts` (see "Upgrade the running realm").
- **Registration rate limit:** Keycloak's brute-force protection covers sign-in, not sign-up. Limit `POST /realms/Lunos/login-actions/registration` per IP at the reverse proxy (IIS: Dynamic IP Restrictions on that path).
- **After a Keycloak upgrade:** re-run `bun test test/lunos-idp.test.ts`. The device-flow fix depends on how Keycloak attaches sessions after consent.
- **GDPR (AC5):** deleting a user in the console removes the account, its sessions and its organisation memberships. A self-service export and delete flow is still to be built.
- **Residency (AC6):** all identity data lives in this Postgres volume on this server.

## Tested

Tested locally on 2026-10-13 with Keycloak 26.3 and Postgres 17. `./build.sh && bun test test/lunos-idp.test.ts` needs Docker and `git fetch origin dev` (one test realm is imported from dev's realm file); the tests always rebuild the jar. The 23 tests cover:

- Password sign-in gives `lunos`; a user attribute named `lunos_idp` can't forge the claim.
- A brokered sign-in gives the `org:` value, the alias fallback, or the alias when `lunosIdp` is malformed.
- The claim in userinfo and after a token refresh.
- Re-authentication in both directions (brokered to password and back), offline tokens included.
- Cookie SSO to a second client keeps the value.
- Device flow, brokered and through the session cookie.
- Client settings: the `lunos-api` audience, PKCE, redirects, the service account's single role.
- With the listener disabled, every token says `lunos`.
- `configure-realm.ts` takes an old realm to the new shape, is idempotent, honours `DRY_RUN`, and refuses a server without the mapper or listener.

Earlier, on 2026-10-09 (Keycloak 26.3.5), from a fresh volume: the realm imported, `verify.sh` passed, `lunos login` succeeded through the browser device page as a test user in a test organisation, `whoami` showed the user and the organisation, and `logout` left 0 sessions and 0 offline sessions on the server.
