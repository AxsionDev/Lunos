// XCOD-127: upstream's command descriptions call the product "opencode" ("start opencode tui",
// "run opencode with a message"). Rewriting them in upstream's command files would add merge
// conflicts to every weekly upstream sync (XCOD-118), so the help text is rebranded here, on its way
// out, like the docs site's build-time rebrand (packages/web/lunos/rebrand.ts).
//
// Only the bare lowercase word changes. Identifiers the binary still reads stay as they are:
// `opencode.json`, `opencode.local`, `.opencode/`, `OPENCODE_*`, paths such as
// `packages/opencode`, and quoted values such as the default username `'opencode'`.

/** "opencode" as a standalone word: not part of a name, path, file, env var or quoted value. */
const PRODUCT = /(?<![\w./\\'"`-])opencode(?![\w./\\'"`-])/g

export function brandHelp(text: string) {
  // yargs pads each row so a column (`[string]`, `[default]`) lines up. Keep it lined up by giving
  // the three characters "opencode" loses to the first run of padding after the renamed word.
  return text
    .split("\n")
    .map((line) => {
      let out = line
      for (let match = PRODUCT.exec(out); match; match = PRODUCT.exec(out)) {
        const end = match.index + "Lunos".length
        out = out.slice(0, match.index) + "Lunos" + out.slice(match.index + match[0].length)
        const pad = / {2,}(?=\S)/.exec(out.slice(end))
        if (pad) {
          const at = end + pad.index
          out = out.slice(0, at) + "   " + out.slice(at)
        }
        PRODUCT.lastIndex = end
      }
      PRODUCT.lastIndex = 0
      return out
    })
    .join("\n")
}
