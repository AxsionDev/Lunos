Perform a comprehensive legal compliance audit of the Toplo Customer Portal. Scope: $ARGUMENTS (leave blank for full audit). Reference prior audit results at `.claude/docs/legal-compliance-review.md` for context on previous findings.

## Application Context

The **Toplo Customer Portal** is a full-stack web application for Топлофикация Враца (a district heating utility company in Vratsa, Bulgaria). Current features:

1. **User Authentication** - Registration, login, password reset, OAuth (Google/Facebook)
2. **Customer Management** - Customer profiles and data
3. **Wallet System** - Digital wallet with balance, transactions, top-up functionality, auto-refill
4. **Payment Processing** - Stripe integration for card payments
5. **Saved Payment Methods** - Storing customer payment instruments
6. **Admin/Tenant Management** - Multi-tenant organization management

## Audit Methodology

### Step 1: Application Discovery

Before generating any legal documentation, thoroughly review the application codebase to understand:
- What personal data is collected (inspect entities, DTOs, forms, API endpoints)
- How data flows through the system (controllers → services → repositories → database)
- What third-party services are integrated (Stripe, Google OAuth, Facebook OAuth)
- What cookies and tracking mechanisms are used
- How authentication and authorization work
- What payment processing occurs
- What email communications are sent
- What logging and audit trails exist
- The multi-tenant architecture implications

Review these key locations:
- `Toplo.CustomerPortal.Data/Entities/` - All data models and personal data fields
- `Toplo.CustomerPortal/Controllers/` - All API endpoints and data collection points
- `Toplo.CustomerPortal.Business/Services/` - Business logic and data processing
- `Toplo.CustomerPortal.Business/DTOs/` - Data transfer objects
- `Toplo.CustomerPortal.UI/src/app/` - Frontend forms and data collection
- `Toplo.CustomerPortal.Data/ApplicationDbContext.cs` - Database schema
- `Toplo.CustomerPortal/Program.cs` - Middleware, authentication config
- `.claude/docs/` - Existing documentation for context
- `.claude/docs/`, `.augment/`, `docs/` - Architecture and API documentation

### Step 2: Gap Analysis

After understanding the application, perform a comprehensive gap analysis identifying:
- Missing legal documents
- Existing features that lack legal coverage
- Regulatory requirements not yet addressed
- Technical implementations needed for compliance (e.g., data export, deletion mechanisms)

### Step 3: Document Generation

Generate all required legal documents and store them under `docs/legals/`. Each document must:
- Be written in **both Bulgarian and English** (Bulgarian as primary, English as reference translation) — use separate files with suffixes `-bg.md` and `-en.md`
- Follow the Document Format Template below
- Be marked as **DRAFT — PENDING LEGAL REVIEW** prominently at the top
- Reference specific articles of applicable laws
- Be tailored to the specific functionality of the Toplo Customer Portal
- Be practical and implementation-ready, not generic templates

### Step 4: Compliance Report

Generate a master compliance report at `docs/legals/COMPLIANCE-REPORT.md` that:
- Lists all regulatory frameworks reviewed
- Maps each requirement to the application feature it applies to
- Indicates compliance status (Compliant / Partially Compliant / Non-Compliant / Needs Review)
- Provides specific remediation recommendations
- Prioritizes issues by risk level (Critical / High / Medium / Low)

## Document Catalog

Assess the need for and generate (where applicable) the following 29 documents:

### GDPR & Data Protection
1. **Privacy Policy** (`privacy-policy-bg.md`, `privacy-policy-en.md`) - Comprehensive Art. 13/14 GDPR notice
2. **Cookie Policy** (`cookie-policy-bg.md`, `cookie-policy-en.md`) - ePrivacy compliance
3. **Data Processing Records** (`data-processing-records.md`) - Art. 30 GDPR record of processing activities
4. **Data Protection Impact Assessment** (`dpia.md`) - Art. 35 GDPR, especially for payment processing and profiling
5. **Data Subject Rights Procedures** (`data-subject-rights.md`) - Procedures for access, rectification, erasure, portability, restriction, objection
6. **Data Breach Response Plan** (`data-breach-response.md`) - Art. 33/34 GDPR notification procedures
7. **Data Retention Policy** (`data-retention-policy.md`) - Retention periods for each data category
8. **Sub-Processor List** (`sub-processors.md`) - Stripe, Google, Facebook, hosting providers
9. **Data Processing Agreement Template** (`dpa-template.md`) - For third-party processors
10. **Consent Management Documentation** (`consent-management.md`) - How consent is collected, stored, withdrawn

### Consumer Protection & E-Commerce
11. **Terms of Service / General Terms and Conditions** (`terms-of-service-bg.md`, `terms-of-service-en.md`)
12. **Acceptable Use Policy** (`acceptable-use-policy.md`)
13. **Right of Withdrawal Information** (`right-of-withdrawal.md`) - Consumer Rights Directive compliance
14. **Complaint Handling Procedures** (`complaint-procedures.md`)
15. **Alternative Dispute Resolution (ADR) Information** (`adr-information.md`) - EU ODR platform reference

### Payment & Financial
16. **Payment Terms** (`payment-terms.md`) - Wallet, top-up, refund policies
17. **Wallet Terms of Use** (`wallet-terms.md`) - E-money considerations, fund safeguarding
18. **Refund Policy** (`refund-policy.md`)
19. **Anti-Money Laundering Policy** (`aml-policy.md`) - If wallet thresholds trigger AML requirements
20. **PSD2 Compliance Assessment** (`psd2-assessment.md`) - Strong Customer Authentication, payment security

### Energy Sector Specific
21. **District Heating Service Terms** (`heating-service-terms.md`) - Bulgarian Energy Act compliance
22. **Utility Customer Rights Notice** (`utility-customer-rights.md`)

### Security & Technical
23. **Information Security Policy** (`security-policy.md`) - NIS2 considerations
24. **Incident Response Plan** (`incident-response.md`)
25. **Access Control Policy** (`access-control-policy.md`) - Multi-tenant data isolation

### Accessibility
26. **Accessibility Statement** (`accessibility-statement.md`) - EU Accessibility Directive compliance

### Master Documents
27. **Compliance Report** (`COMPLIANCE-REPORT.md`) - Master gap analysis and compliance status
28. **Legal Document Index** (`INDEX.md`) - Catalog of all legal documents with status
29. **Regulatory Change Log** (`CHANGELOG.md`) - Track regulatory updates affecting the application

## Document Format Template

Every document must follow this structure:

```markdown
# [Document Title]

> ⚠️ **DRAFT — PENDING LEGAL REVIEW**
> This document was auto-generated based on application analysis and requires review and validation by a qualified legal professional before use.

## Document Metadata
| Field | Value |
|-------|-------|
| Version | 0.1 (Draft) |
| Created | [Date] |
| Last Updated | [Date] |
| Status | Draft — Pending Legal Review |
| Applicable Regulations | [List specific laws and articles] |
| Application Scope | Toplo Customer Portal — Топлофикация Враца |
| Data Controller | Топлофикация Враца ЕАД |
| Review Deadline | [Suggest appropriate deadline] |

---

[Document content...]

---

## Legal Review Notes
_This section is reserved for the legal team's review comments._

- [ ] Reviewed by: _______________
- [ ] Review date: _______________
- [ ] Approved: Yes / No / With Changes
- [ ] Changes required: _______________
```

## Task-Specific Rules

1. **All documents go in `docs/legals/`** — create the directory if it doesn't exist
2. **Generate the INDEX.md** that serves as the master catalog for the legal team
3. **Consider the multi-tenant architecture** — document data isolation requirements and tenant-specific legal obligations
4. **Payment compliance is critical** — Stripe integration with wallet functionality has significant regulatory implications under PSD2 and potentially e-money regulations
5. **District heating is a regulated utility** — Bulgarian Energy Act and related regulations impose specific customer rights and obligations

## QA Checklist

Before completing the audit:
- [ ] All documents are saved in `docs/legals/`
- [ ] INDEX.md lists every generated document
- [ ] COMPLIANCE-REPORT.md covers all regulatory frameworks
- [ ] All documents reference the actual application features (not generic placeholders)
- [ ] Bulgarian-specific legal references are accurate
- [ ] All documents have the DRAFT watermark and legal review checklist
- [ ] Bilingual documents are consistent between BG and EN versions

> **Memory**: Agents should consult and update their `.claude/agent-memory/` between sessions.
