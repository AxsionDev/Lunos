import { describe, expect, test } from "bun:test"
import stripAnsi from "strip-ansi"

import { NO_ACCOUNT_SERVER, formatAccountLabel, formatOrgLine } from "../../src/cli/cmd/account"

describe("console account display", () => {
  test("has no default login URL and says why", () => {
    expect(NO_ACCOUNT_SERVER).toContain("Lunos Cloud accounts aren't available yet")
    expect(NO_ACCOUNT_SERVER).not.toContain("opencode.ai")
  })

  test("includes the account url in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, false))).toBe(
      "one@example.com https://one.example.com",
    )
  })

  test("includes the active marker in account labels", () => {
    expect(stripAnsi(formatAccountLabel({ email: "one@example.com", url: "https://one.example.com" }, true))).toBe(
      "one@example.com https://one.example.com (active)",
    )
  })

  test("includes the account url in org rows", () => {
    expect(
      stripAnsi(
        formatOrgLine({ email: "one@example.com", url: "https://one.example.com" }, { id: "org-1", name: "One" }, true),
      ),
    ).toBe("  ● One  one@example.com  https://one.example.com  org-1")
  })
})
