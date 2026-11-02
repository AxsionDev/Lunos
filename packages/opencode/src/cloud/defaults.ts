export * as CloudDefaults from "./defaults"

/** Lunos's own identity provider (Keycloak, realm Lunos). `cloud.issuer` overrides it. */
export const DEFAULT_ISSUER = "https://auth.lunos.tech/realms/Lunos"
/** Lunos Cloud's control plane, where sessions sync. Only global or managed `cloud.endpoint` overrides it. */
export const DEFAULT_ENDPOINT = "https://cloud.lunos.tech"
