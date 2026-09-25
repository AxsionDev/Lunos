import { describe, expect, test } from "bun:test"
import { Marketplace } from "@opencode-ai/core/marketplace"
import * as MarketplaceReview from "../../src/marketplace/review"
import type { ContentItem } from "../../src/marketplace/content"

const plugin = (review?: object, extra: object = {}) =>
  ({
    kind: "plugin",
    name: "p",
    marketplace: "mp",
    source: "mp.json",
    spec: "pkg",
    entry: Marketplace.decode({
      name: "mp",
      owner: { name: "o" },
      plugins: [{ name: "p", source: { type: "npm", package: "pkg" }, ...(review ? { review } : {}), ...extra }],
    }).plugins[0],
  }) as unknown as ContentItem & { kind: "plugin" }

const verified = { status: "verified", reviewed_version: "1.2.3", reviewer: "Jane Doe", reviewed_at: "2026-09-25" }
const INTEGRITY = "sha512-good"

describe("marketplace review (XCOD-105)", () => {
  test("a verified entry installs without the flag", () => {
    expect(() =>
      MarketplaceReview.gate(plugin(verified), { allowUnreviewed: false, policyForbidsUnreviewed: false }),
    ).not.toThrow()
  })

  test("community and unreviewed entries need --allow-unreviewed", () => {
    for (const item of [plugin({ status: "community" }), plugin()]) {
      expect(() => MarketplaceReview.gate(item, { allowUnreviewed: false, policyForbidsUnreviewed: false })).toThrow(
        "--allow-unreviewed",
      )
      expect(() =>
        MarketplaceReview.gate(item, { allowUnreviewed: true, policyForbidsUnreviewed: false }),
      ).not.toThrow()
    }
  })

  test("a locked policy refuses --allow-unreviewed, naming the key", () => {
    try {
      MarketplaceReview.gate(plugin({ status: "community" }), { allowUnreviewed: true, policyForbidsUnreviewed: true })
      throw new Error("expected a refusal")
    } catch (error) {
      expect(error).toBeInstanceOf(MarketplaceReview.ReviewRefusal)
      expect((error as MarketplaceReview.ReviewRefusal).key).toBe("marketplace_unreviewed")
    }
  })

  test("a verified npm entry installs at its reviewed version when the registry's integrity matches", async () => {
    const asked: string[] = []
    const spec = await MarketplaceReview.pinnedSpec(plugin(verified, { integrity: INTEGRITY }), async (pkg, v) => {
      asked.push(`${pkg}@${v}`)
      return INTEGRITY
    })
    expect(spec).toBe("pkg@1.2.3")
    expect(asked).toEqual(["pkg@1.2.3"])
  })

  test("a community entry is pinned to its listed version and integrity-checked too", async () => {
    const item = plugin({ status: "community" }, { integrity: INTEGRITY })
    ;(item.entry.source as { version?: string }).version = "0.9.0"
    expect(await MarketplaceReview.pinnedSpec(item, async () => INTEGRITY)).toBe("pkg@0.9.0")
    await expect(MarketplaceReview.pinnedSpec(item, async () => "sha512-other")).rejects.toThrow("integrity")
  })

  test("a tampered integrity is refused", async () => {
    await expect(
      MarketplaceReview.pinnedSpec(plugin(verified, { integrity: INTEGRITY }), async () => "sha512-other"),
    ).rejects.toThrow("integrity")
  })

  test("the preview says whose assertion 'verified' is, and what the entry declares it contacts", () => {
    const lines = MarketplaceReview.describe(
      plugin(verified, { license: "MIT", egress: ["api.example.com"] }),
      "https://x/m.json",
    )
    expect(lines[0]).toBe("review: verified by mp (https://x/m.json), reviewer Jane Doe, 2026-09-25, version 1.2.3")
    expect(lines).toContain("licence: MIT")
    expect(lines).toContain("declared network access: api.example.com")
    expect(MarketplaceReview.describe(plugin())[0]).toContain("review: none")
  })

  test("older manifests without curation fields still decode", () => {
    expect(plugin().entry).toMatchObject({ name: "p" })
  })
})
