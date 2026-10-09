export * as ConfigCloud from "./cloud"

import { Schema } from "effect"

/**
 * XCOD-185: where `lunos login` signs in. Lunos Cloud's own identity provider runs in the Phase 7
 * data centre; until then, and for organisations with their own, `issuer` is any OpenID Connect
 * provider that offers the device authorization grant. Declared in both config schemas. Lock
 * `cloud` with `$locked` to pin an organisation's provider.
 */
export const Info = Schema.Struct({
  issuer: Schema.String.pipe(Schema.optional).annotate({
    description: "OpenID Connect issuer URL that lunos login signs in to, e.g. https://id.example.eu/realms/lunos",
  }),
  client_id: Schema.String.pipe(Schema.optional).annotate({
    description: 'OAuth client id registered for the Lunos CLI at that issuer (default "lunos-cli")',
  }),
  // XCOD-186: no default until Lunos Cloud's control plane is live; `lunos run --cloud` needs it.
  endpoint: Schema.String.pipe(Schema.optional).annotate({
    description:
      "Lunos Cloud control plane that lunos run --cloud dispatches runs to (https, or localhost for testing), e.g. https://cloud.lunos.tech",
  }),
}).annotate({ identifier: "CloudConfig" })
export type Info = Schema.Schema.Type<typeof Info>
