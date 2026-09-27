export * as Jurisdiction from "./jurisdiction"

/**
 * Where a provider processes data, and what that claim actually rests on (XCOD-61).
 *
 * This is a side table, deliberately. Provider plugins are `{ id, effect }` (see
 * `plugin/internal.ts`) and `add()` rebuilds that object, passing only `id` and `effect`
 * onward — any extra field on a plugin is silently dropped. So jurisdiction cannot live on
 * the plugin object, and this table is keyed by provider id instead.
 *
 * It is also keyed by *provider* id rather than *plugin* id because those are different
 * namespaces. There are ~34 provider plugins, but the catalog (models.dev) carries 222
 * providers. The EU-sovereign options that matter most here — Scaleway, OVHcloud, Hetzner —
 * have no plugin of their own: they are catalog entries dispatched through the generic
 * `openai-compatible` plugin. A plugin-keyed table would miss them entirely.
 *
 * XCOD-62 builds residency policy enforcement on this data.
 */

/**
 * Where the provider processes request data by default.
 *
 * `configurable` is not a hedge — it is the honest answer for hyperscalers whose region is a
 * deployment choice. Azure, Bedrock and Vertex all *can* run in the EU and all default to a US
 * region. Tagging them `eu` would be the overclaim XCOD-55 ruled out; tagging them `us` would
 * understate a real capability. Callers enforcing a residency policy must treat `configurable`
 * as "not EU unless the deployment proves it" — see `isEuByDefault`.
 */
export type Region = "eu" | "us" | "other" | "configurable" | "unknown"

/**
 * What the `region` claim is actually grounded in. This is the field that stops the table
 * being marketing: "EU" can mean the data is processed in the EU, or merely that the vendor is
 * an EU legal entity, and those are very different guarantees to a procurement reviewer.
 */
export type Basis =
  /** Data is processed in the EU. Says nothing about who owns the company. */
  | "processing"
  /** The vendor is an EU legal entity. Says nothing about where data is processed. */
  | "entity"
  /** Both of the above. The only combination that supports an unqualified EU claim. */
  | "both"
  /** Determined by deployment configuration (region choice), not by the provider. */
  | "user-configured"
  /** Determined by whatever endpoint the user pointed at. We cannot know. */
  | "user-endpoint"
  /** A gateway: the real jurisdiction is that of whatever it routes to. */
  | "gateway"
  /** No EU claim is made. */
  | "none"

export interface Claim {
  readonly region: Region
  readonly basis: Basis
  /** What is actually true, in a form a reviewer can check. Never marketing. */
  readonly note: string
  /** Present when an EU option exists but is not the default. */
  readonly euOption?: string
}

const UNKNOWN: Claim = {
  region: "unknown",
  basis: "none",
  note: "No jurisdiction recorded for this provider.",
}

/**
 * Keyed by provider id. Every provider *plugin* id appears here (enforced by test), plus the
 * catalog providers with a meaningful EU story.
 *
 * Accuracy rule for anyone editing: state only what can be checked. If you are unsure whether
 * a vendor processes in the EU or merely is an EU company, that is `entity`, not `both`.
 */
const CLAIMS: Record<string, Claim> = {
  // ---------------------------------------------------------------------------------------
  // EU-sovereign: EU entity and EU processing.
  // ---------------------------------------------------------------------------------------
  mistral: {
    region: "eu",
    basis: "both",
    note: "Mistral AI is a French company and its own API serves EU-hosted inference. Note this is the direct Mistral API only — Mistral models served via Azure or Bedrock inherit that platform's region instead, and are covered by the `azure` / `amazon-bedrock` rows.",
  },
  scaleway: {
    region: "eu",
    basis: "both",
    note: "Scaleway is a French company (Iliad group); its Generative APIs run in French data centres. Reached through the generic openai-compatible plugin, not a dedicated one.",
  },
  ovhcloud: {
    region: "eu",
    basis: "both",
    note: "OVHcloud is a French company; AI Endpoints run in its EU data centres. Reached through the generic openai-compatible plugin.",
  },
  hetzner: {
    region: "eu",
    basis: "both",
    note: "Hetzner Online GmbH is a German company; its inference offering runs on its own German infrastructure. Reached through the generic openai-compatible plugin.",
  },
  "sap-ai-core": {
    region: "configurable",
    basis: "entity",
    note: "SAP SE is a German company, so the entity claim is solid. Processing location depends on which BTP region the deployment uses, and SAP operates non-EU regions too — so the entity being European does not by itself make the data EU-resident.",
    euOption: "Provision SAP AI Core in an EU BTP region (e.g. eu10/eu11).",
  },

  // ---------------------------------------------------------------------------------------
  // Region is a deployment choice. Default is not EU.
  // ---------------------------------------------------------------------------------------
  azure: {
    region: "configurable",
    basis: "user-configured",
    note: "Microsoft is a US entity, but Azure OpenAI processing location follows the resource's region. EU regions exist and are a genuine option; the region comes from the endpoint URL the deployment is pointed at, so residency is the deployer's choice, not a property of this provider.",
    euOption:
      "Create the Azure OpenAI resource in an EU region (e.g. swedencentral, francecentral, germanywestcentral) and use that resource's endpoint.",
  },
  "azure-cognitive-services": {
    region: "configurable",
    basis: "user-configured",
    note: "Same as `azure`: processing follows the Cognitive Services resource's region, chosen at provisioning time.",
    euOption: "Provision the Cognitive Services resource in an EU region.",
  },
  "amazon-bedrock": {
    region: "configurable",
    basis: "user-configured",
    note: "AWS is a US entity; Bedrock processing follows the AWS region in use. eu-* regions are available. Beware cross-region inference profiles, which can route a request outside the region you selected.",
    euOption:
      "Set AWS_REGION to an eu-* region (e.g. eu-central-1, eu-west-1) and avoid cross-region inference profiles.",
  },
  "google-vertex": {
    region: "configurable",
    basis: "user-configured",
    note: "Google is a US entity; Vertex AI processing follows the configured location. europe-* locations are available.",
    euOption: "Set the Vertex location to a europe-* region (e.g. europe-west4).",
  },
  "google-vertex-anthropic": {
    region: "configurable",
    basis: "user-configured",
    note: "Anthropic models served through Vertex AI; processing follows the configured Vertex location, as for `google-vertex`.",
    euOption: "Set the Vertex location to a europe-* region.",
  },
  "snowflake-cortex": {
    region: "configurable",
    basis: "user-configured",
    note: "Snowflake is a US entity; Cortex inference runs in the account's deployment region, which may be an EU region. Cross-region inference must be disabled for the region choice to hold.",
    euOption: "Use a Snowflake account in an EU deployment region and disable cross-region inference.",
  },
  nebius: {
    region: "configurable",
    basis: "entity",
    note: "Nebius Group N.V. is registered in the Netherlands following its separation from Yandex, and operates EU data centres — but it also operates elsewhere, and the corporate history warrants stating the entity claim rather than an unqualified EU-processing one. Verify the serving region before relying on this for residency.",
    euOption: "Confirm with Nebius which region serves your account.",
  },

  // ---------------------------------------------------------------------------------------
  // US processing.
  // ---------------------------------------------------------------------------------------
  anthropic: { region: "us", basis: "processing", note: "US company, US-hosted inference on the direct API." },
  openai: {
    region: "us",
    basis: "processing",
    note: "US company. EU data residency exists for some enterprise agreements but is not what this provider entry uses.",
  },
  google: {
    region: "us",
    basis: "processing",
    note: "Google Gemini direct API (not Vertex). US-operated; no region selection here — use `google-vertex` if residency matters.",
  },
  groq: { region: "us", basis: "processing", note: "US company, US-hosted inference." },
  cerebras: { region: "us", basis: "processing", note: "US company, US-hosted inference." },
  deepinfra: { region: "us", basis: "processing", note: "US company." },
  togetherai: { region: "us", basis: "processing", note: "US company." },
  perplexity: { region: "us", basis: "processing", note: "US company." },
  xai: { region: "us", basis: "processing", note: "US company." },
  nvidia: { region: "us", basis: "processing", note: "US company (NVIDIA NIM / integrate.api.nvidia.com)." },
  vercel: {
    region: "us",
    basis: "processing",
    note: "Vercel is a US company; its AI gateway routes onward to upstream providers.",
  },
  "github-copilot": { region: "us", basis: "processing", note: "GitHub/Microsoft, US-operated for this endpoint." },
  gitlab: {
    region: "us",
    basis: "processing",
    note: "GitLab Inc. is a US company. GitLab Dedicated regions do not apply to this provider path.",
  },
  venice: {
    region: "us",
    basis: "processing",
    note: "US company. Privacy-focused, which is not the same property as EU residency.",
  },
  kilo: { region: "us", basis: "processing", note: "US-operated gateway service." },
  cohere: {
    region: "other",
    basis: "entity",
    note: "Cohere is a Canadian company. Canada holds an EU adequacy decision for commercial organisations, which is not the same as EU residency — do not present it as EU.",
  },
  alibaba: {
    region: "other",
    basis: "processing",
    note: "Alibaba Cloud (Model Studio). Processing in China unless an international region is used; treat as non-EU.",
  },
  zenmux: {
    region: "other",
    basis: "none",
    note: "Aggregator endpoint; operating jurisdiction not established. Treat as non-EU.",
  },

  // ---------------------------------------------------------------------------------------
  // Cloudflare.
  // ---------------------------------------------------------------------------------------
  "cloudflare-workers-ai": {
    region: "other",
    basis: "processing",
    note: "Cloudflare is a US entity and Workers AI executes at whichever edge location serves the request. Pinning compute to the EU requires Cloudflare's Enterprise-tier Regional Services; it is not available by default.",
  },
  "cloudflare-ai-gateway": {
    region: "unknown",
    basis: "gateway",
    note: "A proxy. The effective jurisdiction is that of the upstream provider it routes to, plus Cloudflare edge handling in transit. Evaluate the upstream provider's row, not this one.",
  },

  // ---------------------------------------------------------------------------------------
  // Gateways and user-defined endpoints — no jurisdiction of their own.
  // ---------------------------------------------------------------------------------------
  openrouter: {
    region: "unknown",
    basis: "gateway",
    note: "Routes to many upstream providers, selected per request and possibly per availability. No single jurisdiction can be asserted.",
  },
  gateway: {
    region: "unknown",
    basis: "gateway",
    note: "Vercel AI Gateway. Jurisdiction is that of the upstream provider it routes to.",
  },
  llmgateway: {
    region: "unknown",
    basis: "gateway",
    note: "Aggregating gateway. Jurisdiction is that of the upstream provider it routes to.",
  },
  opencode: {
    region: "unknown",
    basis: "gateway",
    note: "Upstream opencode's hosted gateway. Jurisdiction is that of the upstream provider it routes to.",
  },
  "openai-compatible": {
    region: "unknown",
    basis: "user-endpoint",
    note: "Generic adapter for any OpenAI-compatible endpoint. Jurisdiction is whatever the configured baseURL resolves to — including EU providers such as Scaleway, OVHcloud and Hetzner, which have their own rows. Cannot be determined from the plugin alone.",
  },
  "dynamic-provider": {
    region: "unknown",
    basis: "user-endpoint",
    note: "Provider defined at runtime from user configuration. Jurisdiction cannot be determined statically.",
  },
}

/**
 * Session-share upload targets (XCOD-80), evaluated by the residency policy like a provider.
 * Kept out of `CLAIMS` so they don't appear in the provider jurisdiction table.
 */
export const SHARE_OPNCD = "share:opncd"
export const SHARE_ENTERPRISE = "share:enterprise"
const SHARE_HOSTS: Record<string, Claim> = {
  [SHARE_OPNCD]: {
    region: "us",
    basis: "entity",
    note: "Upstream opencode's hosted share service (opncd.ai, and the opencode console's share API for signed-in orgs), operated by opencode's maintainers, a non-EU company. Not Lunos infrastructure.",
  },
  [SHARE_ENTERPRISE]: {
    region: "unknown",
    basis: "user-endpoint",
    note: 'A share server at the configured enterprise.url. Tagged like any other self-hosted endpoint: its jurisdiction is wherever you host it, which Lunos can\'t verify, so allowing it under a residency policy takes an explicit "unknown" in residency.allow.',
  },
}

/** Look up a provider's jurisdiction claim. Unknown providers are `unknown`/`none`, never assumed safe. */
export function lookup(providerID: string): Claim {
  return CLAIMS[providerID] ?? SHARE_HOSTS[providerID] ?? UNKNOWN
}

/** Whether a claim is recorded for this provider at all. */
export function isTagged(providerID: string): boolean {
  return providerID in CLAIMS || providerID in SHARE_HOSTS
}

/**
 * Whether a provider processes in the EU *without* the deployer having to configure anything.
 *
 * `configurable` providers return `false` on purpose. Azure can be EU, but a residency policy
 * cannot verify from here that a given deployment actually pointed it at an EU region — so
 * treating it as EU would let a US-region Azure resource through a policy that claims to block
 * one. Fail closed; let the deployment opt in explicitly if it can prove the region.
 */
export function isEuByDefault(providerID: string): boolean {
  return lookup(providerID).region === "eu"
}

/** All provider ids carrying a recorded claim. */
export function taggedProviders(): string[] {
  return Object.keys(CLAIMS)
}

/** Provider ids that are EU-resident by default, for surfacing EU options to a user. */
export function euProviders(): string[] {
  return Object.keys(CLAIMS).filter((id) => CLAIMS[id]!.region === "eu")
}
