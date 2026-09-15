import path from "path"
import { readFileSync } from "fs"
import { Marketplace } from "@opencode-ai/core/marketplace"
import { SEED_SOURCE, type ManifestJson, type RegistryWriteDb } from "./db"

/**
 * F-002's seed script: load the repo-root `marketplace.json` into D1.
 *
 * VALUE import of `@opencode-ai/core/marketplace` is correct HERE and only here — this
 * file runs under Bun, never inside the Worker, so pulling `effect` in for
 * `Marketplace.decode` costs the Worker bundle nothing (contracts §5, gotcha #3).
 * `src/index.ts` and `src/handlers/**` stay type-only.
 */

/**
 * The repo-root seed manifest, three levels up from `packages/registry/src`. Resolved
 * against `import.meta.dir` rather than `process.cwd()` so the script behaves identically
 * whether it is run from the repo root, from the package directory, or by a test runner —
 * same convention as `packages/core/test/marketplace.test.ts`.
 */
export const SEED_MANIFEST_PATH = path.join(import.meta.dir, "../../../marketplace.json")

/**
 * Decode-before-write gate (F-002's AC). PURE of filesystem I/O: the caller supplies the
 * already-read JSON, so the "invalid manifest => zero writes" test needs no fixture file
 * on disk and no D1.
 *
 * `Marketplace.decode` throws on any schema violation, and it is called BEFORE `db` is
 * touched at all — so a rejected manifest leaves the database in its prior state. This is
 * the only point in the system where schema-invalid seed data can be caught: a Worker has
 * no startup/boot hook.
 */
export async function runSeed(data: unknown, db: RegistryWriteDb): Promise<{ manifest: ManifestJson }> {
  // Throws on invalid input. Nothing below this line runs in that case.
  const manifest = Marketplace.decode(data)

  await db.replaceMarketplace({ manifest, source: SEED_SOURCE })

  return { manifest }
}

/**
 * The real D1 write transport. DEFERRED — deliberately unimplemented in F-002.
 *
 * This story is 100% local: it has no D1 database to talk to, no account ID, no API token
 * and no database UUID, so a "real" implementation here could only ever be untested code.
 * Wiring it up belongs to the deploy step, once F-001's database actually exists.
 *
 * Contracts §2.4 fixes the two candidate transports, both consuming exactly the
 * `buildReplaceStatements` output produced below:
 *
 *  1. Cloudflare D1 HTTP query API (`POST …/d1/database/{uuid}/query`, body `{ sql, params }`)
 *     — RECOMMENDED. It preserves parameter binding, so the seed's free-text descriptions
 *     never pass through hand-rolled SQL quoting, and its wire shape already matches
 *     `Statement`. Needs CLOUDFLARE_ACCOUNT_ID, an API token, and the database UUID.
 *  2. `wrangler d1 execute <db> --remote --file=…` over a generated `.sql` file — simpler
 *     credentials story, but NO parameter binding, so every string literal would have to be
 *     escaped by hand. Flagged as the riskier option.
 *
 * Whichever is chosen, the statement list must be applied as ONE batch/transaction (D1's
 * HTTP API accepts a multi-statement body; the Worker-side equivalent is `db.batch(...)`),
 * because F-002's AC forbids a partial-write state if the run fails mid-way.
 */
export function d1HttpWriteDb(): RegistryWriteDb {
  return {
    async replaceMarketplace(_input) {
      // A real implementation calls `buildReplaceStatements(_input)` here and applies the
      // result as one transaction. Deliberately NOT called yet: building a statement list
      // only to discard it is dead work, and quoting its length in the error below would
      // dress an unwired transport up as though it had done something.
      throw new Error(
        "the manifest decoded successfully, but the D1 write transport is not implemented yet " +
          "(deferred to deploy time — see contracts §2.4). Nothing was written.",
      )
    },
  }
}

/** CLI entry point. Reads the seed file, then delegates to `runSeed`. */
async function main(): Promise<void> {
  let data: unknown
  try {
    data = JSON.parse(readFileSync(SEED_MANIFEST_PATH, "utf8"))
  } catch (error) {
    console.error(`seed: could not read ${SEED_MANIFEST_PATH}`)
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }

  try {
    const { manifest } = await runSeed(data, d1HttpWriteDb())
    console.log(`seed: wrote marketplace '${manifest.name}' with ${manifest.plugins.length} plugins`)
  } catch (error) {
    // Covers both the decode failure (nothing written — D1 left in its prior state) and a
    // transport failure. Either way the process exits non-zero with the reason visible.
    console.error("seed: aborted, no rows were written")
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

if (import.meta.main) await main()
