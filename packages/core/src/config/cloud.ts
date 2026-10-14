export * as ConfigCloud from "./cloud"

import { Schema } from "effect"

/**
 * XCOD-185: where `lunos login` signs in. By default that is Lunos Cloud's own identity provider,
 * https://auth.lunos.tech/realms/Lunos; organisations with their own set `issuer` to any OpenID
 * Connect provider that offers the device authorization grant. Declared in both config schemas. Lock
 * `cloud` with `$locked` to pin an organisation's provider.
 */
export const Info = Schema.Struct({
  issuer: Schema.String.pipe(Schema.optional).annotate({
    description: "OpenID Connect issuer URL that lunos login signs in to, e.g. https://id.example.eu/realms/lunos (default https://auth.lunos.tech/realms/Lunos)",
  }),
  client_id: Schema.String.pipe(Schema.optional).annotate({
    description: 'OAuth client id registered for the Lunos CLI at that issuer (default "lunos-cli")',
  }),
  // XCOD-186: no default until Lunos Cloud's control plane is live; `lunos run --cloud` needs it.
  endpoint: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Lunos Cloud control plane that lunos run --cloud dispatches runs to (https, or localhost for testing), e.g. https://cloud.lunos.tech",
  }),
  // XCOD-238: read from managed config only, so a repository can't send your sign-in to its host
  // and you can't point Lunos away from your organisation's policy.
  policy: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Your organisation's policy on its Lunos console, fetched at start while you're signed in (lunos login), e.g. https://console.example.eu/v1/orgs/acme/policy. Only read from managed config",
  }),
  // XCOD-241: read from managed and global (user) config, not a project's. An organisation keeps it
  // on with `"$locked": ["cloud.client_start"]` (or a lock on all of `cloud`).
  client_start: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Tell your organisation's Lunos console (cloud.policy) when Lunos starts: version, OS, architecture, surface, a random install id and the policy in effect (default true). Read from managed and user config only; your organisation can lock it on",
  }),
}).annotate({ identifier: "CloudConfig" })
export type Info = Schema.Schema.Type<typeof Info>
