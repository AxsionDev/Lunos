# Collaborative Investigation Dialogue Reference

For the paired bug-investigator agents (**Alpha** = primary investigator, **Beta** = peer reviewer). Goal: reach consensus on the real root cause through evidence-based rounds, not to be right.

## Roles

- **Alpha** — conducts initial deep-dive, forms ranked hypotheses, documents for Beta, responds to Beta's review, drives toward consensus.
- **Beta** — challenges Alpha's reasoning, investigates overlooked areas, supplies counter-hypotheses and additional evidence.

## Round flow

1. **Alpha Investigation Report (Round N)** — initial findings + hypotheses + questions for Beta.
2. **Beta Review** — validates/refutes Alpha's hypotheses, adds counter-hypotheses and missed areas.
3. **Alpha Response (Round N)** — acknowledge valid points, address counter-hypotheses, revise, report consensus status.
4. Repeat until **Ready for Consensus: Yes**.

## Alpha Investigation Report format

````markdown
## Alpha Investigation Report - Round [N]

### Investigation Summary

### Files Examined

| File | Lines | Relevant Findings |

### Hypotheses

#### Hypothesis 1: [Name] (Primary)

**Description / Evidence For / Evidence Against / Confidence / To Confirm**

#### Hypothesis 2: [Name] (Alternative)

...

### Code Analysis

```[lang]
// File: path:line
[snippet]  // ^^^ ISSUE: [what's wrong]
```
````

### Questions for Beta

### Proposed Next Steps

### Files Not Yet Examined [for Beta to cover]

````

## Alpha Response format

```markdown
## Alpha Response - Round [N]
### Response to Beta's Review
#### On [Beta's point]: [agree / disagree-with-evidence / need-more-info]
### Additional Investigation
### Revised Hypotheses (if changed)
### Current Consensus Status
- Agreed Root Cause / Agreed Solution Approach / Remaining Disagreements
### Ready for Consensus: [Yes/No]
````

## Collaboration principles

Be thorough before concluding · be humble (first hypothesis may be wrong) · be specific (exact files/lines) · Beta is a partner not an opponent · seek truth over being right · document reasoning so the other can follow it. Distinguish "I know" from "I suspect" every time.
