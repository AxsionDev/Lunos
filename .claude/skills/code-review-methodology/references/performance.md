# Performance Review Reference

The performance dimension of `code-review-methodology`. Focus EXCLUSIVELY on: database query efficiency, async/await patterns, memory/allocations, caching, resource management. Defer security, architecture, and code-quality to their reviewers.

Load project query/component examples from `.claude/patterns/{backend,database,frontend}-patterns.md`. Adapt search patterns to the stack in `.claude/patterns/tech-stack.md`.

## Checklist

### 1. Database
- **N+1** — fetch a collection then access a related entity per item in a loop (1+N round trips); lazy loading in loops; missing eager loading (Include/join/prefetch); queries inside foreach/for.
- **Query efficiency** — materialize-then-filter in memory; `SELECT *` when few columns needed; missing indexes on filtered/sorted columns; missing pagination.

### 2. Async/Await
Blocking on async (`.Result`, `.Wait()`, `.GetAwaiter().GetResult()`, `asyncio.run()` inside async) in request-handling code; fire-and-forget without error handling; async overhead for purely sync work; thread-pool starvation.

### 3. Memory & Allocations
String concat in loops (use builder/join); boxing/unboxing; large objects on hot paths; unnecessary collection materialization.

### 4. Caching
Repeated expensive computations; DB queries for static/rarely-changing data; missing HTTP cache headers; cacheable API calls uncached.

### 5. Resource Management
Disposables not disposed (streams, connections); HTTP clients created per request (should be singleton/factory); DB connections not scoped; file handles left open.

### 6. Frontend
Subscription/listener leaks (missing cleanup on destroy); unnecessary re-render (missing OnPush/memo); large lists without virtualization/tracking; excessive change-detection cycles.

## Severity

| Level | Meaning | Examples |
|-------|---------|----------|
| 🔴 Critical | Severe impact | N+1 in main list, blocking async |
| 🟠 High | Noticeable degradation | Missing caching, inefficient queries |
| 🟡 Medium | Scales poorly | String concat, unnecessary allocations |
| 🟢 Low | Micro-optimization | Minor allocation reduction |

## Detection Methodologies (static, via Grep/Glob)

- **N+1** — loop constructs (foreach/for/map) near ORM query calls; check for eager loading (Include/prefetch/join) before the loop.
- **Blocking async** — `.Result`/`.Wait()`/`.GetAwaiter().GetResult()` in controller/service/handler. *Context matters:* startup/main/test setup is usually OK; request-handling code is a violation.
- **Inefficient queries** — ORM materialization (`ToList`/`all()`/`fetchAll`) immediately followed by filter/map (materialize-then-filter); client-side evaluation of untranslatable functions.
- **Memory** — `+=` string building in loops; large array/collection creation in non-static hot paths.

## Baselines (flag deviations)

DB: single-row-by-PK <20ms acceptable / >100ms critical; list<1000 rows <200ms / >500ms critical; report/aggregate <2s / >5s critical.
API: simple GET <200ms; list <500ms; create/update <500ms (acceptable thresholds; beyond = poor).
Memory: <5MB allocations/request acceptable, >10MB critical; LOH allocations should be ~0.

## False-Positive Guidance

**Accept:** blocking async in startup/CLI entrypoint; materializing small static datasets; string concat for <5 items; no caching for user-specific data; allocations in test code.

**Always flag:** blocking async in request-handling; materialize-then-filter on DB query; loop with DB call inside; HTTP clients created per request.

## Impact Assessment

High impact (Critical/High): controller actions (every request); loops over user data; batch background jobs.
Lower impact (Medium/Low): rarely-called admin functions; small bounded datasets; startup/init code.

## Output Layout

```markdown
## Performance Review Report

### Summary
- Files Reviewed / Critical / High / Medium / Low: [counts]

### Critical 🔴 / High 🟠 / Medium 🟡 / Low 🟢
#### Issue: [title]
**Location**: `file:line`   **Impact**: [est. impact, e.g. "~100ms/request"]
**Code**: [problematic snippet]   **Fix**: [optimized code]

### Optimization Opportunities 💡
### Good Patterns Observed ✅
### Verdict: APPROVED / NEEDS FIXES
### Required Actions
```

For the fixing-developer handoff, include before/after metric and a 3-step verification (measure → apply → re-measure).

## Core Principles

Measure first · hot paths matter most · the DB is usually the bottleneck · async all the way (don't block, don't over-async) · allocate less.

## Success Criteria

Complete when: queries analyzed for N+1; async verified non-blocking; hot paths reviewed; memory-intensive ops flagged; each finding has impact assessment; explicit verdict.
