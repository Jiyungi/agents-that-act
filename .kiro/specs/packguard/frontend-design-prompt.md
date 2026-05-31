# Claude Design Prompt — PackGuard Frontend (Person B)

> Paste everything inside the `=== PROMPT START ===` / `=== PROMPT END ===` block into Claude (Claude.ai / Artifacts / Claude Code) to generate the PackGuard frontend. It is written so the generated UI binds to the **exact** backend contracts and API endpoints defined in `.kiro/specs/packguard/design.md`, so it drops into the `web/` workstream with no contract drift.

---

=== PROMPT START ===

You are designing and building the **frontend** for **PackGuard**, a web app that checks whether an npm package is safe to install **before** you install it. I need a complete, production-quality React + TypeScript frontend that integrates seamlessly with an already-specified backend. Follow the contracts and behaviors below **exactly** — field names, types, endpoints, states, and copy are fixed integration seams shared with the backend team. Do not rename fields or invent new endpoints.

## 1. Product in one paragraph

A developer types an npm package name into the UI and clicks **Scan**. PackGuard fetches the package source from the npm registry, **safely unpacks it without ever installing or executing it**, opens it in VS Code, and a human operator runs a static security scan (Opsera DevSecOps Agent: Semgrep + Gitleaks) via `/security-scan` in GitHub Copilot Chat. The resulting report is normalized, scored, stored, and shown as a **SAFE / RISKY** verdict card with the actual risky code lines and a public shareable link. Over time the scanned packages form a browsable **gallery**. The defining promise is **"inspect without installing."**

This is an **operator-driven** tool with a deliberate **manual step in the middle**. The UI must guide the user through three phases and hold state across the manual pause. Be honest in all copy: this is **automated static security review and risk scoring before install**, not behavioral/runtime malware detection.

## 2. Tech stack and constraints

- **Next.js (App Router) + React + TypeScript**, deployed on Vercel. Styling with Tailwind CSS. No heavy UI kit dependency unless it speeds you up; prefer clean hand-built components. If you use a component library, use shadcn/ui.
- The UI is served from the same Vercel deployment as the serverless API routes.
- The browser calls two kinds of backends:
  1. **Serverless API** on the same origin (`/api/*`) for npm resolution, gallery list, and record persistence.
  2. A **local loopback agent** at `http://127.0.0.1:3939` for the filesystem-bound steps (fetch/extract/launch/upload), because a serverless function cannot write a folder the operator's VS Code opens or read the local report file.
- All async calls must be cancelable and enforce client-side timeouts (see §6).
- Keep all user-facing copy in a single shared module `framing.ts` (see §8) — verdict-accompanying text must never be written ad hoc.

## 3. Shared TypeScript types (copy verbatim — these are the integration seams)

```typescript
export type Verdict  = "SAFE" | "RISKY";                       // case-sensitive
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";  // ordered low→high

export interface Finding {
  category:    string;  // 1..100 chars
  filePath:    string;  // 1..4096 chars
  lineNumber:  number;  // integer >= 0; 0 means "unspecified line"
  severity:    Severity;
  codeSnippet: string;  // 0..1000 chars; the actual risky source line(s). May be "".
}

export interface ReportSchema {
  packageName: string;     // 1..214 chars
  version:     string;     // 1..256 chars
  verdict:     Verdict;
  riskScore:   number;     // integer 0..100 inclusive
  findings:    Finding[];  // 0..1000 items
}

export interface ScanRecord {
  packageName:     string;
  version:         string;
  verdict:         Verdict;
  riskScore:       number;          // 0..100
  thresholdUsed:   number;          // threshold T frozen at creation time
  publicReportUrl: string | null;   // null if URL generation failed
  reportKey:       string;          // reports/{encodedName}/{version}/report.json
  sourceKey:       string;          // sources/{encodedName}/{version}/source.tgz
  createdAt:       string;          // UTC ISO 8601
}

export interface GalleryResult {
  records:     ScanRecord[];  // up to 100, one per scanned version
  partial:     boolean;       // true if some records could not be retrieved
  unavailable: boolean;       // true only when the data store is fully unavailable
}

// Returned by the local agent after a successful fetch+extract.
// Held in UI state across the manual scan handoff.
export interface ScanResultContract {
  packageName: string;
  version:     string;
  sourcePath:  string;   // absolute local path to ./scan-target/
  reportPath:  string;   // absolute local path where the operator's report is expected
}

export interface ResolvedPackage {  // returned by /api/resolve
  packageName: string;
  version:     string;
  tarballUrl:  string;
  integrity?:  string;
}

export type FetchErrorType =
  | "INVALID_PACKAGE_NAME" | "PACKAGE_UNRESOLVED" | "VERSION_UNRESOLVED"
  | "REGISTRY_UNAVAILABLE" | "DOWNLOAD_FAILED" | "DOWNLOAD_TOO_LARGE"
  | "PATH_TRAVERSAL" | "ABSOLUTE_PATH" | "LINK_TARGET_ESCAPE"
  | "RESOURCE_LIMIT_EXCEEDED" | "EXTRACTION_TIMEOUT"
  | "VSCODE_UNAVAILABLE" | "VSCODE_LAUNCH_FAILED";

export type UploadErrorType =
  | "REPORT_MISSING" | "INVALID_IDENTIFIER" | "UPLOAD_FAILED" | "INVALID_RISK_SCORE";

export interface ApiError {
  errorType: FetchErrorType | UploadErrorType | string;
  message: string;
  manualCommand?: string;  // present on VSCODE_* errors: the command to open the folder manually
}
```

## 4. API contract the UI calls (do not change shapes or paths)

**Serverless (same origin):**

```
POST /api/resolve
  req:  { packageName: string }
  200:  ResolvedPackage
  4xx/5xx: ApiError   // INVALID_PACKAGE_NAME | PACKAGE_UNRESOLVED | VERSION_UNRESOLVED | REGISTRY_UNAVAILABLE
  // Must respond within 10s; UI also enforces its own 10s timeout on this call.

GET /api/scans
  200:  GalleryResult

POST /api/scan-records         // usually called by the agent; UI does not call this directly
  req:  ScanRecord
  200:  { ok: true }
```

**Local loopback agent (`http://127.0.0.1:3939`):**

```
GET /local/health
  200:  { status: "ok", codeCliAvailable: boolean }

POST /local/fetch
  req:  { packageName: string, version?: string, tarballUrl: string, integrity?: string }
  200:  ScanResultContract
  4xx/5xx: ApiError   // any FetchErrorType

POST /local/upload
  req:  { uploadId: string }   // references the active scan; pass `${packageName}@${version}`
  200:  { scanRecord: ScanRecord }
  4xx/5xx: ApiError   // any UploadErrorType
```

## 5. The end-to-end flow the UI must orchestrate (three phases)

Implement this as an explicit state machine. Suggested states: `IDLE → RESOLVING → FETCHING → AWAITING_SCAN → UPLOADING → DONE`, plus `ERROR(phase, errorType, message, manualCommand?)`.

1. **Resolve (serverless).** On Scan: `POST /api/resolve { packageName }`. On success you get `ResolvedPackage`.
2. **Fetch + launch (local agent).** `POST http://127.0.0.1:3939/local/fetch { packageName, version, tarballUrl, integrity }`. On success you get a `ScanResultContract`. Store it in UI state — you need it across the manual pause.
3. **Manual handoff (human).** Show a clear instruction panel: *"VS Code opened on the package source. In GitHub Copilot Chat, run `/security-scan`, wait for it to finish, then click Upload report."* Show the resolved `packageName@version` and the `reportPath` for transparency. This is the durable pause — the UI sits in `AWAITING_SCAN` with an **Upload report** button enabled.
4. **Upload (local agent).** On Upload: `POST http://127.0.0.1:3939/local/upload { uploadId }`. On success you get `{ scanRecord }`. Fetch the full normalized report for the verdict card from `scanRecord.publicReportUrl` (it points at `report.json`) when present; otherwise render from the `scanRecord` fields plus a "no report available" state if no report can be loaded.
5. **Verdict card.** Render the verdict (see §7). Then refresh the gallery.

Before/around this, on first load call `GET /local/health`. If unreachable, show a non-blocking banner: *"Local PackGuard agent not detected. Start it with `npx packguard-agent` to fetch and scan packages."* If `codeCliAvailable` is false, warn early that VS Code's `code` CLI is missing.

## 6. Search + Scan control behavior (exact rules)

- Search input accepts **1–214 characters**. A package name may be a scoped name like `@scope/name`.
- If the user submits empty or whitespace-only input, **reject before any request** and show the validation message **"Package name is required."** (do not send a request).
- On valid submit, send **a single** scan request. While in progress: show an in-progress indicator and **disable the Scan control** to prevent duplicate submissions.
- On success, error, or timeout: remove the indicator and **re-enable** the control.
- On **error**: keep the entered package name in the input (do not clear it) and show a message identifying the failure.
- **Client timeouts:** abort the `/api/resolve` call at **10s**; abort the overall request flow at **30s**. On timeout show a timeout message and retain the input.
- If a scan request cannot be routed to the backend at all (network/route failure to `/api/*`): show **"Scanning service unavailable."**

## 7. Verdict card (exact rules)

Given a `ReportSchema` (and/or the `ScanRecord`):

- Always show the **Verdict** (`SAFE` or `RISKY`) and the **risk score as an integer 0–100**. Make SAFE visually calm (green) and RISKY visually urgent (red/amber), but never use forbidden terminology (§8).
- Show the verdict-derivation context honestly: risk score below the threshold → SAFE, at/above → RISKY (threshold default 50; the record carries `thresholdUsed`).
- **Findings list.** For **each** finding show: `category`, `filePath`, `lineNumber`, `severity` (as an ordered badge), and the **referenced source line** (`codeSnippet`).
  - If `codeSnippet` is empty/absent, render the finding with **"Source line unavailable."**
  - If `lineNumber` is `0`, present it as "unspecified line."
- **SAFE with zero findings:** show the SAFE verdict together with a message like **"No findings were reported."**
- **No report available:** if no completed report exists for the package, show **"No scan report is available for this package."**
- **Shareable link:** render `publicReportUrl` as a copyable shareable link. If it is `null`/absent, show **"Shareable link unavailable."**
- Sort findings by `severity` descending (CRITICAL → HIGH → MEDIUM → LOW) for scannability.

## 8. Honest framing (hard requirement — centralize in `framing.ts`)

Every piece of text accompanying a verdict (labels, descriptions, tooltips, gallery captions) must be drawn from a single `framing.ts` constants module. It must include:

- A label presenting results as an **"automated static security review and risk scoring."**
- **Attribution**: the scan was performed by the **Opsera DevSecOps Security Scan Agent using static analysis (Semgrep + Gitleaks)**.
- A **disclaimer**: *"Static analysis does not detect runtime or behavioral threats and does not guarantee the package is free of malicious behavior."*

**Forbidden terms (case-insensitive) anywhere in verdict-accompanying copy:** `behavioral`, `dynamic analysis`, `runtime detection`, `malware detection`. Do not use these or close paraphrases that assert behavioral/runtime/dynamic detection. Add a tiny unit-testable guard that asserts none of the forbidden terms appear in the exported framing strings.

## 9. Gallery (exact rules)

- On load, `GET /api/scans` → `GalleryResult`. Render each `ScanRecord` as a card/row showing: **package name, version, verdict, risk score, and a link to `publicReportUrl`**.
- Clicking an entry **opens its `publicReportUrl`** (new tab). If `publicReportUrl` is null, disable the link and show "Shareable link unavailable."
- Multiple versions of the same package each appear as their own entry.
- **Empty** (`records: []`): show **"No scanned packages yet."**
- **Partial** (`partial: true`): render the records you have, plus a subtle notice **"Some records could not be loaded."**
- **Unavailable** (`unavailable: true`): show **"The gallery could not be loaded."** and render no partial data.

## 10. Visual direction

- Trustworthy security-tooling aesthetic: clean, high-contrast, dense-but-legible. Dark mode primary, light mode acceptable.
- A prominent hero with the search box and a one-line honest tagline (e.g. "Inspect npm packages before you install — automated static security review.").
- Clear three-phase progress affordance (Resolve → Fetch & open in VS Code → Run scan → Upload) so the manual handoff never confuses the user.
- Verdict color system: SAFE = green, RISKY = red; severity badges: LOW=slate, MEDIUM=amber, HIGH=orange, CRITICAL=red. Accessible color contrast (WCAG AA) and never rely on color alone — always pair with text/icons.
- Monospace for code snippets, file paths, package names, and commands.
- Keyboard accessible, screen-reader friendly (proper roles/labels, focus management when state changes, live-region announcements for verdict results and errors).

## 11. Deliverables

1. A complete Next.js + TypeScript + Tailwind frontend implementing the flow above.
2. `shared/types.ts` containing the §3 types verbatim.
3. `lib/api.ts` with typed client functions for every §4 endpoint, including `AbortController`-based timeouts (10s resolve, 30s overall) and typed `ApiError` handling.
4. A `useScanFlow` hook (or equivalent) implementing the §5 state machine.
5. Components: `SearchBar`, `ScanProgress` (three-phase), `ManualHandoffPanel`, `VerdictCard`, `FindingItem`, `Gallery`, `GalleryEntry`, `AgentHealthBanner`.
6. `framing.ts` with all approved copy and the forbidden-term guard.
7. Lightweight states for every branch in §6, §7, §9 (loading, empty, error, timeout, partial, unavailable, all fallbacks).

Generate clean, well-typed, commented code. Where you must choose a detail not specified here, pick the simplest option consistent with the contracts and note it briefly. Do not change any field names, endpoint paths, error-type strings, or verdict/severity literals — they are shared with the backend.

=== PROMPT END ===
