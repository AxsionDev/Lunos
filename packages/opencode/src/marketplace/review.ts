// XCOD-105: what the installer does with an entry's review block, in one place for every surface
// (`marketplace install`, `mcp add <name>`).
//
// - A `verified` entry installs at its `reviewed_version`. For an npm plugin with an `integrity`
//   value, that value must equal the registry's `dist.integrity` for the pinned version, or the
//   install is refused. npm/bun then check the downloaded tarball against the same value, so the
//   chain runs from the reviewed hash to the bytes on disk. It covers npm plugin installs only:
//   an MCP server started with npx/uvx/docker fetches its code when it starts, not at install.
// - Anything else (a `community` entry, or no review block at all) needs `--allow-unreviewed`,
//   which organisation policy can lock off (`marketplace_unreviewed: false`, XCOD-102).
// - "Verified" is what the manifest's owner asserts, so the preview says whose assertion it is.

import type { Marketplace } from "@opencode-ai/core/marketplace"
import type { ContentItem } from "./content"
import { MarketplaceRefusal } from "./guard"

export type Status = "verified" | "community" | "unreviewed"

type Curated = { review?: Marketplace.Review; license?: string; integrity?: string; egress?: readonly string[] }

function curation(item: ContentItem): Curated {
  return item.entry as Curated
}

export function status(item: ContentItem): Status {
  return curation(item).review?.status ?? "unreviewed"
}

/** Preview lines: who vouches for the entry, its licence and what it declares it contacts. */
export function describe(item: ContentItem, source?: string): string[] {
  const { review, license, egress } = curation(item)
  const by = `${item.marketplace}${source ? ` (${source})` : ""}`
  const lines = [
    review?.status === "verified"
      ? `review: verified by ${by}` +
        [
          review.reviewer && `reviewer ${review.reviewer}`,
          review.reviewed_at,
          review.reviewed_version && `version ${review.reviewed_version}`,
        ]
          .filter(Boolean)
          .map((part) => `, ${part}`)
          .join("")
      : review?.status === "community"
        ? `review: community entry, not reviewed (listed by ${by})`
        : `review: none (the manifest carries no review for this entry)`,
  ]
  if (license) lines.push(`licence: ${license}`)
  lines.push(`declared network access: ${egress?.length ? egress.join(", ") : "none declared"}`)
  return lines
}

export class ReviewRefusal extends MarketplaceRefusal {
  constructor(
    message: string,
    readonly key?: string,
  ) {
    super(message)
  }
}

/** Throws unless the entry may be installed with the flags and policy given. */
export function gate(item: ContentItem, input: { allowUnreviewed: boolean; policyForbidsUnreviewed: boolean }) {
  if (status(item) === "verified") return
  if (!input.allowUnreviewed)
    throw new ReviewRefusal(
      `${item.marketplace}/${item.name} is ${status(item) === "community" ? "a community entry" : "not reviewed"}: it hasn't been checked against the marketplace's review criteria. To install it anyway, pass --allow-unreviewed.`,
    )
  if (input.policyForbidsUnreviewed)
    throw new ReviewRefusal(
      `--allow-unreviewed is not allowed here: marketplace_unreviewed is set by your organisation's policy.`,
      "marketplace_unreviewed",
    )
}

export type RegistryLookup = (pkg: string, version: string) => Promise<string | undefined>

/**
 * The npm spec to install for a plugin entry: pinned to `reviewed_version`, else to the listed
 * `source.version`, after checking `integrity` against the registry. Throws on a mismatch.
 */
export async function pinnedSpec(item: ContentItem & { kind: "plugin" }, lookup: RegistryLookup) {
  const { review, integrity } = curation(item)
  const source = item.entry.source
  // The reviewed version for a verified entry; otherwise the version the catalogue recorded
  // (`source.version`), which pins what was listed without implying it was reviewed.
  const version = review?.reviewed_version ?? (source.type === "npm" ? source.version : undefined)
  if (source.type !== "npm" || !version) return item.spec
  if (integrity) {
    const actual = await lookup(source.package, version)
    if (actual !== integrity)
      throw new ReviewRefusal(
        `Refused: the registry's integrity for ${source.package}@${version} is ${actual ?? "missing"}, but the reviewed integrity is ${integrity}. The package may have been republished or tampered with.`,
      )
  }
  return `${source.package}@${version}`
}

/** `dist.integrity` of `pkg@version` from the registry npm uses here. */
export function registryLookup(registry: string): RegistryLookup {
  return async (pkg, version) => {
    const url = `${registry.replace(/\/$/, "")}/${pkg.replace("/", "%2F")}/${encodeURIComponent(version)}`
    const response = await fetch(url, { headers: { accept: "application/json" } }).catch(() => undefined)
    if (!response?.ok) return undefined
    const data = (await response.json().catch(() => undefined)) as { dist?: { integrity?: string } } | undefined
    return data?.dist?.integrity
  }
}
