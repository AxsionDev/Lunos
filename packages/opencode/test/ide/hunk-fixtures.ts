// XCOD-333: the shared fixtures for per-hunk accept/reject in the IDE plugins (sdks/ide/fixtures).
// Each fixture holds a file before and after an edit, the patch exactly as `GET /session/:id/diff`
// returns it (src/snapshot: full-file context, so one `@@` section per file), and the file that must
// result from each choice of accepted hunks. The JetBrains (Kotlin) and Visual Studio (C#) plugins
// test their hunk logic against these files, so the three agree.
//
// The expected results come from an independent path: jsdiff's own `applyPatch` of a zero-context
// patch (one hunk per change block) keeping only the accepted hunks.
//
// Regenerate: bun run packages/opencode/test/ide/hunk-fixtures.ts --write

import { applyPatch, formatPatch, structuredPatch } from "diff"
import path from "path"

export const dir = path.join(import.meta.dir, "../../../../sdks/ide/fixtures/hunks")

const inputs = [
  {
    name: "two-hunks",
    before:
      "using System;\n\nclass Calc {\n  int Add(int a, int b) { return a + b; }\n\n  int Sub(int a, int b) { return a - b; }\n\n  int Mul(int a, int b) { return a * b; }\n}\n",
    after:
      "using System;\n\nclass Calc {\n  int Add(int a, int b) => a + b;\n\n  int Sub(int a, int b) { return a - b; }\n\n  int Mul(int a, int b) => a * b;\n}\n",
  },
  {
    name: "three-hunks-add-remove",
    before: "a\nb\nc\nd\ne\nf\ng\nh\ni\n",
    after: "a\nB\nc\nd\nd2\ne\nf\nh\ni\n",
  },
  {
    name: "crlf",
    before: "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n",
    after: "one\r\nTWO\r\nthree\r\nfour\r\nFIVE\r\n",
  },
  {
    name: "no-trailing-newline",
    before: "first\nmiddle\nlast",
    after: "FIRST\nmiddle\nlast changed",
  },
  {
    name: "added-file",
    before: "",
    after: "new line 1\nnew line 2\n",
  },
  {
    name: "deleted-file",
    before: "gone 1\ngone 2\n",
    after: "",
  },
]

export function fixtures() {
  return inputs.map((input) => {
    const file = `src/${input.name}.txt`
    const patch = formatPatch(
      structuredPatch(file, file, input.before, input.after, "", "", { context: Number.MAX_SAFE_INTEGER }),
    )
    const blocks = structuredPatch(file, file, input.before, input.after, "", "", { context: 0 })
    const count = blocks.hunks.length
    // Every combination of accepted hunks: 2^count cases (count is small in these fixtures).
    const cases = Array.from({ length: 2 ** count }, (_, mask) => {
      const accept = Array.from({ length: count }, (_, i) => (mask & (1 << i)) !== 0)
      const expected = applyPatch(input.before, { ...blocks, hunks: blocks.hunks.filter((_, i) => accept[i]) })
      if (expected === false) throw new Error(`${input.name}: jsdiff could not apply ${accept}`)
      return { accept, expected }
    })
    return { name: input.name, file, before: input.before, after: input.after, patch, hunks: count, cases }
  })
}

if (import.meta.main && process.argv.includes("--write")) {
  for (const fixture of fixtures())
    await Bun.write(path.join(dir, `${fixture.name}.json`), JSON.stringify(fixture, null, 2) + "\n")
}
