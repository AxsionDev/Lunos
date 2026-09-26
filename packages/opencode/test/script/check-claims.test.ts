import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { claimTable, compare, forbidden } from "../../../../script/check-claims"

const table = (rows: string[]) => ["| Claim | True today? | Basis |", "| --- | --- | --- |", ...rows].join("\n")

describe("claim-table consistency (XCOD-108)", () => {
  test("the repository's documents agree with the decision record", async () => {
    const root = path.resolve(import.meta.dir, "../../../..")
    const result = await $`bun script/check-claims.ts`.cwd(root).nothrow().quiet()
    expect(result.stderr.toString()).toBe("")
    expect(result.exitCode).toBe(0)
  })

  test("a changed verdict is caught; basis wording may differ", () => {
    const source = claimTable(
      table(["| The vendor is EU-incorporated | **Yes** | XCOD-17 |", "| _Lunos-operated_ infra | **N/A** | none |"]),
    )
    expect(
      compare(
        source,
        claimTable(
          table([
            "| The vendor is EU-incorporated | **Yes** | different words |",
            "| Lunos-operated infra | **N/A** | x |",
          ]),
        ),
      ),
    ).toEqual([])
    expect(
      compare(
        source,
        claimTable(table(["| The vendor is EU-incorporated | **No** | x |", "| Lunos-operated infra | **N/A** | x |"])),
      ),
    ).toEqual(['"the vendor is eu-incorporated": the decision record says yes, this document says no'])
  })

  test("a claim added or dropped in a copy is caught", () => {
    const source = claimTable(table(["| A | **Yes** | x |"]))
    expect(compare(source, claimTable(table(["| B | **Yes** | x |"])))).toEqual([
      'missing claim: "a"',
      'claim not in the decision record: "b"',
    ])
  })

  test("forbidden wording is flagged, except where a wording rule states it", () => {
    expect(forbidden("Lunos runs on EU-sovereign infrastructure.").map((hit) => hit.number)).toEqual([1])
    expect(forbidden('- ❌ "sovereign cloud" — not claimed')).toEqual([])
    expect(forbidden("Lunos is CRA-certified")).toHaveLength(1)
  })
})
