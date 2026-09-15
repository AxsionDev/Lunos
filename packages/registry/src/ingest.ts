import type { IngestionSourceDb, ManifestJson, RegistryWriteDb } from "./db"

/** One source's outcome for one ingestion run. `manifest` is present only when `ok`. */
export type SourceResolution =
  | { readonly source: string; readonly ok: true; readonly manifest: ManifestJson }
  | { readonly source: string; readonly ok: false; readonly error: string }

export interface IngestionResult {
  readonly resolutions: readonly SourceResolution[]
}

export interface IngestionDeps {
  readonly sources: IngestionSourceDb
  readonly write: RegistryWriteDb
  /** Fetches and decodes one source's manifest. Throws on any failure — network, HTTP
   * status, or schema — which `runIngestion` catches per-source (contracts note above). */
  readonly resolve: (source: string) => Promise<ManifestJson>
  /** XCOD-35's "ingestion failures are logged/observable" AC. Called once per source,
   * success or failure — a Cloudflare Worker's `console.log`/`console.error` output is
   * what `wrangler tail`/the dashboard surface, so this is deliberately just a callback
   * over that, not a bespoke reporting system (v1 is explicitly minimal). Defaults to
   * `console.log`/`console.error` so callers only need to supply this in tests. */
  readonly log?: (result: SourceResolution) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function defaultLog(result: SourceResolution): void {
  if (result.ok) console.log("registry ingest: refreshed", result.source)
  else console.error("registry ingest: failed", result.source, result.error)
}

/**
 * XCOD-35's whole job, as one pure(-ish) orchestration function: list every registered
 * source, resolve each independently, and write only the ones that resolved.
 *
 * Failure isolation is the load-bearing property here (the "doesn't corrupt last-known-
 * good data" AC): a source's `resolve` or `write` failure is caught, logged, and recorded
 * in the result — it never aborts the loop and `write.replaceMarketplace` is never called
 * for that source, so its prior rows are left exactly as they were. One source's failure
 * cannot affect any other source's write, since each is a fully independent try/catch.
 *
 * KNOWN LIMITATION, not a bug: one `resolve(source)` call yields exactly one manifest (one
 * `name`), and `buildReplaceStatements`' DELETE is keyed on `manifest.name`, not `source`
 * (db.ts). If two marketplace rows were ever seeded sharing one `source` (schema permits
 * it — see `LIST_MARKETPLACE_SOURCES_SQL`'s DISTINCT comment), a run that re-resolves that
 * source only refreshes the one row matching the fetched manifest's `name`; the other goes
 * silently stale with no error logged for it. No data is lost or corrupted (AC2 still
 * holds), but v1 has no mechanism to refresh a second marketplace hiding behind the same
 * source string.
 */
export async function runIngestion(deps: IngestionDeps): Promise<IngestionResult> {
  const log = deps.log ?? defaultLog
  const sources = await deps.sources.listMarketplaceSources()
  const resolutions: SourceResolution[] = []

  for (const source of sources) {
    const result = await deps
      .resolve(source)
      .then(async (manifest): Promise<SourceResolution> => {
        await deps.write.replaceMarketplace({ manifest, source })
        return { source, ok: true, manifest }
      })
      .catch((error: unknown): SourceResolution => ({ source, ok: false, error: errorMessage(error) }))

    resolutions.push(result)
    log(result)
  }

  return { resolutions }
}
