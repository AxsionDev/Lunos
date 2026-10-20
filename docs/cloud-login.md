# Signing in: `lunos login`

`lunos login` signs you in to Lunos Cloud, or to your organisation's own identity provider. The official distribution asks for a free Lunos account when it starts (the [Welcome screen](account.md) runs this same sign-in), except where [an exemption applies](without-account.md): self-hosted, offline, CI, and builds from source, where everything works signed out. Signing in also enables Lunos Cloud features (cloud workers, team billing), so your runs and usage belong to you or your organisation, and organisations that serve their policy from the Lunos console: while you're signed in, Lunos fetches it at start (see [organisation policy from the Lunos console](deployment/self-hosted.md#organisation-policy-from-the-lunos-console)). Signing out doesn't lift that policy; the last fetched copy still applies.

By default `lunos login` signs in at Lunos Cloud's own identity provider, `https://auth.lunos.tech/realms/Lunos`. It also works with any OpenID Connect provider your organisation runs that supports the device sign-in flow (Keycloak, Zitadel, Authentik and others): pass `--issuer`, or set `cloud.issuer` (below).

## Sign in

```sh
lunos login                                          # Lunos Cloud
lunos login --issuer https://id.example.eu/realms/lunos   # your organisation's provider
```

Lunos prints a link and a short code, and opens the link in your browser. Sign in there and confirm the code. On a machine without a browser, use `--no-browser` and open the link on another device. This is the OAuth 2.0 device authorization grant (RFC 8628): your password goes only to the identity provider, never to Lunos.

```sh
lunos whoami     # who you're signed in as, and with which issuer
lunos logout     # sign out and revoke this machine's session at the provider
```

To avoid passing `--issuer` every time, set it once:

```sh
lunos settings set cloud.issuer https://id.example.eu/realms/lunos
lunos settings set cloud.client_id lunos-cli   # only if your provider uses another client id
```

An organisation can pin its provider for everyone with managed config, `"cloud": { "issuer": "…" }`, and lock it with `"$locked": ["cloud"]`.

## Session sync and device registration

Right after sign-in, `lunos login` registers this machine as a device with the Lunos Cloud control plane (`https://cloud.lunos.tech`, or `cloud.endpoint` from your global or managed config) and, the first time, prints:

```
Sessions sync to your Lunos space (EU). Run "lunos sync off" to stop on this device.
```

If the device can't be registered, login prints "Session sync isn't set up: …" and still succeeds. Under an organisation policy that locks sync off, it prints `Your organisation's policy keeps session sync off.` instead of the notice. Signing out leaves the registered device in place; signing in again as the same user reuses it.

With your organisation's identity provider (`--issuer` or `cloud.issuer`), Lunos doesn't send that provider's token to Lunos Cloud: unless `cloud.endpoint` is set in your global or managed config, login prints `Session sync needs cloud.endpoint for your organisation's identity provider.` and registers nothing.

Only `lunos login` and `lunos sync on` register a device. If you signed in before session sync shipped, there is no registered device on your machine and nothing syncs until you run `lunos sync on` or `lunos login` again. See [Session sync](cloud-sync.md).

## Where the session is kept

| System                              | Kept in                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| macOS                               | the Keychain, as item `lunos-cloud`                                        |
| Linux with a keyring (GNOME, KDE)   | the Secret Service, via `secret-tool`                                      |
| Windows, or Linux without a keyring | `session.json` in Lunos's data directory, readable only by you (mode 0600) |

`LUNOS_CLOUD_STORE=file` forces the file, for example on a headless server.

**Signing out from elsewhere:** `lunos logout` revokes the session at the provider. To end a session from another device, sign out of it in your identity provider's account page. Lunos then reports the session as expired.

## Setting up the client in your identity provider

Register a **public** OAuth client (no client secret), with id `lunos-cli` or one you choose, and turn on the **device authorization grant**. In Keycloak, that's _Clients → Create → Client authentication: off_, then tick _OAuth 2.0 Device Authorization Grant_. Request the scopes `openid profile email offline_access`. Lunos refuses issuers that aren't `https://`, except `localhost` for testing.

## What Lunos stores

- **Stored:** the issuer, the client id, the tokens the provider issued, your e-mail address and subject id. These are kept as described above, on this machine only.
- **Never stored or seen:** your password and any second factor. They go only to the identity provider.
- **Not sent anywhere:** nothing. Lunos sends no sign-in data except to the issuer you configured.
