# Security Review Reference

The security dimension of `code-review-methodology`. Focus EXCLUSIVELY on: vulnerabilities/exploits, authentication & authorization flaws, data protection, insecure configuration. Defer performance, architecture, and code-quality to their reviewers.

**Scope:** review ONLY recently changed/created code — don't audit the whole codebase unless asked. Load project examples from `.claude/patterns/{backend,frontend}-patterns.md` when available. Assume all user input is hostile until validated.

## Checklist

### 1. Injection
- **SQL injection** — raw SQL via string concat/interpolation with user input; dynamic queries without parameterization; stored-proc calls with unsanitized input.
- **Command injection** — user input reaching OS command/process execution without allowlisting.
- **XSS** — user content rendered as HTML without sanitization: `innerHTML`/`dangerouslySetInnerHTML` with user data, sanitizer bypasses, unencoded template output.

### 2. Authentication & Authorization
Hardcoded credentials/API keys; weak password rules; missing auth on endpoints; broken access control (user reaches other users' data); missing authorization checks; session fixation; JWT misconfig (weak secret, no expiry). **IDOR:** endpoints fetching by ID without verifying the caller owns the resource.

### 3. Sensitive Data Exposure
Secrets in source (keys, passwords, connection strings); sensitive data in logs (check interpolated logger calls); plaintext passwords; sensitive data in URL query params; missing encryption at rest; leaking internal IDs/system info.

### 4. Input Validation
Missing server-side validation; client-only validation; overly permissive regex; missing length limits (DoS); missing type validation. Flag handlers using request body/params directly with no checks.

### 5. CSRF
Missing anti-forgery tokens on forms; state-changing operations via GET; missing SameSite cookie attribute.

### 6. Security Misconfiguration
Debug mode in prod; verbose errors exposing internals; default credentials; missing security headers (HTTPS/CSP/HSTS); overly permissive CORS (AllowAnyOrigin **with credentials** / wildcard origin on sensitive endpoints); unnecessary exposed services.

### 7. Insecure Dependencies
Known-vulnerable packages; outdated packages with security patches available.

## Severity (security-specific)

| Level | Meaning | Examples |
|-------|---------|----------|
| 🔴 Critical | Immediate exploit | SQL injection, RCE, auth bypass |
| 🟠 High | Significant, harder to exploit | Stored XSS, IDOR, broken access control |
| 🟡 Medium | Needs conditions | CSRF, reflected XSS, info disclosure |
| 🟢 Low | Defense in depth | Missing headers, verbose errors |

## Output Layout

```markdown
## Security Review Report

### Summary
- Files Reviewed / Critical / High / Medium / Low: [counts]

### Critical 🔴 / High 🟠 / Medium 🟡 / Low 🟢
#### Issue: [title]
**Location**: `file:line`
**Description**: [the vulnerability]
**Risk**: [what an attacker could do]
**Code**: [vulnerable snippet]
**Fix**: [secure code]

### Secure Patterns Observed ✅
### Verdict: APPROVED / NEEDS FIXES
### Required Actions
```

## Core Principles

Assume hostile input · defense in depth · least privilege · fail secure (errors deny, not grant) · no security through obscurity.

## Success Criteria

Complete when: changed code checked against all 7 categories; auth/authz paths verified for IDOR/broken access; secrets/logging scanned; every finding has location + risk + fix; explicit verdict.
