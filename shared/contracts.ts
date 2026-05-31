/**
 * Shared TypeScript contract types — the integration seams between the three
 * PackGuard workstreams (Person A: Fetcher + Backend, Person B: Storage +
 * Frontend, Person C: Daytona experiment uses its own self-contained types).
 *
 * These are the agreed stubs Person A and Person B build against. Field names
 * and shapes match the design doc's "Components and Interfaces" and "Data
 * Models" sections exactly; once agreed they must not drift, since both the
 * serverless layer and the local agent serialize/deserialize across them.
 */

// ---------------------------------------------------------------------------
// Interface 1 — Scan_Result_Contract (Person A -> Person B)
// ---------------------------------------------------------------------------

/**
 * Produced by the Local_Fetcher_Agent after successful extraction (Req 6.1).
 * The handshake telling Person B what was scanned and where the report lands.
 * All four fields are non-empty when extraction succeeds.
 */
export interface ScanResultContract {
  /** Non-empty; the resolved package (supports `@scope/name`). */
  packageName: string;
  /** Non-empty; the exact resolved version. */
  version: string;
  /** Absolute local path to `./scan-target/` (the extracted source). */
  sourcePath: string;
  /** Absolute local path where the Operator's Scan_Report is expected (Req 6.2). */
  reportPath: string;
}

// ---------------------------------------------------------------------------
// Report_Schema (shared Person A <-> Person B, Req 12)
// ---------------------------------------------------------------------------

/** Top-level classification of a scanned package. Case-sensitive (Req 12.3). */
export type Verdict = "SAFE" | "RISKY";

/** Ordered finding severity. Case-sensitive (Req 12.7). */
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** A single security issue in a Scan_Report (Req 12.2). */
export interface Finding {
  /** 1..100 chars. */
  category: string;
  /** 1..4096 chars. */
  filePath: string;
  /** Integer >= 0; 0 = unspecified line. */
  lineNumber: number;
  severity: Severity;
  /** 0..1000 chars; the actual risky source line(s). */
  codeSnippet: string;
}

/**
 * The normalized report both sides agree on (Req 12.1). Raw Opsera output
 * (HTML/MD/JSON from Semgrep + Gitleaks) is mapped into this shape by the
 * normalizer in the upload trigger.
 */
export interface ReportSchema {
  /** 1..214 chars. */
  packageName: string;
  /** 1..256 chars. */
  version: string;
  verdict: Verdict;
  /** Integer 0..100 inclusive (Reqs 12.6, 13.1). */
  riskScore: number;
  /** 0..1000 items. */
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Scan_Record (persisted in Tigris, Req 7.5)
// ---------------------------------------------------------------------------

/**
 * A persisted entry combining package identity, verdict, risk score, report
 * location, and timestamp. Stored as JSON at
 * `records/{encodedName}/{version}.json`. The gallery lists these objects
 * (Req 9). Multiple versions of the same package each get their own record.
 */
export interface ScanRecord {
  /** 1..214 chars. */
  packageName: string;
  /** 1..256 chars. */
  version: string;
  /** Frozen at creation (Req 13.5). */
  verdict: Verdict;
  /** 0..100. */
  riskScore: number;
  /** The threshold T applied when this record was created (Req 13.5). */
  thresholdUsed: number;
  /** `null` if URL generation failed (Reqs 8.2, 11.8). */
  publicReportUrl: string | null;
  /** Tigris key: `reports/{encodedName}/{version}/report.json`. */
  reportKey: string;
  /** Tigris key: `sources/{encodedName}/{version}/source.tgz`. */
  sourceKey: string;
  /** UTC ISO 8601 timestamp. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Interface 5 — Gallery / List Interface (Person B)
// ---------------------------------------------------------------------------

/** Result of `listScans` / `GET /api/scans` (Req 9). */
export interface GalleryResult {
  /** Up to 100 (Req 9.1); one entry per scanned version (Req 9.3). */
  records: ScanRecord[];
  /** True if some records could not be retrieved (Req 9.4). */
  partial: boolean;
  /** True only when the data store is fully unavailable (Req 9.8). */
  unavailable: boolean;
}

// ---------------------------------------------------------------------------
// Resolution & internal fetch models (Person A, internal)
// ---------------------------------------------------------------------------

/** Output of `/api/resolve`. */
export interface ResolvedPackage {
  packageName: string;
  /** Latest if unspecified (Req 1.2), else exact (Req 1.3). */
  version: string;
  tarballUrl: string;
  /** shasum/integrity from npm metadata. */
  integrity?: string;
}

/** Resource limits enforced by the Extractor (Reqs 2.4, 3.8). */
export interface SafeTarLimits {
  /** 100 MB compressed download cap (Req 2.4). */
  maxTarballBytes: 100_000_000;
  /** 250 MB total uncompressed (Req 3.8). */
  maxUncompressedBytes: 250_000_000;
  /** Entry-count cap (Req 3.8). */
  maxEntryCount: 10_000;
}

/** The agreed default Safe-Tar limits, satisfying {@link SafeTarLimits}. */
export const SAFE_TAR_LIMITS: SafeTarLimits = {
  maxTarballBytes: 100_000_000,
  maxUncompressedBytes: 250_000_000,
  maxEntryCount: 10_000,
};

// ---------------------------------------------------------------------------
// Error enums (Interfaces 2 & 3)
// ---------------------------------------------------------------------------

/**
 * Failure modes from Reqs 1–5 returned by the Local_Fetcher_Agent
 * `POST /local/fetch`. The three link/path violation types are kept distinct
 * (Reqs 4.2–4.5). String-valued so the enum serializes cleanly across HTTP.
 */
export enum FetchErrorType {
  INVALID_PACKAGE_NAME = "INVALID_PACKAGE_NAME",
  PACKAGE_UNRESOLVED = "PACKAGE_UNRESOLVED",
  VERSION_UNRESOLVED = "VERSION_UNRESOLVED",
  REGISTRY_UNAVAILABLE = "REGISTRY_UNAVAILABLE",
  DOWNLOAD_FAILED = "DOWNLOAD_FAILED",
  DOWNLOAD_TOO_LARGE = "DOWNLOAD_TOO_LARGE",
  PATH_TRAVERSAL = "PATH_TRAVERSAL",
  ABSOLUTE_PATH = "ABSOLUTE_PATH",
  LINK_TARGET_ESCAPE = "LINK_TARGET_ESCAPE",
  RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED",
  EXTRACTION_TIMEOUT = "EXTRACTION_TIMEOUT",
  VSCODE_UNAVAILABLE = "VSCODE_UNAVAILABLE",
  VSCODE_LAUNCH_FAILED = "VSCODE_LAUNCH_FAILED",
}

/**
 * Failure modes returned by the upload-trigger interface
 * `POST /local/upload` (Reqs 6.3–6.6, 13.6). String-valued for clean HTTP
 * serialization.
 */
export enum UploadErrorType {
  REPORT_MISSING = "REPORT_MISSING",
  INVALID_IDENTIFIER = "INVALID_IDENTIFIER",
  UPLOAD_FAILED = "UPLOAD_FAILED",
  INVALID_RISK_SCORE = "INVALID_RISK_SCORE",
}
