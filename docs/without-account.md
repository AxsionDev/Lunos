# Using Lunos without an account (self-hosted, offline, CI)

The official distribution asks for a [free Lunos account](account.md) at start. That requirement is a setting of the official build, and it is skipped in each case below. When one applies, there is no Welcome screen, and Lunos makes **no call to `auth.lunos.tech` or any other Lunos service** for an account. Every local feature works the same.

| Case                            | How                                                                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Your organisation turns it off  | Managed config: `"auth": { "required": false }`. Only managed config is read for it, so a repository can't change it; `"$locked": ["auth"]` is accepted too.             |
| Your organisation's own sign-in | Managed config sets `"cloud": { "issuer": "https://id.example.eu/realms/acme" }`. `/login` and `lunos login` then sign in there; Lunos's own sign-in is never contacted. |
| Offline or air-gapped           | `LUNOS_OFFLINE=1`. Or simply no network at start: Lunos shows `Offline: sign in later with /login` once, and starts.                                                     |
| CI and scripts                  | `lunos run`, a non-interactive terminal (pipes, redirected output) or `CI=true` never ask.                                                                               |
| Built from source               | A build from source doesn't require an account. `LUNOS_AUTH_REQUIRED=1` turns the requirement on in one, to try it.                                                      |

Managed config is the `managed.json` in the system's managed config directory, or the macOS MDM profile; see the [self-hosted deployment guide](deployment/self-hosted.md).

## Cloud features in CI

Cloud features (cloud runs, session sync, team features) need a sign-in. Where nobody can sign in, set `LUNOS_TOKEN` to an access token for the account. Lunos uses it as is, without storing or refreshing it; when it expires, cloud features fail with `LUNOS_TOKEN has expired or was refused; set a fresh one`. Without a token, they fail with:

```
A cloud run needs a Lunos Cloud sign-in. Run lunos login, or set LUNOS_TOKEN where nobody can sign in (CI).
```

## How the official build is marked

The release pipeline builds the official distribution with `LUNOS_OFFICIAL_BUILD=1` (see `.github/workflows/publish.yml`). The code that reads it, `packages/opencode/src/cloud/gate.ts`, is open like the rest of Lunos.
