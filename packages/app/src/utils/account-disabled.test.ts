import { describe, expect, test } from "bun:test"
import { dict as en } from "@/i18n/en"
import { disabledLines, parseAccount } from "./account-disabled"

const t = (key: string, params?: Record<string, string>) =>
  Object.entries(params ?? {}).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, value),
    (en as Record<string, string>)[key] ?? key,
  )

describe("XCOD-312: the disabled-account notice", () => {
  test("the server's answer: disabled with a category and an end, without them, or not at all", () => {
    expect(parseAccount({ disabled: { category: "payment", until: "2026-12-01T00:00:00.000Z" } })).toEqual({
      category: "payment",
      until: "2026-12-01T00:00:00.000Z",
    })
    expect(parseAccount({ disabled: {} })).toEqual({})
    expect(parseAccount({})).toBeUndefined()
    expect(parseAccount(undefined)).toBeUndefined()
    // An older server's 404 body, or anything malformed.
    expect(parseAccount("Not Found")).toBeUndefined()
    expect(parseAccount({ disabled: { category: "sanctions", until: "soon" } })).toEqual({})
  })

  test("the lines say the category in words and the end date, as the TUI does; never a free-text reason", () => {
    expect(disabledLines({ category: "offboarding", until: "2026-12-01T00:00:00.000Z" }, t)).toEqual([
      "Reason: Your organisation offboarded you",
      "Until 2026-12-01",
    ])
    expect(disabledLines({ category: "abuse" }, t)).toEqual(["Reason: Abuse or misuse of the service"])
    expect(disabledLines({}, t)).toEqual([])
  })

  test("the English category words are the TUI's (packages/tui/src/util/account.ts DISABLED_CATEGORY_TEXT)", () => {
    expect(
      ["abuse", "security", "terms", "payment", "offboarding", "other"].map((c) => t(`account.disabled.category.${c}`)),
    ).toEqual([
      "Abuse or misuse of the service",
      "A security concern",
      "A breach of the terms of service",
      "A payment issue",
      "Your organisation offboarded you",
      "Other",
    ])
  })
})
