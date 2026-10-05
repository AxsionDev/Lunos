# XCOD-183: open core (DECIDED)

**Status:** decided · **Date:** 2026-10-04 · **Decided by:** Petar Minev (product owner)
**Revises:** [xcod-52-contributor-licensing-decision.md](./xcod-52-contributor-licensing-decision.md)
· **Related:** XCOD-184 (IP chain of title), XCOD-182 (legal pack), XCOD-189 (pricing page)

## Decision

Lunos is open core. Public statement: [`docs/licensing.md`](../../docs/licensing.md).

- `AxsionDev/Lunos` (harness, CLI, desktop app, VS Code extension) stays **MIT**, permanently.
- The commercial layer is **new code in separate repositories** in the `lunoshq` GitHub
  organisation, owned by ITService EOOD. The repositories are private, with forking disabled and
  branch protection on `main`, and take no outside contributions.
- Licences: **FSL-1.1-MIT** for code shipped to customers (self-hosted console, hybrid workers);
  **proprietary** for hosted-only code (billing, metering, fleet management). FSL is never called
  "open source".
- Commercial code depends on the MIT harness only through public interfaces (plugin API, workspace
  adapter, server API). No commercial code is copied into the MIT repository.

## Effect on XCOD-52 (contributor licensing)

XCOD-52 chose the DCO on the basis that no commercial edition was planned, and asked to be
revisited if one ever was. Revisited 2026-10-04: **the DCO stays.**

- A CLA's value is the right to relicense contributions. Under this decision nothing in the MIT
  repository is ever relicensed.
- Commercial code is written separately by people whose contracts assign IP to ITService (XCOD-184).
- MIT contributions can be used in commercial code under MIT's own terms, keeping the notice.

**Revisit if** code is ever to move out of the MIT repository into a commercial licence, or the
repository is to be relicensed. Either needs a new decision first.

## CRA

The preliminary legal memo on XCOD-182 noted that announcing paid plans alongside free binaries can
be a sign of commercial activity under the CRA. Petar decided on 2026-10-05 that the published
assessment stands (likely outside CRA scope; [xcod-54](./xcod-54-cra-status-assessment.md)).
Counsel's review on XCOD-182 continues.

## Administrators

Petar is the only administrator of `lunoshq`, as of every Lunos account, while he is the only
person working on Lunos (2026-10-05). This is recorded as a known gap in the XCOD-184 asset
register, to revisit when a second person joins or before the first paid customer.
