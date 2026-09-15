-- packages/registry/migrations/0001_init.sql
--
-- XCOD-34 registry schema. Every column below maps to a field defined in
-- packages/core/src/marketplace.ts (XCOD-8) — Marketplace.Manifest, .Owner, .Entry, .Source —
-- except the two explicitly marked "registry-native".

CREATE TABLE IF NOT EXISTS marketplace (
  -- Manifest.name. Natural key: one row per ingested manifest.
  name        TEXT PRIMARY KEY,

  -- Marketplace.Owner, flattened (closed 3-field shape: name required, email/url optional).
  owner_name  TEXT NOT NULL,
  owner_email TEXT,
  owner_url   TEXT,

  -- Manifest.description / Manifest.version (both Schema.optional in XCOD-8).
  description TEXT,
  version     TEXT,

  -- REGISTRY-NATIVE, not an XCOD-8 field: where the registry resolved this manifest from.
  -- Surfaced verbatim as `source` on GET /marketplaces (per XCOD-33's example response).
  source      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin (
  -- REGISTRY-NATIVE denormalization, per XCOD-33's data-seed-mapping section. Mirrors
  -- PluginListEntry.marketplace in packages/opencode/src/plugin/discover.ts.
  marketplace_name TEXT NOT NULL REFERENCES marketplace(name) ON DELETE CASCADE,

  -- Entry.name
  name             TEXT NOT NULL,

  -- Marketplace.Source, denormalized: discriminant column + per-variant columns.
  source_type      TEXT NOT NULL CHECK (source_type IN ('npm', 'github')),
  source_package   TEXT,  -- NpmSource.package    — required when source_type = 'npm'
  source_version   TEXT,  -- NpmSource.version    — optional
  source_repo      TEXT,  -- GithubSource.repo    — required when source_type = 'github'
  source_ref       TEXT,  -- GithubSource.ref     — optional

  -- Entry scalar optionals.
  description      TEXT,
  version          TEXT,  -- Entry.version — DISTINCT from source_version (NpmSource.version)
  author           TEXT,
  category         TEXT,

  -- Entry.tags: a JSON array of strings. NULL when the key is absent; '[]' is a distinct,
  -- legal value that round-trips as an empty array.
  tags             TEXT,

  PRIMARY KEY (marketplace_name, name),

  -- Enforces the tagged union's arity at write time: exactly the named variant's columns are
  -- populated and the other variant's are NULL. This is the write-time guard a JSON blob
  -- cannot provide.
  CHECK (
    (source_type = 'npm'
      AND source_package IS NOT NULL
      AND source_repo IS NULL AND source_ref IS NULL)
    OR
    (source_type = 'github'
      AND source_repo IS NOT NULL
      AND source_package IS NULL AND source_version IS NULL)
  )
);
