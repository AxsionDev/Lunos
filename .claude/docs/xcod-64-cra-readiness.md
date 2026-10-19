# XCOD-64 — CRA readiness: SBOM and vulnerability handling

**What this is:** the engineering follow-through on [XCOD-54](https://axsion.atlassian.net/browse/XCOD-54)'s
legal assessment. It is **readiness groundwork, not compliance work.**

**What may be claimed:** "SBOM available", "CRA readiness", "documented vulnerability-handling
process".

**What may _not_ be claimed:** "CRA-compliant", "CRA-certified", "meets CRA requirements". Those
obligations are not currently owed, and would not be discharged by this work alone. Claiming them
would repeat exactly the overclaim pattern [XCOD-55](https://axsion.atlassian.net/browse/XCOD-55)
ruled out for infrastructure.

## Why this is not compliance work

Per XCOD-54, unchanged here — that assessment is the source of truth and is not re-derived:

- Lunos is **outside CRA scope today**: MIT-licensed, free, self-hosted, and not monetised by its
  manufacturer, so it is not a commercial activity.
- If that determination were contested, the fallback is the **steward** position (Art. 24), whose
  obligations do not bind until **11 December 2027**.
- The **manufacturer** regime — conformity assessment, CE marking, technical documentation, and the
  Annex I SBOM requirement — applies only if a paid offering launches.
- XCOD-54 also corrected an earlier doc that cited a May 2026 CRA deadline. **There is no such
  deadline.** Do not reintroduce it.

An SBOM is therefore **not legally owed**. XCOD-54 recommended building one regardless, for two
reasons that still hold: it is the single largest piece of manufacturer readiness, and it converts
a future obligation into present procurement credibility.

## What this story delivered

### 1. SBOM, generated per release

- **Tool:** [syft](https://github.com/anchore/syft), pinned to **v1.52.0**.
- **Format:** CycloneDX JSON (spec 1.7) — a commonly used machine-readable format, as Annex I
  contemplates.
- **Source:** `bun.lock`. Produces ~2,165 components with package URLs.
- **Wiring:** a `sbom` job in `.github/workflows/publish.yml`, which runs on GitHub-hosted runners
  and therefore actually executes on this fork. It uploads `lunos-sbom-<version>.cdx.json` as both
  a workflow artifact and a release asset. It regenerates every release — not a one-off export.

**The version pin is load-bearing.** syft only learned to read bun's lockfile recently. Measured on
this repo:

| syft version | components parsed from `bun.lock` |
| ------------ | --------------------------------- |
| v1.20.0      | **0**                             |
| v1.52.0      | **2,165**                         |

v1.20.0 does not error — it emits a schema-valid CycloneDX document containing nothing. A silent
downgrade would publish a convincing, empty SBOM. The workflow therefore fails the job if the
component count drops below 100, on the same principle as the existing `if-no-files-found: error`
guards in that file.

**Known gap:** `bun.lock` does not record licence metadata, so **no component carries a licence
field**. Procurement reviewers commonly want that. Closing it needs either a directory scan of the
installed tree (`syft scan dir:.`, which reads each `node_modules/*/package.json` but requires a
completed install) or a separate `bun pm licenses` export. Not done here — recorded so it is not
mistaken for an oversight.

### 2. Vulnerability-handling process

`SECURITY.md` now documents intake, assessment, remediation, release, and disclosure, with an
acknowledgement target of 6 business days.

**It also fixes a live defect.** The file was still upstream opencode's in its entirety: it
described the product as "OpenCode", routed reports to
`github.com/anomalyco/opencode/security/advisories/new`, and escalated to `security@anoma.ly`.
**Lunos vulnerability reports were being directed to the upstream project.** They now go to
`github.com/AxsionDev/Lunos/security/advisories/new`, with upstream named as a secondary path for
issues in unmodified inherited code.

The threat model content (no sandbox, opt-in server mode, the out-of-scope table) was accurate and
was kept.

This satisfies the substance of Art. 24(1)'s "documented cybersecurity policy" and Art. 24(1)/15's
"support voluntary vulnerability reporting" — recorded as good practice, **not** as discharge of an
obligation that does not currently bind.

## Known limitations, carried forward not dropped

- **Binaries are not code-signed on any platform.** Recorded in `CHANGELOG.md` and now in
  `SECURITY.md`. CI signing jobs exist but skip when credentials are absent
  ([XCOD-48](https://axsion.atlassian.net/browse/XCOD-48) /
  [XCOD-49](https://axsion.atlassian.net/browse/XCOD-49)). Per XCOD-54 this is **not a CRA gap**
  under the current determination — signing is not a named CRA obligation; it bears on the Annex I
  essential requirements, which are manufacturer-only and apply from 11 Dec 2027. It is a
  distribution and trust problem today, and would become a conformity question on monetisation.
- **No dedicated security contact address exists.** The GitHub advisory channel is private and
  works today, so there is no gap in the ability to report — but there is no escalation address if
  that channel is not acknowledged. **Owner action:** provision one (e.g. `security@` on a
  project-controlled domain) and add it to `SECURITY.md`.
- **No SBOM licence data**, as above.

## Re-assessment trigger

Unchanged from XCOD-54, repeated because it governs whether any of this becomes mandatory:
**any monetisation of Lunos** — paid hosting, paid support, a commercial licence, paid priority
features — moves Lunos toward the manufacturer regime, where the full obligation set and the
already-live Art. 14 reporting duty apply. The hosted offering deferred by XCOD-55 becoming
near-term is the same trigger by another route.

Absent that, re-check at **11 December 2027**.

## Related

- [XCOD-54](https://axsion.atlassian.net/browse/XCOD-54) — the CRA assessment this implements;
  see `.claude/docs/xcod-54-cra-status-assessment.md`
- [XCOD-55](https://axsion.atlassian.net/browse/XCOD-55) — infrastructure claim discipline
- [XCOD-60](https://axsion.atlassian.net/browse/XCOD-60) — Phase 1 epic
