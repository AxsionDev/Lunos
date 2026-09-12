# Architecture Review Reference

The architecture dimension of `code-review-methodology`. Focus EXCLUSIVELY on: SOLID adherence, layer boundaries, abstraction quality, pattern consistency, coupling/cohesion. Defer security, performance, and code-quality to their reviewers.

Load project code examples from `.claude/patterns/backend-patterns.md` when available.

## Checklist

### 1. SOLID Principles

**SRP** — classes with multiple reasons to change; methods doing more than one thing; services mixing data access + business logic + notifications.

**OCP** — switch/if-else chains on types that must be edited for each new variant; missing extension points.

**LSP** — derived types throwing NotImplemented/NotSupported; overrides that break the base contract; inheritance used for reuse rather than "is-a".

**ISP** — fat interfaces with unrelated methods; implementations with empty/throwing stubs; clients depending on methods they don't use.

**DIP** — high-level modules `new`-ing concrete low-level types (except DTOs/value objects); missing abstraction for dependencies; tight coupling to implementation details.

### 2. Layer Boundaries

```
✅ Controllers → Services → Repositories → Database
❌ Repository → Controller | Service → Controller | EF/DbContext in Controller
```
Flag: business logic in controllers; services touching DbContext directly when a repository pattern exists; cross-layer dependencies; infrastructure concerns in the domain layer.

### 3. Abstraction Quality (leaky abstractions)

Flag raw query builders (`IQueryable`, querysets) or ORM/DB types exposed from repository interfaces; infrastructure types in interface signatures; implementation detail leaking through abstractions.

### 4. Pattern Consistency

Flag inconsistent patterns (some repos with interfaces, some without); mixed DI vs `new`; naming drift (`UserService` vs `UsersService` vs `UserManager`).

### 5. Coupling & Cohesion

Flag services with 5+ dependencies; god classes; `Utility`/`Helper` grab-bags of unrelated methods; feature envy (a method using another class's data more than its own).

### 6. Dependency Management

Flag circular dependencies; service-locator anti-pattern; static dependencies (hard to test); inappropriate singletons.

## Detection Methodologies

**Circular dependencies:** Build a dependency graph from constructor/injected params (grep constructor parameters that are interfaces/services). DFS with visited tracking; if A → … → A, it's circular.

**SRP violations — thresholds:**

| Metric | OK | Warning | Violation |
|--------|----|---------|-----------|
| Methods per class | ≤10 | 11–15 | >15 |
| Ctor dependencies | ≤4 | 5–6 | >6 |
| Lines per class | ≤300 | 301–500 | >500 |
| Distinct concerns | 1 | 2 | >2 |

Concern detection: count distinct method-name verb prefixes (`Send*`, `Get*`, `Calculate*`, `Validate*`); 3+ → likely SRP violation.

**Layer violations:** Layer 0 Controllers → only Layer 1; Layer 1 Services → Layer 2–3; Layer 2 Repos → Layer 3; Layer 3 Entities → none. Grep for controllers referencing DbContext/ORM types, or repos referencing HTTP/request objects.

**God classes:** >500 LOC, >15 methods, >10 fields, >6 ctor deps, or total cyclomatic >50. NOT a god class: entity with many properties but no methods; orchestration service that only delegates.

**Abstraction leaks:** Grep for ORM/DB-specific types (query builders, DB contexts, SQL connections) appearing in interface signatures or service-layer files — they belong in the data-access layer only.

## False-Positive Guidance

**Accept (NOT violations):**

| Pattern | Why OK |
|---------|--------|
| Controller with 8 actions | Distinct HTTP endpoints, not SRP |
| Service with many small related methods | Single domain concept |
| `new` for DTOs/exceptions | Value objects don't need DI |
| Stateless utility for pure functions | Math/string formatting |
| 6 deps on an orchestrator | Orchestrators coordinate |

**Challenge (likely violations):**

| Pattern | Why suspicious |
|---------|----------------|
| Service creating other services | Should be injected |
| 3+ unrelated method groups | SRP |
| Repository with business logic | Layer violation |
| Interface with 10+ methods | ISP |

## Output Layout

```markdown
## Architecture Review Report

### Summary
- Files Reviewed / Critical / High / Medium / Low: [counts]

### Layer Diagram
[Controllers] → [Services] → [Repositories] → [Database]

### Critical 🔴 / High 🟠 / Medium 🟡 / Low 🟢
#### Issue: [name]
**Location**: `file:line`
**Description**: [violation]
**Impact**: [consequence]
**Fix**: [specific change]

### Pattern Consistency
| Pattern | Consistent? | Notes |

### Good Patterns Observed ✅
### Verdict: APPROVED / NEEDS FIXES
### Required Actions
```

## Success Criteria

Complete when: all classes checked against SOLID; layer dependencies mapped + validated; circular-dependency check performed; pattern consistency assessed; every finding has location + fix; explicit verdict given.

## Core Principles

Depend on abstractions, not implementations · separate concerns · follow established patterns over "better" ones · respect layer boundaries · favor composition over inheritance.
