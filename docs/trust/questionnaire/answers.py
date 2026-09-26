#!/usr/bin/env python3
# XCOD-108: pre-filled answers to the CSA Consensus Assessments Initiative Questionnaire v3.0.1.
#
# Questions: caiq-v3.0.1-questions.json, extracted from the CSA's published workbook
# (csa-caiq-v3.0.1-09-01-2017.xlsx, 295 questions, as distributed in github.com/metanorma/csa-ccm-tools, Apache-2.0).
# CAIQ is written for cloud-service providers. Lunos is self-hosted software with no Lunos-operated
# service in the data path, so many questions don't apply; those say so and why.
#
# Answer values:
#   Yes / No / Partial        about the Lunos software or project, with the source that backs it
#   N/A                       the question is about operating a service; there is none
#   Axsion to answer          an organisational fact about ITService EOOD not documented here
#
# Regenerate the Markdown and CSV with:  python3 docs/trust/questionnaire/answers.py
# then format:                           bunx prettier --write docs/trust/questionnaire-caiq-v3.0.1.md

import csv, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
REL = "https://github.com/AxsionDev/Lunos/blob/dev/"

SELF_HOSTED = ("N/A", "Lunos is self-hosted software. ITService EOOD operates no service that stores or processes customer data, so there is no provider-side infrastructure, tenant data or tenancy to which this applies.", "docs/deployment/self-hosted.md")
ORG = ("Axsion to answer", "An organisational policy of ITService EOOD. Not documented in the Lunos repository; to be answered by Axsion.", "")

DEFAULTS = {
    "Datacenter Security": SELF_HOSTED,
    "Encryption & Key Management": SELF_HOSTED,
    "Human Resources": ORG,
    "Mobile Security": ORG,
    "Infrastructure & Virtualization Security": SELF_HOSTED,
    "Identity & Access Management": SELF_HOSTED,
    "Business Continuity Management & Operational Resilience": SELF_HOSTED,
    "Audit Assurance & Compliance": SELF_HOSTED,
    "Governance and Risk Management": ORG,
    "Security Incident Management, E-Discovery, & Cloud Forensics": SELF_HOSTED,
    "Supply Chain Management, Transparency, and Accountability": ORG,
    "Threat and Vulnerability Management": SELF_HOSTED,
    "Interoperability & Portability": SELF_HOSTED,
    "Data Security & Information Lifecycle Management": SELF_HOSTED,
    "Change Control & Configuration Management": ORG,
    "Application & Interface Security": SELF_HOSTED,
}

NEXT = " (from the next release; not in v1.18.39)"

O = {
    # Application & Interface Security
    "AIS-01.1": ("No", "Changes go through pull requests with typecheck, unit and end-to-end checks in CI, but no named SDLC security framework (BSIMM, NIST SSDF, etc.) is adopted.", ".github/workflows/test.yml"),
    "AIS-01.2": ("No", "No static application security testing (SAST) tool is in CI yet. Type checking and tests run on every pull request, but they are not security analysis.", ".github/workflows/typecheck.yml"),
    "AIS-01.3": ("Partial", "Changes are made through pull requests. A mandatory independent reviewer is not enforced: branch protection is not enabled on `dev`.", ""),
    "AIS-01.4": ("No", "Lunos is a fork of opencode and depends on open-source packages; their SDLC is not verified. A software bill of materials is published per release so the dependency tree can be checked.", "docs/trust/supply-chain.md"),
    # Audit Assurance & Compliance
    "AAC-01.1": ("No", "No structured audit assertions are produced.", ""),
    "AAC-02.1": ("No", "Lunos holds no SOC 2, ISO 27001 or similar certification or third-party audit report, and claims none.", "docs/deployment/self-hosted.md"),
    "AAC-02.3": ("No", "No application penetration test has been carried out on Lunos.", ""),
    "AAC-02.4": ORG, "AAC-02.5": ("No", "No external audit has been carried out.", ""), "AAC-02.8": ORG,
    "AAC-03.3": ("Yes", "Data stays on infrastructure the customer runs. The data-residency policy restricts which jurisdictions model requests may go to, refusing others before any connection is made.", "docs/data-residency.md"),
    "AAC-03.4": ("Partial", "Regulatory questions are tracked as project decisions (the CRA assessment, the sovereignty claim table), with named re-assessment triggers. There is no formal regulatory monitoring program.", "docs/trust/cra-readiness.md"),
    # Business continuity
    "BCR-03.1": ("Yes", "The deployment guide documents every destination Lunos sends data to and what is sent.", "docs/deployment/self-hosted.md#3-where-your-data-goes"),
    "BCR-03.2": ("Yes", "The customer chooses the model provider, and the data-residency policy restricts which jurisdictions requests may go to.", "docs/data-residency.md"),
    "BCR-04.1": ("Yes", "Installation, configuration and user documentation, and a data-flow description, are published.", "docs/deployment/self-hosted.md"),
    "BCR-10.1": ORG, "BCR-11.2": ("N/A", "ITService EOOD holds no customer data, so it has none to produce in response to a request. A procedure for such requests is an organisational matter for Axsion.", "docs/deployment/self-hosted.md"),
    # Change control
    "CCC-01.2": ("Yes", "Installation, configuration and usage documentation is published.", "docs/deployment/self-hosted.md"),
    "CCC-02.1": ("Partial", "Every pull request runs typecheck, unit, end-to-end and Nix checks. Branch protection is not enabled, so passing checks is not enforced before merge.", ".github/workflows/test.yml"),
    "CCC-02.2": ("N/A", "Development is not outsourced. Lunos incorporates upstream opencode as open source.", ""),
    "CCC-03.1": ("Partial", "The CI checks are visible in the public repository. No separate QA-process document is published.", ".github/workflows/"),
    "CCC-03.2": ("Yes", "Known limitations are listed in the deployment guide and SECURITY.md.", "docs/deployment/self-hosted.md#7-known-limitations--stated-not-buried"),
    "CCC-03.3": ("Yes", "Security vulnerabilities: a documented intake-to-disclosure process. Bugs: GitHub issues.", "SECURITY.md"),
    "CCC-03.4": ("No", "Not verified by a dedicated control.", ""),
    "CCC-05.1": ("Partial", "Every change is a public pull request, and releases carry a changelog. There is no production service to change-manage.", "CHANGELOG.md"),
    # Data security
    "DSI-01.4": ("Yes", "Customer data is stored on infrastructure the customer runs, so its location is the customer's choice.", "docs/deployment/self-hosted.md"),
    "DSI-01.5": ("Yes", "As above: the customer chooses where Lunos runs and stores its local state.", "docs/deployment/self-hosted.md"),
    "DSI-01.7": ("Yes", "The data-residency policy restricts the jurisdictions model requests may be routed to.", "docs/data-residency.md"),
    "DSI-02.1": ("Yes", "Data flows are documented in the deployment guide.", "docs/deployment/self-hosted.md#3-where-your-data-goes"),
    "DSI-02.2": ("Partial", "With a residency policy set, Lunos refuses model requests to providers outside the allowed jurisdictions and records every call in the audit log. What a permitted provider does with the data is governed by the customer's agreement with it.", "docs/data-residency.md"),
    "DSI-03.1": ("Partial", "Lunos connects to model providers over the endpoints the customer configures; hosted providers use HTTPS. Transport security for self-hosted endpoints is the customer's configuration.", ""),
    "DSI-06.1": ("Yes", "Responsibilities are documented: the customer operates Lunos and chooses the provider; ITService EOOD is not in the data path.", "docs/deployment/self-hosted.md#6-what-you-need-to-provide"),
    # Encryption: none held
    "EKM-03.2": ("Partial", "Model requests go to the endpoints the customer configures; hosted providers use HTTPS. There are no Lunos-operated networks or hypervisors.", ""),
    # Governance
    "GRM-04.1": ("Partial", "The security posture is documented in SECURITY.md and this Trust pack. There is no formal ISMS.", "docs/trust/README.md"),
    "GRM-06.4": ("Yes", "The claim table states exactly what is claimed; no certification or regulatory compliance is claimed.", "docs/deployment/self-hosted.md#2-what-is-true-today--the-sovereignty-claim-stated-precisely"),
    # HR: access to tenant data
    "HRS-08.1": ("Yes", "Documented: ITService EOOD has no access to customer data or metadata, and there is no telemetry. The only Lunos-operated host contacted is lunos.tech, for the static marketplace catalogue, and the request carries nothing from the project.", "docs/deployment/self-hosted.md#touches-lunos-operated-infrastructure"),
    "HRS-08.2": ("No", "No metadata about customer data is collected. Lunos has no telemetry.", "docs/deployment/self-hosted.md"),
    "HRS-08.3": ("N/A", "No customer data or metadata is accessed.", ""),
    "HRS-01.1": ("N/A", "ITService EOOD holds no customer data, so has no privacy breach of customer data to detect. The data-protection note is under legal review.", "docs/trust/data-protection.md"),
    # IAM
    "IAM-06.1": ("Partial", "Write access to the source repository is restricted to the AxsionDev GitHub organisation's members. Branch protection is not enabled on `dev`.", ""),
    "IAM-06.2": ("N/A", "Customer source code stays on the customer's machines; ITService EOOD has no access to it.", "docs/deployment/self-hosted.md"),
    "IAM-12.1": ("N/A", "Lunos has no user login to integrate SSO with. The admin-console/SSO decision is recorded in specs/admin-console-sso.md (deferred).", "packages/opencode/specs/admin-console-sso.md"),
    # IVS: audit logging in the product
    "IVS-01.4": ("N/A", "No Lunos-operated service produces audit logs. For customers: the product writes a local, hash-chained audit log the customer controls, and can forward it to the customer's SIEM" + NEXT + ". For v1.18.39: model calls and share uploads are recorded when a residency policy is set.", "docs/audit-log.md"),
    "IVS-01.5": ("N/A", "The audit log is the customer's; reviewing it is the customer's process. `lunos audit verify` checks its integrity" + NEXT + ".", "docs/audit-log.md"),
    "IVS-01.2": ("N/A", "The audit log is a local file on the customer's machine, under the customer's access controls.", "docs/audit-log.md"),
    # Interoperability
    "IPY-01.1": ("Yes", "The local HTTP API is published as an OpenAPI document.", "packages/sdk/openapi.json"),
    "IPY-02.1": ("Yes", "All data is local files on the customer's machine; a session can be exported as JSON with the `export` command.", "packages/web/src/content/docs/cli.mdx#export"),
    "IPY-03.1": ("N/A", "There is no service agreement: Lunos is MIT-licensed software the customer runs.", ""),
    "IPY-03.2": ("N/A", "Same as IPY-03.1.", ""),
    "IPY-04.1": ("N/A", "Data is not imported to or exported from a Lunos-operated service.", ""),
    "IPY-04.2": ("N/A", "Same as IPY-04.1.", ""),
    # Incident management
    "SEF-02.1": ("Partial", "A vulnerability-handling process (intake, assessment, remediation, release, disclosure) is documented. There is no incident-response plan for a service, because none is operated.", "SECURITY.md#vulnerability-handling-process"),
    "SEF-02.3": ("Yes", "Responsibilities are documented: the customer operates Lunos; ITService EOOD handles vulnerabilities in the software.", "SECURITY.md"),
    "SEF-03.1": ("N/A", "No provider-side SIEM exists. The product can forward its audit log to the customer's SIEM (syslog or OTLP)" + NEXT + ".", "docs/audit-log.md#forwarding-to-a-siem"),
    "SEF-01.1": ORG,
    # Supply chain
    "STA-02.1": ("Yes", "Security fixes are disclosed through public GitHub Security Advisories once a fixed release is available.", "SECURITY.md"),
    "STA-09.1": ("Yes", "The full source is public (MIT). Customers may assess it independently. Report findings privately through GitHub Security Advisories.", "SECURITY.md"),
    "STA-09.2": ("No", "No third-party vulnerability scans or penetration tests have been carried out.", ""),
    "STA-03.1": SELF_HOSTED, "STA-03.2": SELF_HOSTED, "STA-01.1": SELF_HOSTED,
    # Threat and vulnerability management
    "TVM-02.2": ("No", "No application-layer vulnerability scanning of Lunos is performed.", ""),
    "TVM-02.4": ("N/A", "No scans are performed (see TVM-02.2).", ""),
    "TVM-02.5": ("Partial", "Fixes ship in new releases; Lunos announces new releases and can upgrade itself when the customer allows it. Support periods are not yet defined.", "docs/trust/cra-readiness.md"),
    "TVM-02.6": ("No", "Support periods and patching time frames are not yet defined.", "docs/trust/cra-readiness.md"),
}

def main():
    qs = json.load(open(os.path.join(HERE, "caiq-v3.0.1-questions.json")))
    rows = []
    for q in qs:
        domain = q["domain"]
        qid = q["id"]
        status, note, src = O.get(qid) or DEFAULTS[domain]
        rows.append({"domain": domain, "id": qid, "question": q["q"], "answer": status, "notes": note, "source": (REL + src) if src else ""})
    with open(os.path.join(HERE, "caiq-v3.0.1-answers.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader(); w.writerows(rows)
    counts = {}
    for r in rows: counts[r["answer"]] = counts.get(r["answer"], 0) + 1
    out = [
        "# CSA CAIQ v3.0.1: pre-filled answers for Lunos",
        "",
        "Pre-filled answers to the Cloud Security Alliance's Consensus Assessments Initiative Questionnaire,",
        "version 3.0.1, for reviewers to copy. **Applies to release v1.18.39**; answers that depend on",
        "unreleased work say so. Generated from [`questionnaire/answers.py`](questionnaire/answers.py); a spreadsheet version is",
        "[`questionnaire/caiq-v3.0.1-answers.csv`](questionnaire/caiq-v3.0.1-answers.csv).",
        "",
        "**Read this first.** CAIQ is written for cloud-service providers. Lunos is software you run on",
        "your own infrastructure; ITService EOOD operates no service that stores or processes your data. So",
        "many questions are **N/A**, and say why. **Axsion to answer** marks organisational questions",
        "(HR, devices, contracts, internal audits) whose answers are not documented here; ask ITService",
        "EOOD for them. Where the answer is **No**, it is No.",
        "",
        "Totals: " + ", ".join(f"{k}: {v}" for k, v in sorted(counts.items())) + f" (of {len(rows)}).",
        "",
    ]
    current = None
    for r in rows:
        if r["domain"] != current:
            current = r["domain"]
            out += ["", f"## {current}", "", "| ID | Question | Answer | Notes | Source |", "| --- | --- | --- | --- | --- |"]
        src = f"[source]({r['source']})" if r["source"] else ""
        esc = lambda s: s.replace("|", "\\|")
        out.append(f"| {r['id']} | {esc(r['question'])} | **{r['answer']}** | {esc(r['notes'])} | {src} |")
    open(os.path.join(HERE, "..", "questionnaire-caiq-v3.0.1.md"), "w").write("\n".join(out) + "\n")
    print(counts, len(rows))

if __name__ == "__main__":
    main()
