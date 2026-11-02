# Lunos licensing: what is MIT and what is commercial

Lunos is developed by ITService EOOD (АйТиСървис ЕООД, Bulgaria, UIC 201069485), which holds the
rights to Lunos's own code. Lunos is a fork of [opencode](https://github.com/sst/opencode), whose
code Lunos uses under opencode's MIT licence.

## The rule

Everything in this repository is, and stays, **MIT-licensed**. Planned paid features will be **new
code in separate, company-owned repositories**, under a commercial licence. No commercial code is
copied into this repository, and nothing in this repository is relicensed.

## What stays MIT (this repository)

- the agent harness and the `lunos` CLI;
- the desktop app;
- the VS Code extension;
- everything else in this repository, including future additions to it.

The MIT version is complete on its own: self-hosted, provider-agnostic, with data residency, the
audit log and organisation policy. Paid features will be additions. No part of the MIT version will
be moved behind a paywall.

## What will be commercial (planned)

None of this exists yet.

| Part                                                                    | Licence     | Why                                   |
| ----------------------------------------------------------------------- | ----------- | ------------------------------------- |
| Lunos Cloud workers, control plane, billing, metering, fleet management | Proprietary | Runs only on ITService's own servers  |
| Self-hosted admin console, SSO, team server features, hybrid workers    | FSL-1.1-MIT | Shipped to customers, who can read it |

- **FSL-1.1-MIT** (the [Functional Source License](https://fsl.software/)) is source-available:
  customers can read, run and modify the code for their own use, but not use it to offer a
  competing product. Each release becomes MIT-licensed two years after it is published. **FSL is
  not an open-source licence, and Lunos doesn't describe it as one.**
- **Proprietary** code is never distributed. It runs only as part of the hosted service.

## How the two sides connect

- Commercial code uses Lunos only through its **public interfaces**: the plugin API, the workspace
  adapter and the server API. If commercial code needs a new interface, it is added to this
  repository, in the open, where anyone can use it.
- MIT code from this repository may be used in commercial repositories, as the MIT licence allows,
  **with its copyright and licence notice kept**.
- Commercial code never depends on anything that isn't public here.

## Who writes commercial code

The commercial repositories are private, in a separate GitHub organisation owned by ITService
EOOD. They take no outside contributions: only people whose employment or contractor agreements
assign their work to ITService EOOD commit there.

## Contributing to this repository

Contributions here are licensed under MIT, like the rest of the repository, and every commit
carries a [Developer Certificate of Origin](../CONTRIBUTING.md#contributor-licensing--sign-your-commits-dco)
sign-off. There is no contributor licence agreement. Your contribution stays MIT and is never
relicensed.

## Third-party code

Every Lunos release ships the licence notices of the third-party software it includes
(`THIRD_PARTY_NOTICES`, and `lunos licenses`). The same licence check applies to the commercial
repositories, which don't include copyleft code.
