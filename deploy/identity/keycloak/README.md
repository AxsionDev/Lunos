# Lunos Cloud identity provider (Keycloak)

The sign-in service behind `lunos login` (XCOD-185). It's Keycloak 26 with Postgres, in Docker on our own server. The realm is imported automatically on first start.

**Why Keycloak:** PO decision (2026-10-09), "the easiest to install on a local server".

- It's one container plus Postgres, and the realm (client, organisations, e-mail verification) comes from one file.
- Organisations (AC2) are built in.
- `lunos login` was already tested against it.
- Zitadel needs more setup before the first sign-in: a master key, an init step and its own console.

## What the realm sets up

| Setting                                                | Covers                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `lunos-cli`: public client, device flow only           | `lunos login` / `whoami` / `logout` (AC3), and revocation on logout (AC4)                 |
| Self-registration, e-mail as username, verified e-mail | Sign-up with a verified e-mail (AC1). Needs SMTP.                                         |
| `organizationsEnabled`, `organization` scope           | Organisations and invites by e-mail (AC2). `lunos whoami` shows the user's organisations. |
| Realm roles `org-owner`, `org-admin`, `org-member`     | Roles for AC2                                                                             |
| Brute-force protection, `sslRequired: external`        | Basic hardening                                                                           |

**Not in the file, configured in the admin console once secrets exist:**

- **GitHub sign-in (AC1):** _Identity providers → GitHub_, using an OAuth app from GitHub's settings.
- **SMTP credentials:** set in `.env`.

## Install

On the server, in this directory:

```sh
cp .env.example .env        # fill in hostname, passwords and SMTP; never commit .env
docker compose --env-file .env up -d
./verify.sh http://localhost:8080
```

Put a reverse proxy with TLS in front of `127.0.0.1:8080` for the public name in `KC_HOSTNAME` (for example `https://id.lunos.tech`). Then check it from outside:

```sh
./verify.sh https://id.lunos.tech
```

**Then make it the default:** set `cloud.issuer` to `https://id.lunos.tech/realms/lunos` in Lunos (the XCOD-185 follow-up), so `lunos login` works without `--issuer`.

## Operating it

- **Admin console:** `https://<host>/admin/`, signing in with `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`. After the first sign-in, create a named admin and delete the bootstrap one.
- **Backups:** the `db` volume holds everything (users, organisations, sessions). Back it up with `docker compose exec db pg_dump -U keycloak keycloak`.
- **Changing the realm:** `--import-realm` skips a realm that already exists. Edits to `realm-lunos.json` therefore apply only to a fresh database. On a running server, change the realm in the console.
- **GDPR (AC5):** deleting a user in the console removes the account, its sessions and its organisation memberships. A self-service export and delete flow is still to be built.
- **Residency (AC6):** all identity data lives in this Postgres volume on this server.

## Tested

Tested locally on 2026-10-09 with Keycloak 26.3.5 and Postgres 17, from a fresh volume:

- The realm imported.
- `verify.sh` passed.
- `lunos login` succeeded through the browser device page, as a test user in a test organisation.
- `whoami` showed the user and the organisation.
- `logout` revoked the session: 0 sessions and 0 offline sessions left on the server.
