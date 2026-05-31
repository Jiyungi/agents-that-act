# Implementation Plan: PackGuard

## Overview

This plan implements PackGuard (TypeScript / Node / Vercel) and is **grouped by person** so all three workstreams run in parallel:

- **Person A — Fetcher + Backend** (local `packguard-agent` + serverless `/api/resolve`)
- **Person B — Storage + Frontend** (Tigris `Storage_Service` + `Frontend_UI` + shared report/verdict logic)
- **Person C — Daytona Experiment** (independent, non-blocking feasibility spike)

The interface contracts (`Scan_Result_Contract`, `Report_Schema`, upload-trigger, `Storage_Service`, gallery/list) are defined up front in the **Shared Setup & Interface Contracts** section, plus shared stubs/fixtures, so Person A and Person B can build against agreed seams without blocking each other. Cross-person integration happens once in the **Shared Integration & Wiring** section. Person C touches none of A/B/UI code.

**Testing strategy (dual approach):**
- **Property-based tests (PBT)** cover the 20 correctness properties over pure logic (safe-tar containment, normalization, fail-safe defaults, verdict derivation, key construction, retries, render/framing completeness, Daytona dependency-skipping). Library: `fast-check`, **minimum 100 runs** per property (`fc.assert(fc.property(...), { numRuns: 100 })`), each tagged `// Feature: packguard, Property {N}: {property text}`.
- **Example / integration / smoke tests** cover wiring, error branches, UI interaction, and external-service behavior (npm, Tigris, Vercel).
- Test sub-tasks are marked optional with `*` and may be skipped for a faster MVP. Core implementation sub-tasks are never optional.

## Tasks

## Shared Setup & Interface Contracts (do first)

- [x] 1. Project scaffold and shared interface contracts
  - [x] 1.1 Initialize project structure and tooling
    - Create the single-repo layout: `web/` (Frontend_UI), `api/` (Vercel serverless functions), `packguard-agent/` (local loopback agent), and `shared/` (types).
    - Configure TypeScript, `fast-check`, and a test runner (Vitest), plus npm scripts.
    - Add `.env.example` entries / config loader for `TIGRIS_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TIGRIS_BUCKET`, `RISK_THRESHOLD` (default 50), `LOCAL_AGENT_PORT` (default 3939), `SCAN_TARGET_DIR` (default `./scan-target`), `NPM_REGISTRY_BASE` (default `https://registry.npmjs.org`).
    - _Requirements: 16.1, 16.2_
  - [x] 1.2 Define the shared TypeScript contract types (the integration seams)
    - `ScanResultContract` (Interface 1); `ReportSchema` with `Verdict`, `Severity`, `Finding` (Data Models, Req 12); `ScanRecord` (Req 7.5); `ResolvedPackage` and `SafeTarLimits`; `GalleryResult` (Interface 5); `FetchErrorType` and `UploadErrorType` enums.
    - These are the agreed stubs Person A and Person B build against.
    - _Requirements: 6.1, 12.1, 12.2, 12.3, 12.6, 12.7, 7.5, 9.1_
  - [x] 1.3 Provide shared stubs and fixtures for cross-person integration
    - In-memory `StorageService` fake (uploadScan/getPublicReportUrl/listScans), a fake `Local_Fetcher_Agent` fetch/upload response, and sample `Report_Schema` + raw-Opsera-output fixtures (well-formed and malformed).
    - Lets Person A's upload trigger and Person B's UI integrate before the real implementations exist.
    - _Requirements: 6.7, 7.1, 9.1_

## Person A — Fetcher + Backend (Node / Vercel)

- [x] 2. Package-name validation and npm resolution
  - [x] 2.1 Implement the package-name validator
    - Enforce npm naming constraints (non-empty, ≤ 214 chars, permitted characters), support `@scope/name`, and provide encode/decode that round-trips a scoped name to a safe registry/Tigris key.
    - Reject invalid names with `INVALID_PACKAGE_NAME` **before** any registry query.
    - _Requirements: 1.6, 1.7_
  - [ ]* 2.2 Property test: package-name validation and scoped-name round-trip
    - **Property 6: Package-name validation and scoped-name handling**
    - **Validates: Requirements 1.6, 1.7**
  - [x] 2.3 Implement npm resolution in serverless `/api/resolve`
    - Resolve latest (`dist-tags.latest`) when no version given, exact version otherwise; produce `ResolvedPackage` (tarballUrl, integrity); 10s registry timeout.
    - Map failures to `PACKAGE_UNRESOLVED`, `VERSION_UNRESOLVED`, `REGISTRY_UNAVAILABLE` with no partial result.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.8_
  - [ ]* 2.4 Property test: version resolution
    - **Property 7: Version resolution**
    - **Validates: Requirements 1.2, 1.3**
  - [ ]* 2.5 Example tests: resolution error branches
    - Nonexistent package (1.4), nonexistent version (1.5), registry network error / timeout (1.8).
    - _Requirements: 1.4, 1.5, 1.8_

- [x] 3. Tarball download with size cap
  - [x] 3.1 Implement tarball download from npm metadata
    - Download `.tgz` from the metadata tarball URL within 30s; abort and discard partial bytes on refused/interrupted/non-2xx/timeout (`DOWNLOAD_FAILED`); abort over 100 MB (`DOWNLOAD_TOO_LARGE`); never execute downloaded content.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_
  - [ ]* 3.2 Integration test: download success and size boundary
    - Successful download references content (2.1, 2.2); just-over-100 MB aborts (2.4).
    - _Requirements: 2.1, 2.2, 2.4_

- [x] 4. Safe-tar Extractor (path-traversal / link / bomb defenses)
  - [x] 4.1 Implement the streaming safe-tar `Extractor`
    - Follow the Safe-Tar Extraction Algorithm: streaming `tar-stream` over a gunzip counting stream; resolve canonical root once; lexical containment check; no-follow directory creation and file writes (`O_NOFOLLOW`); intermediate-symlink re-check; write symlink/hardlink entries as inert placeholders (never live links).
    - Distinct violation types: `PATH_TRAVERSAL`, `ABSOLUTE_PATH`, `LINK_TARGET_ESCAPE`; running counters abort over 250 MB uncompressed or 10,000 entries (`RESOURCE_LIMIT_EXCEEDED`).
    - Empty-before precondition; rollback of all written paths on abort; `finally` cleanup removes the whole `Scan_Target_Directory` (success or abort).
    - _Requirements: 3.1, 3.6, 3.8, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - [ ]* 4.2 Property test: extraction containment
    - **Property 2: Extraction containment**
    - **Validates: Requirements 4.1, 3.1**
  - [ ]* 4.3 Property test: malicious-entry detection with distinct violation types and full rollback
    - **Property 3: Malicious-entry detection with distinct violation types and full rollback**
    - **Validates: Requirements 3.6, 4.2, 4.3, 4.4, 4.5**
  - [ ]* 4.4 Property test: resource-limit abort
    - **Property 4: Resource-limit abort**
    - **Validates: Requirements 3.8, 2.4**
  - [ ]* 4.5 Property test: isolation across scans (clean before and after)
    - **Property 5: Isolation across scans (clean before and after)**
    - **Validates: Requirements 4.6, 4.7**

- [x] 5. Inspect-without-installing safety guarantee
  - [x] 5.1 Wire the no-exec fetch+extract pipeline
    - Compose download → extract so the pipeline never runs an install command, never requires/imports/evaluates/`vm`-runs fetched files, ignores `preinstall`/`install`/`postinstall` lifecycle scripts, and treats all extracted content as read-only data; on any failure return a typed error and run cleanup without executing content.
    - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.7_
  - [ ]* 5.2 Property test: inspect without installing — no fetched code is ever executed
    - **Property 1: Inspect without installing — no fetched code is ever executed**
    - **Validates: Requirements 2.5, 3.1, 3.2, 3.3, 3.4, 3.5**
    - Spies on `child_process.spawn/exec`, `require`, dynamic `import`, `eval`, and `vm` must record zero invocations against fetched content.

- [x] 6. Editor_Launcher and Scan_Result_Contract
  - [x] 6.1 Implement the `Editor_Launcher`
    - Run `code ./scan-target/` within 10s on successful extraction and surface the `/security-scan` prompt; on missing `code` return `VSCODE_UNAVAILABLE`; on launch failure/timeout return `VSCODE_LAUNCH_FAILED`; both state the manual open command and **retain** the scan-target.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [ ]* 6.2 Example tests: launcher branches
    - Launch success (5.1), prompt shown (5.2), `code` missing (5.3), launch failure (5.4).
    - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - [x] 6.3 Produce the `Scan_Result_Contract`
    - On successful extraction emit non-empty `packageName`, `version`, `sourcePath`, `reportPath`, with `reportPath` pre-computed inside the scan-target (e.g. `./scan-target/.packguard/report.json`).
    - _Requirements: 6.1, 6.2_
  - [ ]* 6.4 Property test: Scan_Result_Contract completeness
    - **Property 8: Scan_Result_Contract completeness**
    - **Validates: Requirements 6.1, 6.2**

- [ ] 7. Local_Fetcher_Agent loopback server and upload trigger
  - [x] 7.1 Implement the loopback agent server (`127.0.0.1:3939`)
    - `POST /local/fetch` wires resolve input → download → extract → launch → `Scan_Result_Contract`; `GET /local/health` reports `codeCliAvailable`; bind to localhost only; map `FetchErrorType` to HTTP responses.
    - _Requirements: 5.1, 5.2, 6.1, 6.2_
  - [-] 7.2 Implement the upload-trigger interface (`POST /local/upload`)
    - Read `reportPath`, normalize to `Report_Schema`, derive the verdict, hand `Scan_Report` + `Source_Snapshot` to the `Storage_Service`, return success on confirmation; `REPORT_MISSING` guard (no storage call); `UPLOAD_FAILED` retains the report on 30s no-confirm/failure.
    - Builds against the `StorageService` stub from task 1.3 (see Notes); real wiring is task 17.1.
    - _Requirements: 6.3, 6.4, 6.5, 6.6, 6.7_
  - [ ]* 7.3 Example tests: upload-trigger branches
    - Report present (6.3, 6.4), report-missing guard (6.5), storage timeout/failure retains report (6.6).
    - _Requirements: 6.3, 6.4, 6.5, 6.6_

- [ ] 8. Checkpoint — Person A
  - Ensure all tests pass, ask the user if questions arise.

## Person B — Storage + Frontend (Tigris + UI)

- [ ] 9. Report_Schema normalizer and fail-safe defaults
  - [ ] 9.1 Implement the report normalizer
    - Map raw Opsera output to `Report_Schema` enforcing field presence, string-length bounds, `findings` of 0–1000, `verdict` exactly `SAFE`/`RISKY`, `severity` in `LOW`/`MEDIUM`/`HIGH`/`CRITICAL`; ensure JSON serialize→parse round-trips equal; apply pessimistic fail-safe defaults for missing fields (verdict→RISKY, riskScore→100, findings→[], severity→CRITICAL, lineNumber→0, required strings→placeholder).
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_
  - [ ]* 9.2 Property test: report normalization conforms to schema and round-trips
    - **Property 9: Report normalization conforms to schema and round-trips**
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.6, 12.7**
  - [ ]* 9.3 Property test: fail-safe defaults are pessimistic
    - **Property 10: Fail-safe defaults are pessimistic**
    - **Validates: Requirements 12.5**

- [ ] 10. Verdict derivation from risk score
  - [ ] 10.1 Implement `deriveVerdict(riskScore, T)` and threshold config
    - Pure function: `SAFE` when `riskScore < T`, `RISKY` when `riskScore >= T`; default `T = 50`; apply Req 12.5 defaults first, then reject a present-but-out-of-range or missing `riskScore` with `INVALID_RISK_SCORE` and assign no verdict.
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.6_
  - [ ]* 10.2 Property test: verdict derivation is correct and deterministic
    - **Property 11: Verdict derivation is correct and deterministic**
    - **Validates: Requirements 13.1, 13.2, 13.3, 13.4**
  - [ ]* 10.3 Property test: invalid risk score is rejected
    - **Property 12: Invalid risk score is rejected**
    - **Validates: Requirements 13.6**

- [ ] 11. Storage_Service (Tigris upload, keys, public URL, retries)
  - [ ] 11.1 Implement the `Storage_Service` over Tigris (S3-compatible)
    - `uploadScan` writes report + source snapshot under `reports/{encodedName}/{version}/report.json` and `sources/{encodedName}/{version}/source.tgz`; persist `ScanRecord` at `records/{encodedName}/{version}.json` with frozen `verdict`, `riskScore`, `thresholdUsed`, and a UTC ISO-8601 `createdAt`; reject missing/empty name or version with `INVALID_IDENTIFIER` (no record); bounded ≤ 3 attempts per operation (`UPLOAD_FAILED` → no record); mint `Public_Report_URL` with ≤ 3 attempts, retaining the report and recording `publicReportUrl = null` on failure.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 8.1, 8.2, 8.5, 13.5_
  - [ ]* 11.2 Property test: Tigris key construction includes name and version
    - **Property 14: Tigris key construction includes name and version**
    - **Validates: Requirements 7.3, 7.4**
  - [ ]* 11.3 Property test: Scan_Record completeness with UTC timestamp
    - **Property 15: Scan_Record completeness with UTC timestamp**
    - **Validates: Requirements 7.5, 8.5**
  - [ ]* 11.4 Property test: persisted verdict is immutable to threshold changes
    - **Property 13: Persisted verdict is immutable to threshold changes**
    - **Validates: Requirements 13.5**
  - [ ]* 11.5 Property test: bounded retries with correct fallback
    - **Property 16: Bounded retries with correct fallback**
    - **Validates: Requirements 7.7, 8.2**
  - [ ]* 11.6 Integration tests: Tigris upload and public URL
    - Upload report + snapshot (7.1, 7.2); public URL served unauthenticated within 3s (8.1, 8.3); unknown URL returns not-found (8.4).
    - _Requirements: 7.1, 7.2, 8.1, 8.3, 8.4_

- [ ] 12. Serverless record persistence and gallery list
  - [ ] 12.1 Implement `/api/scan-records` (persist Scan_Record)
    - Serverless function that persists a `ScanRecord` via the `Storage_Service`.
    - _Requirements: 7.5, 16.1_
  - [ ] 12.2 Implement `listScans` and `/api/scans` (gallery list)
    - Return a `GalleryResult` capped at 100, one record per scanned version; `partial: true` when some records fail; `unavailable: true` with no partial data when the store is down; empty list when the store is empty.
    - _Requirements: 9.1, 9.3, 9.4, 9.6, 9.8_
  - [ ]* 12.3 Property test: gallery cap, per-version entries, and partial semantics
    - **Property 17: Gallery cap, per-version entries, and partial semantics**
    - **Validates: Requirements 9.1, 9.3, 9.4**
  - [ ]* 12.4 Example tests: gallery branches
    - Empty store → empty list message (9.6, 9.7); store unavailable (9.8).
    - _Requirements: 9.6, 9.7, 9.8_

- [ ] 13. Honest-framing copy module
  - [ ] 13.1 Implement `framing.ts`
    - Centralize approved copy: the "automated static security review and risk scoring" label, Opsera/static-analysis attribution, the static-analysis disclaimer, and the forbidden-term list ("behavioral", "dynamic analysis", "runtime detection", "malware detection").
    - _Requirements: 17.1, 17.2, 17.3, 17.4_

- [ ] 14. Frontend_UI — search and scan flow
  - [ ] 14.1 Implement the search input and Scan control flow
    - Accept 1–214 chars; reject empty/whitespace with "package name required"; send a single scan request (to `/api/resolve` then the local agent); show in-progress indicator and disable control to block duplicates; re-enable and clear indicator on success/error/timeout; retain entered name on error; client 10s/30s timeouts; show "scanning service unavailable" on routing failure.
    - Builds against the fetch stub from task 1.3 (see Notes); real wiring is task 17.1.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 16.3, 16.4, 16.5_
  - [ ]* 14.2 Example tests: UI flow branches
    - Single request (10.2), in-progress lock (10.4), success reset (10.5), error reset + input retained (10.6), 30s timeout (10.7, 16.4), service unavailable (16.5).
    - _Requirements: 10.2, 10.4, 10.5, 10.6, 10.7, 16.4, 16.5_

- [ ] 15. Frontend_UI — verdict card and gallery
  - [ ] 15.1 Implement the verdict card
    - Show `Verdict` and `riskScore` (integer 0–100), every finding's category/filePath/lineNumber and the referenced source line, the shareable `Public_Report_URL`; fallbacks for SAFE-with-zero-findings (11.5), no report (11.6), source line unavailable (11.7), and link unavailable (11.8); all verdict-accompanying copy drawn from `framing.ts`.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 17.1, 17.3, 17.4_
  - [ ] 15.2 Implement the gallery UI
    - Render each record's name, version, verdict, score, and report link; clicking opens the `Public_Report_URL`; show "no scanned packages" on empty list.
    - _Requirements: 9.2, 9.5, 9.7_
  - [ ]* 15.3 Property test: render completeness for gallery entries and verdict cards
    - **Property 18: Render completeness for gallery entries and verdict cards**
    - **Validates: Requirements 9.2, 11.1, 11.2, 11.3, 11.4**
  - [ ]* 15.4 Property test: honest framing is always present and forbidden terms are always absent
    - **Property 19: Honest framing is always present and forbidden terms are always absent**
    - **Validates: Requirements 17.1, 17.2, 17.3, 17.4**

- [ ] 16. Checkpoint — Person B
  - Ensure all tests pass, ask the user if questions arise.

## Person C — Daytona Experiment (independent, non-blocking)

> Person C must NOT import or modify `Fetcher_Service`, `Storage_Service`, or `Frontend_UI` code (Req 14.5). Its tasks depend only on the project scaffold and a self-contained `DaytonaStepResult` type, so they can run in parallel from the start and never block Person A or Person B.

- [ ] 18. Daytona experiment harness and deliverable
  - [ ] 18.1 Implement the Daytona step state machine
    - Define `DaytonaStepResult` (self-contained, in the Person C module) and the ordered step graph (`SANDBOX_SPINUP` → `REMOTE_SSH` → `INSTALL_COPILOT` / `INSTALL_OPSERA_MCP` → `OPSERA_OAUTH`); when a step fails, mark every directly or transitively dependent step `NOT_ATTEMPTED`.
    - _Requirements: 15.6_
  - [ ]* 18.2 Property test: Daytona dependency skipping
    - **Property 20: Daytona dependency skipping**
    - **Validates: Requirements 15.6**
  - [ ] 18.3 Implement the timed step runner
    - Attempt each step within its timeout (120 / 60 / 300 / 300 / 120 s) and record outcome (`SUCCESS`/`FAILURE`/`NOT_ATTEMPTED`), a UTC ISO timestamp, and an observed reason on failure (including timeout-exceeded).
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.7, 15.8_
  - [ ] 18.4 Implement the feasibility deliverable generator
    - From the recorded step log, produce the Markdown deliverable: a YES/NO conclusion with execution evidence; if YES, step-by-step reproduction instructions and the local→Daytona fetch-swap plan; if NO, the documented blockers; assert no A/B/UI source was modified.
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5_

## Shared Integration & Wiring

- [ ] 17. End-to-end wiring and smoke
  - [ ] 17.1 Replace stubs with real implementations and wire the system together
    - Connect `Frontend_UI` → `/api/resolve` → `Local_Fetcher_Agent` (`/local/fetch`, `/local/upload`) → `Storage_Service` → `/api/scan-records` and `/api/scans`; remove the task-1.3 stubs so there is no orphaned/un-integrated code.
    - _Requirements: 6.7, 16.1, 16.2, 16.3_
  - [ ]* 17.2 Integration test: full happy path
    - resolve → fetch/extract → upload → persist record → gallery list → verdict card render.
    - _Requirements: 16.3, 7.1, 9.1_
  - [ ]* 17.3 Smoke tests: routing and configuration
    - `/api/resolve`, `/api/scans`, `/api/scan-records` handlers registered; upload-trigger route exists; Tigris bucket/credentials reachable.
    - _Requirements: 16.1, 16.2, 6.7_

- [ ] 19. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- **Workstream grouping:** tasks are grouped by person; the numbering is continuous so the dependency graph below can reference leaf sub-tasks across people.
- **Contracts first:** task 1.2 pins the integration seams (`Scan_Result_Contract`, `Report_Schema`, `ScanRecord`, `GalleryResult`, error enums). Once agreed, A and B build independently.
- **Safe-to-stub tasks (integrate against task 1.3 fakes/fixtures, not real peers):**
  - Person A task 7.2 (upload trigger) calls the in-memory `StorageService` fake.
  - Person B tasks 14.1 / 15.1 / 15.2 render against the fetch/upload + gallery fakes and `Report_Schema` fixtures.
  - The real cross-person wiring (removing all stubs) happens once in task 17.1.
- **Person C is non-blocking:** tasks 18.1–18.4 never appear as a prerequisite for any Person A or Person B task and may proceed in parallel from the first wave.
- **Property-based tests:** every `*` PBT sub-task uses `fast-check` with a minimum of 100 runs and is tagged `// Feature: packguard, Property {N}: {property text}`. Properties 1–20 map: 1–8 → Person A (Extractor / agent / resolution), 9–17 → Person B (normalizer / verdict / Storage / gallery), 18–19 → Person B (render / framing), 20 → Person C.
- **Optional tests:** sub-tasks marked `*` (unit, property, integration, smoke) can be skipped for a faster MVP; core implementation sub-tasks are never optional.
- **Checkpoints** (tasks 8, 16, 19) ensure incremental validation; they and top-level parent tasks are excluded from the dependency graph.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "13.1", "18.1"] },
    { "id": 2, "tasks": ["1.3", "2.1", "2.3", "3.1", "4.1", "6.1", "9.1", "10.1", "11.1", "18.2", "18.3"] },
    { "id": 3, "tasks": ["2.2", "2.4", "2.5", "3.2", "4.2", "4.3", "4.4", "4.5", "5.1", "6.2", "6.3", "9.2", "9.3", "10.2", "10.3", "11.2", "11.3", "11.4", "11.5", "11.6", "12.1", "12.2", "14.1", "18.4"] },
    { "id": 4, "tasks": ["5.2", "6.4", "7.1", "12.3", "12.4", "14.2", "15.1", "15.2"] },
    { "id": 5, "tasks": ["7.2", "15.3", "15.4"] },
    { "id": 6, "tasks": ["7.3", "17.1"] },
    { "id": 7, "tasks": ["17.2", "17.3"] }
  ]
}
```
