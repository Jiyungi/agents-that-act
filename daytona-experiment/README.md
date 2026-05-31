# Daytona Sandbox Experiment (Person C)

Independent, non-blocking feasibility spike: can PackGuard's npm fetch **and** the
Opsera security scan run entirely inside an isolated Daytona sandbox, so untrusted
package code never touches a real machine?

**Answer: YES.** Full write-up, evidence, reproduction steps, and the plan to swap
the local fetch step for a Daytona-sandboxed one are in **[FEASIBILITY.md](./FEASIBILITY.md)**.

## Contents

- `FEASIBILITY.md` — the deliverable (YES/NO conclusion, step results, repro guide,
  local→Daytona swap plan, known gotchas).
- `sample-reports/` — real scanner output pulled from the sandbox after scanning
  `left-pad@1.3.0` (verdict: 🟢 SAFE, zero findings):
  - `gitleaks-report.json` — secrets scan (`[]`)
  - `semgrep-report.json` — SAST (`results:[]`)
  - `checkov-report.json` — IaC (all zero)
  - `normalized-report.json` — the same result mapped into PackGuard's shared
    `Report_Schema` (Req 12) for Person B.

## Scope note

This experiment does not modify Person A's Fetcher/Backend, Person B's
Storage/Frontend, or any shared contract (Req 14.5). It only documents feasibility
and a migration path.
