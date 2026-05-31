/**
 * Shared error-type contracts for PackGuard's two failure surfaces.
 *
 * These are the agreed seam between Person A (Local_Fetcher_Agent /
 * Backend_API) and Person B (Storage_Service / Frontend_UI). They are
 * expressed as `as const` objects plus a derived string-literal union (NOT
 * TS `enum`) so they stay friendly to the project's `isolatedModules` /
 * `verbatimModuleSyntax` compiler options: the object provides runtime values
 * to reference, while the type provides the closed value set.
 *
 * See design.md → "Interface 2 — Local_Fetcher_Agent HTTP API" and
 * "Interface 3 — Upload-Trigger Interface".
 */

/**
 * Failure modes surfaced by the fetch/extract/launch pipeline (Reqs 1–5).
 *
 * The three link/path violation types are intentionally kept **distinct**
 * (Reqs 4.2–4.5):
 *  - PATH_TRAVERSAL    — an entry escapes the scan target via `../` (Req 4.2)
 *  - ABSOLUTE_PATH     — an entry specifies an absolute path (Req 4.3)
 *  - LINK_TARGET_ESCAPE — a symlink/hardlink target, or an intermediate
 *                         symlink component, resolves outside the target
 *                         (Reqs 4.4, 4.5)
 */
export const FetchErrorType = {
  /** Submitted name is empty, > 214 chars, or has disallowed chars (Req 1.7). */
  INVALID_PACKAGE_NAME: "INVALID_PACKAGE_NAME",
  /** Named package does not exist on the registry (Req 1.4). */
  PACKAGE_UNRESOLVED: "PACKAGE_UNRESOLVED",
  /** Requested version does not exist for the package (Req 1.5). */
  VERSION_UNRESOLVED: "VERSION_UNRESOLVED",
  /** Registry network error or no response within 10s (Req 1.8). */
  REGISTRY_UNAVAILABLE: "REGISTRY_UNAVAILABLE",
  /** Tarball download refused/interrupted/non-2xx/timeout (Req 2.3). */
  DOWNLOAD_FAILED: "DOWNLOAD_FAILED",
  /** Downloaded tarball exceeds the 100 MB compressed cap (Req 2.4). */
  DOWNLOAD_TOO_LARGE: "DOWNLOAD_TOO_LARGE",
  /** Entry resolves outside the scan target via traversal (Req 4.2). */
  PATH_TRAVERSAL: "PATH_TRAVERSAL",
  /** Entry specifies an absolute path (Req 4.3). */
  ABSOLUTE_PATH: "ABSOLUTE_PATH",
  /** Link target or intermediate symlink escapes the target (Reqs 4.4, 4.5). */
  LINK_TARGET_ESCAPE: "LINK_TARGET_ESCAPE",
  /** Uncompressed size > 250 MB or entry count > 10,000 (Req 3.8). */
  RESOURCE_LIMIT_EXCEEDED: "RESOURCE_LIMIT_EXCEEDED",
  /** Download/extraction did not complete within 30s (Req 3.7). */
  EXTRACTION_TIMEOUT: "EXTRACTION_TIMEOUT",
  /** The `code` CLI is not available on the host (Req 5.3). */
  VSCODE_UNAVAILABLE: "VSCODE_UNAVAILABLE",
  /** `code` exists but launch failed or timed out within 10s (Req 5.4). */
  VSCODE_LAUNCH_FAILED: "VSCODE_LAUNCH_FAILED",
} as const;

/** Closed set of fetch/extract/launch failure types (Reqs 1–5). */
export type FetchErrorType = (typeof FetchErrorType)[keyof typeof FetchErrorType];

/**
 * Failure modes surfaced by the upload-trigger interface (Req 6, Req 7.6,
 * Req 13.6). See design.md → "Interface 3 — Upload-Trigger Interface".
 */
export const UploadErrorType = {
  /** No Scan_Report exists at `reportPath`; storage is not called (Req 6.5). */
  REPORT_MISSING: "REPORT_MISSING",
  /** Missing/empty package name or version on upload (Req 7.6). */
  INVALID_IDENTIFIER: "INVALID_IDENTIFIER",
  /** Storage did not confirm within 30s or reported a failure (Req 6.6). */
  UPLOAD_FAILED: "UPLOAD_FAILED",
  /** riskScore is missing or outside 0..100 inclusive (Req 13.6). */
  INVALID_RISK_SCORE: "INVALID_RISK_SCORE",
} as const;

/** Closed set of upload-trigger failure types (Reqs 6, 7.6, 13.6). */
export type UploadErrorType = (typeof UploadErrorType)[keyof typeof UploadErrorType];
